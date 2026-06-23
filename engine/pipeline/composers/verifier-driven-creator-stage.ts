import { join } from "node:path";
import type {
  OperationContext, StateManager, VCSPlatform, WorkItemKind, AgentRoleName,
} from "@operator/core";
import { errorMessage } from "@operator/core";
import type { AgentRunInput } from "../../agents/runtime.js";
import type { AgentsFile } from "../../config/schemas.js";
import type { PromptSource } from "@operator/core";
import type { PRManager } from "../../delivery/pr-manager.js";
import type { WorkspaceGit } from "../../infra/git.js";
import type { Logger } from "../../logging/logger.js";
import { resolveRole, buildRunInput } from "../../agents/roles.js";
import { findCodeReviewForBranch, formatDebugRunLinkSuffix } from "../../delivery/vcs-helpers.js";
import {
  readWorkItemFile, updateWorkItemFileStatus, updateStatusAndSync,
  type StateContextVars, type WorkItemFileData,
} from "../../work-items/work-items.js";
import type { StageDef, StageInput, AgentResult, Verdict } from "../types.js";
import type { WorkspaceHandle } from "../primitives/workspace-scope.js";
import { writeFailureReason, clearFailureFields } from "../primitives/failure-reason-writer.js";
import { createScratchStore } from "./_shared/scratch.js";
import { summarizeMarkdownForPr } from "./_shared/pr-summary.js";
import { StageLogicError } from "./errors.js";

/**
 * Generic stage composer for the "verifier-driven creator" pattern.
 *
 * Pattern shape (kind-agnostic, stage-name-agnostic):
 *
 *  1. `per-item` selector picks a pending work-item of the configured kind.
 *  2. `WorkspaceScope.prepare` creates or reuses the per-item branch
 *     `{branchPrefix}/{id}`.
 *  3. `beforeAgent`: recover from `failed` (reset to `pending` + clear
 *     failure fields), transition PR label `pending → processing`.
 *  4. `buildRunInput` / `buildPR`: construct the configured creator-role
 *     agent input plus the in-progress PR template.
 *  5. `runStage` invokes the agent (which produces code, not work-items).
 *  6. `afterAgent`: map terminal verdict → work-item status, write
 *     `failure_reason` frontmatter, post PR comment with debug-run link.
 *  7. `persistOutput` commits code + status, pushes, updates PR label.
 *
 * **No AOP applier consumption** — the agent produces CODE (not child
 * work-items), and the verifier's `## Verdict:` (or `EMIT verdict`)
 * drives the disposition. The only orchestrator-owned writes are the
 * status transition (`updateStatusAndSync`) and the `failure_reason`
 * frontmatter side-channel (via the failure-reason-writer primitive).
 *
 * The composer is consumed by any stage whose `agent` produces code
 * for review — a `task-execute` stage (kind=task, agent=creator) that
 * implements a planned task is the canonical example, but any future
 * repo can compose this same pattern by passing its own kind, branch
 * prefix, PR prefix, verifier topic, and display name through
 * {@link VerifierDrivenCreatorHookDeps}.
 */

interface VerifierDrivenCreatorScratch {
  readonly itemId: string;
  readonly filePath: string;
  readonly item: WorkItemFileData;
  readonly codeReviewId: number | null;
}

const verifierDrivenCreatorScratch = createScratchStore<VerifierDrivenCreatorScratch>();

/**
 * Configuration + dependencies for the verifier-driven-creator composer.
 *
 * Stage-shape parameters (the "this is what makes the composer
 * generic" part) are the four config fields at the bottom: `kind`,
 * `agentRole`, `verifierTopic`, `branchPrefix`, `prPrefix`, `prTemplate`,
 * `displayName`. Repo-level infrastructure (VCS, state, PR manager,
 * git, etc.) flows in unchanged via the upper deps fields.
 */
export interface VerifierDrivenCreatorHookDeps {
  readonly state: StateManager;
  readonly vcs: VCSPlatform;
  readonly prManager: PRManager;
  readonly git: WorkspaceGit;
  /** Per-kind storage directory (e.g. `.operator/data/tasks`). */
  readonly dataDir: string;
  readonly automationDir: string;
  readonly workspacePath: string;
  readonly templatesDir: string;
  readonly agentsConfig: AgentsFile;
  readonly promptSource: PromptSource;
  readonly stateVars?: StateContextVars;
  readonly verifyCommand?: string;
  readonly log?: Logger;
  readonly debug?: boolean;
  readonly debugRunUrl?: string;
  /** Optional KVStore for execution-history enrichment. */
  readonly kv?: import("@operator/core").KVStore;

