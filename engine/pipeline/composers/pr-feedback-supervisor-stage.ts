import { writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type {
  OperationContext, DefaultsConfig, PromptSource,
  KindRegistry, WorkItemSource, AgentEventStream, AgentRoleName,
} from "@operator/core";
import { errorMessage } from "@operator/core";
import type { AgentRunInput } from "../../agents/runtime.js";
import type { AgentsFile } from "../../config/schemas.js";
import type { PRManager } from "../../delivery/pr-manager.js";
import type { WorkspaceGit } from "../../infra/git.js";
import type { Logger } from "../../logging/logger.js";
import { resolveRole, buildRunInput } from "../../agents/roles.js";
import type { StateContextVars } from "../../work-items/work-items.js";
import type { StageDef, StageInput, AgentResult, Verdict } from "../types.js";
import type { WorkspaceHandle } from "../primitives/workspace-scope.js";
import type { PrFeedbackPayload } from "../primitives/pr-feedback-selector.js";
import { writeChecksContextFile } from "../primitives/checks-context.js";
import { buildSupervisorTask } from "./_shared/supervisor-task.js";
import { processSupervisorAfterAgent } from "./_shared/supervisor-after-agent.js";
import {
  prFeedbackSupervisorScratch,
  prFeedbackSupervisorScratchKey,
} from "./_shared/supervisor-scratch.js";
import { StageLogicError } from "./errors.js";

/**
 * Generic stage composer for the "PR feedback supervisor" pattern.
 *
 * Pattern shape (kind-agnostic, stage-name-agnostic):
 *
 *   1. `pr-feedback` selector picks an open AI PR with unread feedback.
 *   2. `WorkspaceScope.prepare` checks out the PR branch.
 *   3. `beforeAgent` enforces the attempt cap, transitions PR label
 *      ai:pending → ai:processing, writes the discussion-thread temp file.
 *   4. `buildRunInput` constructs the configured supervisor-role agent
 *      input (full thread + fresh feedback + CI context).
 *   5. `runStage` invokes the supervisor agent + the configured verifier.
 *   6. `afterAgent` routes the supervisor's stdout through
 *      `applyAgentEvents`: EMIT child-item → source.create (retry-as-new
 *      path), EMIT status-update → source.updateStatus (cancel/duplicate),
 *      EMIT verdict → resolves the stage verdict.
 *
 * Frontmatter ownership: the supervisor agent NEVER writes frontmatter
 * directly. The F3.5 parser guard rejects raw `---` frontmatter outside
 * EMIT blocks. `applyAgentEvents` is the only path that updates
 * `.operator/data/*.md` frontmatter — and it goes through
 * `FileBackedWorkItemSource.updateStatus`.
 *
 * The composer is consumed by any stage whose pattern is "supervisor
 * LLM router over PR events with AOP-driven decisions". A
 * `pr-review` stage handling feedback on AI-authored PRs is the
 * canonical example.
 */

export interface PrFeedbackSupervisorHookDeps {
  readonly prManager: PRManager;
  readonly git: WorkspaceGit;
  readonly agentsConfig: AgentsFile;
  readonly promptSource: PromptSource;
  readonly defaults: DefaultsConfig;
  readonly automationDir: string;
  readonly workspacePath: string;
  readonly kindRegistry: KindRegistry;
  readonly workItemSource: WorkItemSource;
  readonly agentEventStream: AgentEventStream;
  readonly stateVars?: StateContextVars;
  readonly log?: Logger;
  readonly debug?: boolean;
  readonly debugRunUrl?: string;

  // ── Stage-shape parameters ────────────────────────────────────────
  /** Supervisor agent role (e.g. `"supervisor"`). */
  readonly agentRole: AgentRoleName;
  /** Verifier chain topic suffix, used as `verifier/{verifierTopic}`. */
  readonly verifierTopic: string;
}

function payloadOf(stageName: string, input: StageInput): PrFeedbackPayload {
  const data = input.data as PrFeedbackPayload | undefined;
  if (!data || typeof data.prId !== "number") {
    throw new StageLogicError(
      "INVALID_STAGE_INPUT",
      `${stageName} hook: stage input missing PrFeedbackPayload (scopeKey: ${input.scopeKey})`,
    );
  }
  return data;
}

async function computeReviewAttempts(
  git: WorkspaceGit,
  baseBranch: string,
  prType: string,
  stageName: string,
  log: Logger | undefined,
): Promise<number> {
  try {
    const total = await git.commitCount(baseBranch);
    const initial = prType === "task" ? 2 : 1;
    return Math.max(0, total - initial);
  } catch (err) {
    log?.warn(`${stageName}: commitCount failed (defaulting attempts to 0)`, {
      stage: stageName, baseBranch, prType,
      error: err instanceof Error ? err.message : String(err),
    });
    return 0;
  }
}

export function buildPrFeedbackSupervisorBeforeAgent(deps: PrFeedbackSupervisorHookDeps) {
  return async (
    stage: StageDef,
    input: StageInput,
    workspace: WorkspaceHandle,
    ctx: OperationContext,
  ): Promise<{ processingPRs?: readonly number[] } | void> => {
    const payload = payloadOf(stage.name, input);
    const reviewAttempts = await computeReviewAttempts(deps.git, workspace.baseBranch, payload.prType, stage.name, deps.log);
    const maxAttempts = deps.defaults.limits.maxReviewAttempts;
    const limitReached = reviewAttempts >= maxAttempts;

    deps.log?.info(`${stage.name}: PR #${payload.prId} (${payload.prType}) attempts ${reviewAttempts}/${maxAttempts}`, {
      stage: stage.name, prNumber: payload.prId, prType: payload.prType,
      reviewAttempts, maxAttempts, limitReached,
    });

    let threadFile = "";
    if (!limitReached) {
      await deps.prManager.markProcessing(payload.prId);
      deps.log?.info(`${stage.name}: PR #${payload.prId} label ai:pending → ai:processing`, {
        stage: stage.name, prNumber: payload.prId,
      });

      if (payload.fullThread) {
        threadFile = join(
          tmpdir(),
          `operator-pr-thread-${payload.prId}-${Date.now()}-${Math.random().toString(36).slice(2)}.md`,
        );
        await writeFile(threadFile, `# PR #${payload.prId} Discussion Thread\n\n${payload.fullThread}\n`, "utf-8");
      }
    }

    // Capture HEAD SHA AFTER the workspace handle has resolved (branch
    // checked out, base PR head pulled) so afterAgent can detect commits
    // the agent itself made via Bash. Without this anchor a clean post-
    // commit workspace looked identical to a no-op run, triggering the
    // wrong "No code changes" comment.
    let preAgentHeadSha = "";
    try {
      preAgentHeadSha = (await deps.git.headSha()).trim();
    } catch (err) {
      deps.log?.warn(`${stage.name}: failed to capture pre-agent HEAD SHA (non-fatal)`, {
        stage: stage.name, prNumber: payload.prId,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    prFeedbackSupervisorScratch.set(ctx, prFeedbackSupervisorScratchKey(payload.prId), {
      prId: payload.prId, branch: payload.branch, prType: payload.prType,
      reviewAttempts, maxAttempts, limitReached, threadFile,
      newFeedback: payload.newFeedback,
      checksContextFile: "",
      preAgentHeadSha,
    });

    if (limitReached) return;
    return { processingPRs: [payload.prId] };
  };
}

/**
 * Short-circuit the supervisor agent when the review-cycle cap has already
 * been reached. `beforeAgent` computes `limitReached` (and, when true, skips
 * the ai:processing transition + thread-file write); this hook then bypasses
 * the agent invocation entirely so the engine never spends a full supervisor
 * run — a ~10-minute Opus call — only for `afterAgent` to discard the result
 * (PR #898, 2026-06-04, burnt 631s of Opus before the verdict was
 * overridden to failed). `afterAgent` still posts the limit-reached comment
 * and overrides the verdict to `failed`; this just feeds it a placeholder
 * result instead of one the agent was paid to produce.
 *
 * Returns `null` on the normal path (cap not reached) so `runStage` falls
 * through to `buildRunInput` + the real agent invocation.
 */
export function buildPrFeedbackSupervisorSynthesizeAgentResult(deps: PrFeedbackSupervisorHookDeps) {
  return async (
    stage: StageDef,
    input: StageInput,
    _workspace: WorkspaceHandle,
    ctx: OperationContext,
  ): Promise<AgentResult | null> => {
    const payload = payloadOf(stage.name, input);
    const scratch = prFeedbackSupervisorScratch.get(ctx, prFeedbackSupervisorScratchKey(payload.prId));
    if (!scratch?.limitReached) return null;
    deps.log?.info(`${stage.name}: PR #${payload.prId} review cycle cap reached (${scratch.reviewAttempts}/${scratch.maxAttempts}) — skipping supervisor agent`, {
      stage: stage.name, prNumber: payload.prId,
      reviewAttempts: scratch.reviewAttempts, maxAttempts: scratch.maxAttempts,
    });
    return {
      verdict: "failed",
      output: "",
      attempts: 0,
      summary: `review cycle limit reached (${scratch.reviewAttempts}/${scratch.maxAttempts})`,
    };
  };
}

export function buildPrFeedbackSupervisorBuildRunInput(deps: PrFeedbackSupervisorHookDeps) {
  return async (
    stage: StageDef,
    input: StageInput,
    ctx: OperationContext,
  ): Promise<AgentRunInput> => {
    const payload = payloadOf(stage.name, input);
    const scratch = prFeedbackSupervisorScratch.get(ctx, prFeedbackSupervisorScratchKey(payload.prId));
    if (!scratch) {
      throw new StageLogicError(
        "STAGE_SCRATCH_MISSING",
        `${stage.name} buildRunInput: missing scratch for PR #${payload.prId} — beforeAgent not run`,
      );
    }
    const role = resolveRole(deps.agentsConfig, deps.agentRole);
    const reviewCriteria = role.review
      ? await deps.promptSource.loadChain(`verifier/${deps.verifierTopic}`)
      : undefined;

    if (payload.checks.value === "failing" || payload.checks.value === "pending") {
      try {
        scratch.checksContextFile = await writeChecksContextFile({
          observation: payload.checks,
          prNumber: payload.prId,
          branch: payload.branch,
        });
      } catch (err) {
        deps.log?.warn(`${stage.name}: writeChecksContextFile failed (non-fatal)`, {
          stage: stage.name, prNumber: payload.prId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    const taskContent = buildSupervisorTask(
      payload.prType, payload.branch, scratch.newFeedback,
      scratch.threadFile, scratch.checksContextFile || undefined,
    );
    return buildRunInput(
      role,
      {
        promptSource: deps.promptSource,
        automationDir: deps.automationDir,
        vars: { PR_NUMBER: String(payload.prId), PR_TYPE: payload.prType, ...deps.stateVars },
      },
      {
        taskContent,
        cwd: deps.workspacePath,
        maxRetries: 1,
        reviewCriteria,
      },
    );
  };
}

export function buildPrFeedbackSupervisorBuildPR(_deps: PrFeedbackSupervisorHookDeps) {
  return async (
    stage: StageDef,
    input: StageInput,
    ctx: OperationContext,
  ): Promise<{ title: string; body: string; commitMessage: string; onSuccess?: "in-review" | "ready-to-merge" | "none" }> => {
    const payload = payloadOf(stage.name, input);
    prFeedbackSupervisorScratch.clear(ctx, prFeedbackSupervisorScratchKey(payload.prId));
    return {
      title: `PR #${payload.prId} supervisor decision`,
      body: `Applied supervisor decision on PR #${payload.prId}.`,
      commitMessage: `Applied supervisor decision on PR #${payload.prId}`,
      onSuccess: "in-review",
    };
  };
}

export function buildPrFeedbackSupervisorAfterAgent(deps: PrFeedbackSupervisorHookDeps) {
  return async (
    stage: StageDef,
    input: StageInput,
    agentResult: AgentResult,
    _workspace: WorkspaceHandle,
    ctx: OperationContext,
  ): Promise<{ verdictOverride?: Verdict; summaryOverride?: string } | void> => {
    const payload = payloadOf(stage.name, input);
    const scratch = prFeedbackSupervisorScratch.get(ctx, prFeedbackSupervisorScratchKey(payload.prId));
    if (!scratch) {
      throw new StageLogicError(
        "STAGE_SCRATCH_MISSING",
        `${stage.name} afterAgent: missing scratch for PR #${payload.prId} — beforeAgent not run`,
      );
    }
    try {
      return await processSupervisorAfterAgent(deps, stage, payload, scratch, agentResult, ctx);
    } catch (err) {
      deps.log?.error(`${stage.name}: afterAgent failed for PR #${payload.prId}`, {
        stage: stage.name, prNumber: payload.prId, error: errorMessage(err),
      });
      throw err;
    } finally {
      if (scratch.threadFile) {
        await unlink(scratch.threadFile).catch(() => { /* best-effort cleanup */ });
      }
    }
  };
}
