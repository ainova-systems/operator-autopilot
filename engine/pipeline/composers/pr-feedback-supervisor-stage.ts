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
import { formatDebugRunLinkSuffix } from "../../delivery/vcs-helpers.js";
import type { StateContextVars } from "../../work-items/work-items.js";
import type { StageDef, StageInput, AgentResult, Verdict } from "../types.js";
import type { WorkspaceHandle } from "../primitives/workspace-scope.js";
import type { PrFeedbackPayload } from "../primitives/pr-feedback-selector.js";
import { writeChecksContextFile } from "../primitives/checks-context.js";
import type { BotAttribution } from "../../delivery/bot-footer.js";
import { applyAgentEvents } from "../primitives/aop-applier.js";
import { createScratchStore } from "./_shared/scratch.js";
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

interface PrFeedbackSupervisorScratch {
  readonly prId: number;
  readonly branch: string;
  readonly prType: string;
  readonly reviewAttempts: number;
  readonly maxAttempts: number;
  readonly limitReached: boolean;
  readonly threadFile: string;
  readonly newFeedback: string;
  checksContextFile: string;
  /**
   * HEAD SHA captured at beforeAgent (post workspace checkout). Used in
   * afterAgent to detect whether the supervisor agent committed during
   * the run. `git.isClean()` alone returned `true` after a successful
   * commit, leading the engine to misreport "No code changes" when the
   * agent had in fact committed and pushed — the 2026-05-20 PR-887
   * regression. Empty string when capture failed (best-effort; the
   * afterAgent comparison treats empty as "unknown, fall back to dirty
   * check").
   */
  preAgentHeadSha: string;
}

const prFeedbackSupervisorScratch = createScratchStore<PrFeedbackSupervisorScratch>();
const prKey = (prId: number): string => String(prId);

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