  // ── Stage-shape parameters ────────────────────────────────────────
  /** Work-item kind the stage operates on (e.g. `"task"`). */
  readonly kind: WorkItemKind;
  /** Agent role name resolved from `agentsConfig` (e.g. `"creator"`). */
  readonly agentRole: AgentRoleName;
  /** Verifier chain topic suffix, used as `verifier/{verifierTopic}`. */
  readonly verifierTopic: string;
  /** Branch prefix without trailing slash (e.g. `"ai/tasks"`). */
  readonly branchPrefix: string;
  /** PR title prefix (e.g. `"[AI:Task]"`). */
  readonly prPrefix: string;
  /** In-progress PR body template filename in `templatesDir`. */
  readonly prTemplate: string;
  /** Human-facing display name used in PR comments (e.g. `"Task"`). */
  readonly displayName: string;
}

export function buildVerifierDrivenCreatorBeforeAgent(deps: VerifierDrivenCreatorHookDeps) {
  return async (
    stage: StageDef,
    input: StageInput,
    _workspace: WorkspaceHandle,
    ctx: OperationContext,
  ): Promise<{ processingPRs?: readonly number[] } | void> => {
    const itemId = input.scopeKey;
    const filePath = join(deps.dataDir, `${itemId}.md`);
    const item = await readWorkItemFile(filePath);
    deps.log?.debug(`${stage.name}: loaded ${itemId}`, {
      stage: stage.name, itemId, status: item.status,
    });

    if (item.status === "failed") {
      deps.log?.info(`${stage.name}: resetting failed ${deps.kind} ${itemId} to pending for retry`, {
        stage: stage.name, itemId, previousStatus: "failed",
      });
      await updateWorkItemFileStatus(filePath, "pending");
      await clearFailureFields(filePath);
    }

    const branch = `${deps.branchPrefix}/${itemId}`;
    const codeReviewId = await findCodeReviewForBranch(deps.vcs, branch);
    if (codeReviewId) {
      await deps.prManager.markProcessing(codeReviewId);
      deps.log?.info(`${stage.name}: PR #${codeReviewId} label ai:pending → ai:processing`, {
        stage: stage.name, itemId, prNumber: codeReviewId,
      });
    }

    verifierDrivenCreatorScratch.set(ctx, itemId, { itemId, filePath, item, codeReviewId });

    if (codeReviewId) {
      return { processingPRs: [codeReviewId] };
    }
  };
}

export function buildVerifierDrivenCreatorBuildRunInput(deps: VerifierDrivenCreatorHookDeps) {
  return async (
    _stage: StageDef,
    input: StageInput,
    _ctx: OperationContext,
  ): Promise<AgentRunInput> => {
    const itemId = input.scopeKey;
    const filePath = join(deps.dataDir, `${itemId}.md`);
    const item = await readWorkItemFile(filePath);
    const itemPath = item.path ?? undefined;
    const role = resolveRole(deps.agentsConfig, deps.agentRole);
    const reviewCriteria = (role.review ?? true)
      ? await deps.promptSource.loadChain(`verifier/${deps.verifierTopic}`)
      : undefined;

    const { buildExecutionHistoryBlock } = await import("../primitives/execution-context.js");
    const historyBlock = await buildExecutionHistoryBlock(deps.kv, itemId);
    const itemContent = historyBlock
      ? `${historyBlock}\n${item.body}`
      : item.body;

    return buildRunInput(
      role,
      {
        promptSource: deps.promptSource,
        automationDir: deps.automationDir,
        vars: { TASK_ID: itemId, ITEM_ID: itemId, ...deps.stateVars },
        rulesFrom: itemPath ? deps.agentRole : undefined,
        contextPath: itemPath,
      },
      {
        taskContent: itemContent,
        cwd: deps.workspacePath,
        maxRetries: 3,
        verifyCommand: deps.verifyCommand,
        reviewCriteria,
      },
    );
  };
}

export function buildVerifierDrivenCreatorBuildPR(deps: VerifierDrivenCreatorHookDeps) {
  return async (
    _stage: StageDef,
    input: StageInput,
    _ctx: OperationContext,
  ): Promise<{ title: string; body: string; commitMessage: string; onSuccess?: "in-review" | "ready-to-merge" | "none" }> => {
    const itemId = input.scopeKey;
    const filePath = join(deps.dataDir, `${itemId}.md`);
    const item = await readWorkItemFile(filePath);

    const title = `${deps.prPrefix} ${itemId}: ${item.title}`;
    // PR body must carry a useful task summary inline — historic template
    // shipped only an ID + "see file" pointer which forced reviewers to
    // open the task .md to know what was being done. Now the title,
    // parent-finding linkage, priority, and the body land in the PR
    // description directly. The body is itself markdown, so its headings are
    // demoted (and the duplicate leading H1 dropped) to nest under the
    // template's `### Summary` rather than outranking it.
    const SUMMARY_MAX = 1200;
    const summary = summarizeMarkdownForPr(item.body, SUMMARY_MAX);
    const body = await deps.prManager
      .loadTemplate(deps.templatesDir, deps.prTemplate, {
        TASK_ID: itemId,
        ITEM_ID: itemId,
        TITLE: item.title,
        PRIORITY: String(item.priority),
        PARENT: item.parentId ?? "—",
        SUMMARY: summary,
      })
      .catch(() => `**${deps.displayName}**: ${itemId} — ${item.title}\n\n${summary}`);
    return {
      title,
      body,
      commitMessage: `Completed ${deps.displayName.toLowerCase()}: ${itemId}`,
      onSuccess: "in-review",
    };
  };
}

export function buildVerifierDrivenCreatorAfterAgent(deps: VerifierDrivenCreatorHookDeps) {
  return async (
    stage: StageDef,
    input: StageInput,
    agentResult: AgentResult,
    _workspace: WorkspaceHandle,
    ctx: OperationContext,
  ): Promise<{ verdictOverride?: Verdict; summaryOverride?: string } | void> => {
    const itemId = input.scopeKey;
    const scratch = verifierDrivenCreatorScratch.get(ctx, itemId);
    if (!scratch) {
      throw new StageLogicError(
        "STAGE_SCRATCH_MISSING",
        `${stage.name} afterAgent: missing scratch for ${itemId} — beforeAgent not run`,
      );
    }
    try {
      if (agentResult.verdict === "approved") {
        await updateStatusAndSync(scratch.filePath, "completed", deps.state, ctx);
        if (scratch.codeReviewId) {
          await deps.prManager.postBotComment(
            scratch.codeReviewId,
            `${deps.displayName} **${itemId}** completed successfully.`,
          );
        }
        return;
      }

      const disposition: "failed" | "cancelled" | "rejected" = agentResult.verdict === "cancelled"
        ? "cancelled"
        : agentResult.verdict === "rejected" ? "rejected" : "failed";
      const reason = agentResult.summary || dispositionDefaultReason(deps.displayName, disposition);
      await updateStatusAndSync(scratch.filePath, disposition, deps.state, ctx);

      await writeFailureReason(scratch.filePath, reason, deps.log);

      if (scratch.codeReviewId) {
        const suffix = formatDebugRunLinkSuffix(deps.debug, deps.debugRunUrl);
        const body = buildTerminalComment(deps.displayName, itemId, disposition, reason) + suffix;
        await deps.prManager.postBotComment(scratch.codeReviewId, body);
      }

      deps.log?.info(`${stage.name}: ${itemId} → ${disposition} (${reason})`, {
        stage: stage.name, itemId, disposition, reason,
      });

      return {};
    } catch (err) {
      deps.log?.error(`${stage.name}: afterAgent failed for ${itemId}`, {
        stage: stage.name, itemId, error: errorMessage(err),
      });
      throw err;
    } finally {
      verifierDrivenCreatorScratch.clear(ctx, itemId);
    }
  };
}

function dispositionDefaultReason(displayName: string, disposition: "failed" | "cancelled" | "rejected"): string {
  switch (disposition) {
    case "failed": return `${displayName} execution failed`;
    case "cancelled": return `${displayName} cancelled by verifier`;
    case "rejected": return `${displayName} scope rejected by verifier`;
  }
}

function buildTerminalComment(displayName: string, itemId: string, disposition: "failed" | "cancelled" | "rejected", reason: string): string {
  const detail = reason ? `: ${reason}` : "";
  switch (disposition) {
    case "failed":
      return `${displayName} **${itemId}** failed${detail}. Review the changes and close with comment to cancel, or remove the failed label to retry.`;
    case "cancelled":
      return `${displayName} **${itemId}** cancelled${detail}. Closing PR — no retry will be attempted.`;
    case "rejected":
      return `${displayName} **${itemId}** rejected${detail}. Closing PR — the retrospective will regenerate a replacement task with updated scope.`;
  }
}