function inferKindFromBranch(branch: string, registry: KindRegistry): { kind: string; id: string } | null {
  for (const kindDef of registry.all) {
    const prefix = kindDef.branchPrefix.endsWith("/") ? kindDef.branchPrefix : `${kindDef.branchPrefix}/`;
    if (branch.startsWith(prefix)) {
      const id = branch.slice(prefix.length);
      if (id) return { kind: kindDef.name, id };
    }
  }
  return null;
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

    prFeedbackSupervisorScratch.set(ctx, prKey(payload.prId), {
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
    const scratch = prFeedbackSupervisorScratch.get(ctx, prKey(payload.prId));
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
    const scratch = prFeedbackSupervisorScratch.get(ctx, prKey(payload.prId));
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
    prFeedbackSupervisorScratch.clear(ctx, prKey(payload.prId));
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
    const scratch = prFeedbackSupervisorScratch.get(ctx, prKey(payload.prId));
    if (!scratch) {
      throw new StageLogicError(
        "STAGE_SCRATCH_MISSING",
        `${stage.name} afterAgent: missing scratch for PR #${payload.prId} — beforeAgent not run`,
      );
    }
    try {
      const suffix = formatDebugRunLinkSuffix(deps.debug, deps.debugRunUrl);
      const ciFailing = payload.checks.value === "failing";
      const nextAttribution: BotAttribution = {
        responded: new Set(payload.respondedIds),
        ciHead: payload.checks.headSha,
        ciAttempt: ciFailing
          ? { current: payload.ciAttempts + 1, max: payload.maxCiRetryAttempts }
          : undefined,
      };

      if (scratch.limitReached) {
        const msg = `⚠️ **Review cycle limit reached** — This PR has gone through ${scratch.reviewAttempts} review-fix cycles (limit: ${scratch.maxAttempts}). The supervisor was unable to resolve all feedback within the allowed iterations. Marking as failed — manual intervention required.${suffix}`;
        await deps.prManager.postBotComment(payload.prId, msg, nextAttribution);
        deps.log?.info(`${stage.name}: PR #${payload.prId} limit reached — verdict override failed`, {
          stage: stage.name, prNumber: payload.prId,
          reviewAttempts: scratch.reviewAttempts, maxAttempts: scratch.maxAttempts,
        });
        return {
          verdictOverride: "failed",
          summaryOverride: `review cycle limit reached (${scratch.reviewAttempts}/${scratch.maxAttempts})`,
        };
      }

      // 2026-05-13: removed defense-in-depth "approved + ciFailing →
      // override to failed" check. The verifier (inside the agent chain
      // when stage has reviewEnabled: true) is the authority on whether
      // the supervisor's fix addresses CI. Defense-in-depth duplicated
      // verifier and second-guessed it from a stale CI observation —
      // CI was observed at cycle start (BEFORE supervisor committed via
      // Bash) so it always looked "failing" even when the fix had just
      // been pushed and CI re-run hadn't completed yet. The canonical
      // case: supervisor correctly fixed all 47 backend test failures
      // and 14 Copilot comments and
      // committed/pushed, but the post-verifier check flipped to failed
      // because checks.headSha was the pre-commit SHA. Per user guidance:
      // "verify process should be able to detect commits and verify them
      // even if committed — if OK act as usual; if wrong comment back to
      // redo/fix. Committed work has no difference except technical to
      // detect changes." Trust verifier — if its judgment is wrong, the
      // next pr-feedback cycle picks the PR up with fresh CI data.

      const activeItem = inferKindFromBranch(payload.branch, deps.kindRegistry);
      const applied = await applyAgentEvents(
        agentResult.output,
        {
          stream: deps.agentEventStream,
          source: deps.workItemSource,
          registry: deps.kindRegistry,
          log: deps.log,
        },
        {
          workItem: activeItem ? { id: activeItem.id, kind: activeItem.kind } : undefined,
        },
        ctx,
      );
      deps.log?.info(`${stage.name}: PR #${payload.prId} applied ${applied.applied.childItems.length} child-item(s), ${applied.applied.statusUpdates.length} status-update(s); applier verdict=${applied.verdict}`, {
        stage: stage.name, prNumber: payload.prId,
        applierVerdict: applied.verdict,
        childItems: applied.applied.childItems.length,
        statusUpdates: applied.applied.statusUpdates.length,
        bodyUpdates: applied.applied.bodyUpdates.length,
        applyErrors: applied.applyErrors.length,
      });

      if (applied.verdict !== "approved" || applied.applyErrors.length > 0) {
        const reason = applied.summary || agentResult.summary || "supervisor decision";
        const detail = applied.applyErrors.length > 0
          ? `\n\nApply errors: ${applied.applyErrors.map((e) => `${e.code}: ${e.message}`).join("; ")}`
          : "";
        await deps.prManager.postBotComment(
          payload.prId,
          `Supervisor decision: ${reason}.${detail}${suffix}`,
          nextAttribution,
        );
        deps.log?.info(`${stage.name}: PR #${payload.prId} verdict=${applied.verdict} — posted terminal comment`, {
          stage: stage.name, prNumber: payload.prId,
          verdict: applied.verdict, reason,
        });
        return {
          verdictOverride: applied.verdict,
          summaryOverride: applied.summary,
        };
      }

      // "Changes applied" detection — true when EITHER the workspace
      // has uncommitted edits OR the agent advanced HEAD by committing
      // directly via Bash. Pre-2026-05-20 the check only inspected the
      // dirty flag; a post-commit clean tree was reported as "No code
      // changes" even though the agent had committed (PR-887). The
      // headSha comparison catches that path — falls back to the dirty
      // check when the pre-agent SHA was not captured.
      const workspaceDirty = !(await deps.git.isClean());
      let postAgentHeadSha = "";
      try {
        postAgentHeadSha = (await deps.git.headSha()).trim();
      } catch (err) {
        deps.log?.warn(`${stage.name}: failed to capture post-agent HEAD SHA (falling back to dirty-only check)`, {
          stage: stage.name, prNumber: payload.prId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      const headAdvanced = scratch.preAgentHeadSha.length > 0
        && postAgentHeadSha.length > 0
        && scratch.preAgentHeadSha !== postAgentHeadSha;
      const changesApplied = workspaceDirty || headAdvanced;

      if (changesApplied) {
        await deps.prManager.postBotComment(
          payload.prId,
          `Applied review feedback.${suffix}`,
          nextAttribution,
        );
        deps.log?.info(`${stage.name}: PR #${payload.prId} fix-in-place with changes — posted applied comment`, {
          stage: stage.name, prNumber: payload.prId,
          changesApplied: true, workspaceDirty, headAdvanced,
          preAgentHeadSha: scratch.preAgentHeadSha.slice(0, 12),
          postAgentHeadSha: postAgentHeadSha.slice(0, 12),
        });
      } else {
        // The engine asserts ONLY the fact it can observe (clean tree +
        // unchanged HEAD ⇒ no code changes this cycle). It must NOT
        // editorialize the REASON: a verdict=approved + no-changes run can
        // mean "feedback genuinely already addressed" OR "supervisor chose
        // escalate" (supervisor.md maps escalate → approved + no changes).
        // The old hard-coded "considered the feedback already addressed"
        // contradicted the agent's own reasoning on escalate cycles
        // (PR #892, 2026-05-21). The WHY lives in the agent's
        // reasoning block below — never in a fixed engine sentence.
        const reasoning = (agentResult.summary ?? "").trim().slice(0, 1500);
        const reasoningBlock = reasoning ? `\n\n${reasoning}` : "";
        await deps.prManager.postBotComment(
          payload.prId,
          `No code changes in this cycle.${reasoningBlock}\n\nReply on this PR if you disagree and I'll re-evaluate.${suffix}`,
          nextAttribution,
        );
        deps.log?.info(`${stage.name}: PR #${payload.prId} fix-in-place no changes — posted no-changes comment, leaving at ai:in-review`, {
          stage: stage.name, prNumber: payload.prId, changesApplied: false,
        });
      }
      return;
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

export function buildSupervisorTask(
  prType: string,
  branch: string,
  newFeedback: string,
  threadFile: string,
  checksContextFile?: string,
): string {
  const sections = [
    "Review the PR event and decide the right action via AOP EMIT records.",
    "",
    "## PR Context",
    "",
    `- **PR Type**: ${prType}`,
    `- **Branch**: ${branch}`,
    "",
    "## Decision Vocabulary",
    "",
    "Choose ONE outcome and emit the matching EMIT records (see supervisor.md for full spec):",
    "",
    "- **fix-in-place** — actionable feedback, you edit files + commit, end with `EMIT verdict value: approved`",
    "- **cancel** — user said /cancel or scope dead → `EMIT status-update target: self status: cancelled` + `EMIT verdict value: cancelled`",
    "- **duplicate** — user said /duplicate <id> → `EMIT status-update target: self status: duplicate` + `EMIT verdict value: rejected`",
    "- **retry-as-new** — user clarified new scope → `EMIT child-item kind: task parent: self` + `EMIT status-update target: self status: rejected` + `EMIT verdict value: rejected`",
    "- **escalate** — ambiguous/contradictory comments → `EMIT verdict value: approved` (no code changes, no status update)",
    "",
    "## Rules",
    "",
    "- NEVER write `---\\nstatus:` frontmatter directly — emit EMIT status-update instead",
    "- NEVER commit if you chose cancel/duplicate/retry-as-new/escalate",
    "- NEVER return verdict: approved if CI is failing without committing the fix",
    "- For research PRs, only update findings/tasks files; for retrospective PRs, only `.operator/data/retrospectives/`",
  ];
  if (checksContextFile) {
    sections.push(
      "",
      "## CI Pipeline Context",
      "",
      `Detailed CI status (failing checks, annotations, log URLs) is in \`${checksContextFile}\`.`,
      "Read this file with the Read tool BEFORE deciding on a fix when CI failures are referenced below.",
      "Do NOT declare \"no changes needed\" on a failing PR without inspecting the failure details.",
    );
  }
  if (threadFile) {
    sections.push(
      "",
      "## Discussion History",
      "",
      `Full PR conversation thread is available in \`${threadFile}\`.`,
      "Read it if a new comment references earlier discussion or you need context.",
      "Do NOT re-address old comments that were already handled (those marked responded in the bot footer).",
    );
  }
  sections.push(
    "",
    "## NEW Comments to Address",
    "",
    "These are the comments you MUST classify in this cycle:",
    "",
    newFeedback,
    "",
    "## Output",
    "",
    "End your output with AOP EMIT blocks. The orchestrator parses them. Anything outside EMIT blocks is captured as freeform analysis for the execution log.",
  );
  return sections.join("\n");
}
