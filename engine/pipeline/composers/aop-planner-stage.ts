import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  OperationContext, StateManager, VCSPlatform, KindRegistry,
  WorkItemSource, AgentEventStream, AgentRoleName, WorkItemKind,
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
import { applyAgentEvents } from "../primitives/aop-applier.js";
import { findChildrenByParentId } from "../primitives/idempotency-scan.js";
import {
  captureHeadSnapshot, verifyHeadUnchanged,
  type HeadSnapshot,
} from "../primitives/head-snapshot-contract.js";
import { createScratchStore } from "./_shared/scratch.js";
import { StageLogicError } from "./errors.js";

/**
 * Generic stage composer for the "AOP planner" pattern.
 *
 * Pattern shape (kind-agnostic, stage-name-agnostic):
 *
 *  1. `per-item` selector picks a pending parent work-item of the
 *     configured kind.
 *  2. `WorkspaceScope.prepare` creates / reuses the per-item branch.
 *  3. `beforeAgent`: recover from `failed` (reset to `in-progress` +
 *     clear failed_at), transition PR label, capture HEAD snapshot,
 *     run idempotency scan looking for already-created child items.
 *  4. `synthesizeAgentResult`: short-circuit the agent invocation
 *     when idempotency scan already found child items.
 *  5. `buildRunInput`: construct the configured planner-role agent's
 *     input.
 *  6. `runStage` invokes the read-only planner agent.
 *  7. `afterAgent`: verify HEAD unchanged (planner is read-only;
 *     contract violation = stage failure), apply AOP child-item +
 *     verdict records through `applyAgentEvents`, flip parent's
 *     status to `in-progress` when child items were created.
 *
 * The composer is consumed by any stage whose planner-role agent
 * scans a parent work-item file and emits AOP child-item records.
 * A `finding-plan` stage that decomposes findings into tasks is the
 * canonical example, but any future repo can compose this same
 * pattern by passing its own parent / child kinds, agent role,
 * verifier topic, branch prefix, and PR template through
 * {@link AopPlannerHookDeps}.
 */

interface AopPlannerScratch {
  readonly itemId: string;
  readonly filePath: string;
  readonly item: WorkItemFileData;
  readonly codeReviewId: number | null;
  readonly headSnapshot: HeadSnapshot;
  readonly alreadyPlannedChildren?: ReadonlyArray<string>;
  /**
   * Set by `afterAgent` on the rejected verdict path. `buildPR` reads this
   * to produce a rejection-specific PR title (REJECTED suffix) + body that
   * carries the agent's reasoning, instead of the standard in-progress
   * template. The human reviewer sees the rejection explanation directly
   * in the PR description without opening the execution log.
   */
  rejection?: { agentRole: string; reason: string };
}

const aopPlannerScratch = createScratchStore<AopPlannerScratch>();

export interface AopPlannerHookDeps {
  readonly state: StateManager;
  readonly vcs: VCSPlatform;
  readonly prManager: PRManager;
  readonly git: WorkspaceGit;
  readonly kindRegistry: KindRegistry;
  /** Storage directory for parent work-items (e.g. the findings dir). */
  readonly parentDataDir: string;
  /** Storage directory for child work-items (e.g. the tasks dir). */
  readonly childDataDir: string;
  readonly automationDir: string;
  readonly workspacePath: string;
  readonly templatesDir: string;
  readonly agentsConfig: AgentsFile;
  readonly promptSource: PromptSource;
  readonly workItemSource: WorkItemSource;
  readonly agentEventStream: AgentEventStream;
  readonly stateVars?: StateContextVars;
  readonly log?: Logger;
  readonly debug?: boolean;
  readonly debugRunUrl?: string;
  readonly kv?: import("@operator/core").KVStore;

  // ── Stage-shape parameters ────────────────────────────────────────
  /** Parent work-item kind (e.g. `"finding"`). */
  readonly parentKind: WorkItemKind;
  /** Planner agent role (e.g. `"planner"`). */
  readonly agentRole: AgentRoleName;
  /** Verifier chain topic suffix, used as `verifier/{verifierTopic}`. */
  readonly verifierTopic: string;
  /** Branch prefix for the parent's PRs (e.g. `"ai/findings"`). */
  readonly branchPrefix: string;
  /** PR title prefix (e.g. `"[AI:Finding]"`). */
  readonly prPrefix: string;
  /** In-progress PR body template filename. */
  readonly prTemplate: string;
  /** Human-facing display name (e.g. `"Finding"`). */
  readonly displayName: string;
  /** ID prefix for parent items (e.g. `"F"`) — used for parsing date / seq. */
  readonly idPrefix: string;
  /** Prompt variable name for the parent id (e.g. `"FINDING_ID"`). */
  readonly idVarName: string;
  /** Prompt variable name for the seq (e.g. `"FINDING_SEQ"`). */
  readonly seqVarName: string;
}

export function buildAopPlannerBeforeAgent(deps: AopPlannerHookDeps) {
  return async (
    stage: StageDef,
    input: StageInput,
    _workspace: WorkspaceHandle,
    ctx: OperationContext,
  ): Promise<{ processingPRs?: readonly number[] } | void> => {
    const itemId = input.scopeKey;
    const filePath = join(deps.parentDataDir, `${itemId}.md`);
    const item = await readWorkItemFile(filePath);
    deps.log?.debug(`${stage.name}: loaded ${itemId}`, {
      stage: stage.name, itemId, status: item.status,
    });

    if (item.status === "failed") {
      deps.log?.info(`${stage.name}: resetting failed ${deps.parentKind} ${itemId} to in-progress for retry`, {
        stage: stage.name, itemId, previousStatus: "failed",
      });
      await updateWorkItemFileStatus(filePath, "in-progress");
      let content = await readFile(filePath, "utf-8");
      content = content.replace(/^failed_at:.*\n/m, "");
      await writeFile(filePath, content, "utf-8");
    }

    const branch = `${deps.branchPrefix}/${itemId}`;
    const codeReviewId = await findCodeReviewForBranch(deps.vcs, branch);

    if (codeReviewId) {
      await deps.prManager.markProcessing(codeReviewId);
      deps.log?.info(`${stage.name}: PR #${codeReviewId} label ai:pending → ai:processing`, {
        stage: stage.name, itemId, prNumber: codeReviewId,
      });
    }

    const headSnapshot = await captureHeadSnapshot(deps.git);

    const alreadyPlannedChildren = await findChildrenByParentId({
      dataDir: deps.childDataDir,
      parentId: itemId,
    });

    aopPlannerScratch.set(ctx, itemId, {
      itemId, filePath, item, codeReviewId, headSnapshot,
      alreadyPlannedChildren: alreadyPlannedChildren.length > 0 ? alreadyPlannedChildren : undefined,
    });

    if (alreadyPlannedChildren.length > 0) {
      deps.log?.info(
        `${stage.name}: ${itemId} already has ${alreadyPlannedChildren.length} child item(s) — will skip planner and refresh status only`,
        {
          stage: stage.name, itemId,
          childIds: alreadyPlannedChildren,
        },
      );
    }

    if (codeReviewId) {
      return { processingPRs: [codeReviewId] };
    }
  };
}

export function buildAopPlannerSynthesizeAgentResult(_deps: AopPlannerHookDeps) {
  return async (
    _stage: StageDef,
    input: StageInput,
    _workspace: WorkspaceHandle,
    ctx: OperationContext,
  ): Promise<AgentResult | null> => {
    const itemId = input.scopeKey;
    const scratch = aopPlannerScratch.get(ctx, itemId);
    if (!scratch || !scratch.alreadyPlannedChildren) return null;
    const count = scratch.alreadyPlannedChildren.length;
    return {
      verdict: "approved",
      output: `=== EMIT verdict ===\nvalue: approved\nsummary: Item ${itemId} already has ${count} child item(s); planner skipped.\n=== END EMIT ===`,
      attempts: 0,
      summary: `[idempotency] Item ${itemId} already planned (${count} child item(s) exist); skipped planner re-run.`,
    };
  };
}

export function buildAopPlannerBuildRunInput(deps: AopPlannerHookDeps) {
  return async (
    _stage: StageDef,
    input: StageInput,
    _ctx: OperationContext,
  ): Promise<AgentRunInput> => {
    const itemId = input.scopeKey;
    const filePath = join(deps.parentDataDir, `${itemId}.md`);
    const item = await readWorkItemFile(filePath);
    const role = resolveRole(deps.agentsConfig, deps.agentRole);
    const reviewCriteria = role.review
      ? await deps.promptSource.loadChain(`verifier/${deps.verifierTopic}`)
      : undefined;

    // itemId conforms to {idPrefix}{date}-{seq} — slice 1..9 = date,
    // split on `-`[1] = seq. The idPrefix length is fixed at 1 by the
    // current id-pattern convention.
    const datePart = itemId.slice(deps.idPrefix.length, deps.idPrefix.length + 8);
    const itemSeq = itemId.split("-")[1] ?? "0001";
    const timestamp = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

    const { buildExecutionHistoryBlock } = await import("../primitives/execution-context.js");
    const historyBlock = await buildExecutionHistoryBlock(deps.kv, itemId);
    const taskContent = historyBlock
      ? `${historyBlock}\n${item.body}`
      : item.body;

    // Pass through the parent finding's path (either explicit
    // frontmatter `path:` or the body-derived heuristic via
    // `derivePathFromBody` — picks up the `**Domain**` field findings
    // emit). Without this, the prompt-builder's layers 3 + 5 cannot
    // filter `.operator/context/{backend,frontend}.md` and every
    // finding-plan execution carries both contexts (~6k extra chars
    // per call). Symmetrical to the wiring in
    // `verifier-driven-creator-stage.beforeAgent`.
    const itemPath = item.path ?? undefined;

    return buildRunInput(
      role,
      {
        promptSource: deps.promptSource,
        automationDir: deps.automationDir,
        vars: {
          [deps.idVarName]: itemId,
          DATE: datePart,
          [deps.seqVarName]: itemSeq,
          TIMESTAMP: timestamp,
          ...deps.stateVars,
        },
        rulesFrom: itemPath ? deps.agentRole : undefined,
        contextPath: itemPath,
      },
      {
        taskContent,
        cwd: deps.workspacePath,
        maxRetries: 2,
        reviewCriteria,
      },
    );
  };
}

export function buildAopPlannerBuildPR(deps: AopPlannerHookDeps) {
  return async (
    _stage: StageDef,
    input: StageInput,
    ctx: OperationContext,
  ): Promise<{ title: string; body: string; commitMessage: string; onSuccess?: "in-review" | "ready-to-merge" | "none" }> => {
    const itemId = input.scopeKey;
    const filePath = join(deps.parentDataDir, `${itemId}.md`);
    const item = await readWorkItemFile(filePath);

    // afterAgent stashes rejection context in scratch when the agent
    // determined the item is invalid. Render a rejection-specific PR so
    // the human reviewer sees WHAT was rejected and WHY directly in the
    // PR description — without needing to open the execution log.
    const scratch = aopPlannerScratch.get(ctx, itemId);
    try {
      if (scratch?.rejection) {
        const title = `${deps.prPrefix} ${itemId}: REJECTED — ${item.title}`;
        const body = [
          `## ${deps.displayName} ${itemId}: rejected by ${scratch.rejection.agentRole}`,
          "",
          `**Reason**: ${scratch.rejection.reason}`,
          "",
          `**What this PR does**: flips \`status: pending → rejected\` on the ${deps.displayName.toLowerCase()} file so the orchestrator stops re-picking this item.`,
          "",
          `**Original ${deps.displayName.toLowerCase()} body**:`,
          "",
          item.body.slice(0, 1500) + (item.body.length > 1500 ? "\n\n[…truncated]" : ""),
          "",
          "---",
          "",
          `**Reviewer action**: merge this PR to propagate the rejection to develop, or close-without-merge if you disagree — the supervisor will handle override on the next cycle.`,
        ].join("\n");
        const commitMessage = `${deps.displayName} ${itemId}: rejected — ${scratch.rejection.reason.slice(0, 80)}`;
        return { title, body, commitMessage, onSuccess: "in-review" };
      }

      // Catch-up path: idempotency scan found pre-existing child items on
      // the base branch, planner was skipped (see synthesizeAgentResult).
      // Diff carries only the parent's frontmatter flip — no new child
      // files. Render a self-describing body so the human reviewer does
      // NOT have to guess "is this a plan or a status-only bump?".
      if (scratch?.alreadyPlannedChildren && scratch.alreadyPlannedChildren.length > 0) {
        const childIds = scratch.alreadyPlannedChildren;
        const title = `${deps.prPrefix} ${itemId} (catch-up): ${item.title}`;
        const body = [
          `## ${deps.displayName} ${itemId}: catch-up — planner skipped`,
          "",
          `**What this PR does**: flips \`status: pending → in-progress\` on the ${deps.displayName.toLowerCase()} file only. No new child items were emitted.`,
          "",
          `**Why planner was skipped**: ${childIds.length} child item(s) for this ${deps.displayName.toLowerCase()} already exist on the base branch:`,
          "",
          ...childIds.map((id) => `- \`${id}\``),
          "",
          `**Reviewer action**: safe to merge as-is — this is the idempotency contract bringing the recorded ${deps.displayName.toLowerCase()} status in line with prior planning.`,
        ].join("\n");
        const commitMessage = `${deps.displayName} ${itemId}: catch-up status flip (${childIds.length} child item(s) already exist)`;
        return { title, body, commitMessage, onSuccess: "in-review" };
      }

      // Plan path: planner ran and emitted new child items. The standard
      // in-progress template covers this case — assumption + metadata.
      const title = `${deps.prPrefix} ${itemId}: ${item.title}`;
      const body = await deps.prManager
        .loadTemplate(deps.templatesDir, deps.prTemplate, {
          FINDING_ID: itemId,
          [deps.idVarName]: itemId,
          TYPE: item.kind,
          PRIORITY: String(item.priority),
          SOURCE: item.source ?? "unknown",
          ASSUMPTION: item.body.slice(0, 500),
        })
        .catch(() => `## ${deps.displayName} ${itemId}\n\nIn progress.`);

      const commitMessage = `${deps.displayName} ${itemId}: planner emitted child item(s)`;
      return { title, body, commitMessage, onSuccess: "in-review" };
    } finally {
      // buildPR is the last hook that reads scratch — clear here to bound
      // store lifetime to a single cycle. Moved from afterAgent.finally
      // 2026-05-13 when Fix 8 made buildPR depend on scratch.rejection
      // (set by afterAgent on the rejected path).
      aopPlannerScratch.clear(ctx, itemId);
    }
  };
}

export function buildAopPlannerAfterAgent(deps: AopPlannerHookDeps) {
  return async (
    stage: StageDef,
    input: StageInput,
    agentResult: AgentResult,
    _workspace: WorkspaceHandle,
    ctx: OperationContext,
  ): Promise<{ verdictOverride?: Verdict; summaryOverride?: string } | void> => {
    const itemId = input.scopeKey;
    const scratch = aopPlannerScratch.get(ctx, itemId);
    if (!scratch) {
      throw new StageLogicError(
        "STAGE_SCRATCH_MISSING",
        `${stage.name} afterAgent: missing scratch for ${itemId} — beforeAgent not run`,
      );
    }
    try {
      // Idempotency path — beforeAgent's scan found existing child items.
      if (scratch.alreadyPlannedChildren) {
        if (scratch.item.status === "pending") {
          await updateStatusAndSync(scratch.filePath, "in-progress", deps.state, ctx);
          deps.log?.info(
            `${stage.name}: ${itemId} idempotent refresh — status: pending → in-progress`,
            { stage: stage.name, itemId, alreadyPlanned: true },
          );
        }
        const count = scratch.alreadyPlannedChildren.length;
        if (scratch.codeReviewId) {
          await deps.prManager.postBotComment(
            scratch.codeReviewId,
            `${deps.displayName} **${itemId}** already has ${count} child item(s); planner skipped, status refreshed to \`in-progress\`.`,
          );
        }
        return {
          summaryOverride: `${deps.displayName} ${itemId} already planned (${count} item(s)); status refreshed.`,
        };
      }

      // HEAD-unchanged contract.
      const headCheck = await verifyHeadUnchanged(deps.git, scratch.headSnapshot);
      if (!headCheck.ok) {
        const headChanged = new StageLogicError("HEAD_CHANGED", headCheck.message ?? "HEAD moved");
        deps.log?.error(`${stage.name}: ${deps.agentRole} violated read-only contract for ${itemId} (HEAD ${headCheck.preSha?.slice(0, 7)} → ${headCheck.postSha.slice(0, 7)})`, {
          stage: stage.name, itemId,
          preAgentHead: headCheck.preSha, postAgentHead: headCheck.postSha,
          code: headChanged.code,
        });
        await updateStatusAndSync(scratch.filePath, "failed", deps.state, ctx);
        return {
          verdictOverride: "failed",
          summaryOverride: headChanged.message,
        };
      }

      // Pre-applier terminal verdicts.
      if (agentResult.verdict !== "approved") {
        const status = agentResult.verdict === "cancelled" ? "cancelled"
          : agentResult.verdict === "rejected" ? "rejected"
          : "failed";
        await updateStatusAndSync(scratch.filePath, status, deps.state, ctx);
        if (scratch.codeReviewId) {
          const suffix = formatDebugRunLinkSuffix(deps.debug, deps.debugRunUrl);
          const body = buildTerminalComment(deps.displayName, itemId, status as "failed" | "cancelled" | "rejected", agentResult.summary) + suffix;
          await deps.prManager.postBotComment(scratch.codeReviewId, body);
        }
        return;
      }

      // AOP applier path.
      const datePart = itemId.slice(deps.idPrefix.length, deps.idPrefix.length + 8);
      const applied = await applyAgentEvents(
        agentResult.output,
        {
          stream: deps.agentEventStream,
          source: deps.workItemSource,
          registry: deps.kindRegistry,
          log: deps.log,
        },
        {
          workItem: { id: itemId, kind: deps.parentKind },
          date: datePart,
        },
        ctx,
      );
      deps.log?.info(
        `${stage.name}: ${itemId} applier verdict=${applied.verdict}, child-items=${applied.applied.childItems.length}, parse-errors=${applied.diagnostics.filter((d) => d.severity === "error").length}, apply-errors=${applied.applyErrors.length}`,
        {
          stage: stage.name, itemId, plannerVerdict: applied.verdict,
          childItems: applied.applied.childItems.length,
          applyErrors: applied.applyErrors.length,
        },
      );

      if (applied.verdict === "rejected") {
        // Rejection is a SUCCESS for the agent — it correctly identified
        // a false-positive / obsolete / invalid item. Mark the item
        // terminal (rejected) in state; persist will then commit the
        // status flip + create the PR which acts as a normal data-sync
        // vehicle awaiting human review. PR body explains the rejection
        // reasoning (rendered by `buildPR` reading `scratch.rejection`).
        // NO auto-close per MVP rules (user explicit guidance: never
        // auto-close PRs unless stage config declares it). The human
        // reviewer either merges the PR (propagating rejection to
        // develop) or closes-without-merge to override the rejection;
        // supervisor handles human override decisions on the next cycle.
        await updateStatusAndSync(scratch.filePath, "rejected", deps.state, ctx);
        const reason = applied.summary || `${deps.displayName} ${itemId} marked invalid by ${deps.agentRole}`;
        // Stash rejection context so buildPR can produce a rejection-specific
        // PR title + body instead of the standard in-progress template.
        scratch.rejection = { agentRole: deps.agentRole, reason };
        if (scratch.codeReviewId) {
          const suffix = formatDebugRunLinkSuffix(deps.debug, deps.debugRunUrl);
          await deps.prManager.postBotComment(
            scratch.codeReviewId,
            `${deps.displayName} **${itemId}** determined invalid by ${deps.agentRole}: ${reason}${suffix}\n\nThe PR carries the \`status: rejected\` flip ready for review. Merge to propagate the rejection to develop, or close-without-merge if you disagree (the supervisor handles override on the next cycle).`,
          );
        }
        return {
          verdictOverride: "rejected",
          summaryOverride: reason,
        };
      }

      if (applied.verdict === "failed") {
        await updateStatusAndSync(scratch.filePath, "failed", deps.state, ctx);
        if (scratch.codeReviewId) {
          const suffix = formatDebugRunLinkSuffix(deps.debug, deps.debugRunUrl);
          await deps.prManager.postBotComment(
            scratch.codeReviewId,
            `${deps.displayName} **${itemId}** failed: ${applied.summary}.${suffix}`,
          );
        }
        return {
          verdictOverride: "failed",
          summaryOverride: applied.summary,
        };
      }

      const createdIds = applied.applied.childItems.map((c) => c.id);
      if (createdIds.length === 0) {
        deps.log?.error(`${stage.name}: ${deps.agentRole} approved but no EMIT child-item records for ${itemId}`, {
          stage: stage.name, itemId,
        });
        await updateStatusAndSync(scratch.filePath, "failed", deps.state, ctx);
        if (scratch.codeReviewId) {
          const suffix = formatDebugRunLinkSuffix(deps.debug, deps.debugRunUrl);
          await deps.prManager.postBotComment(
            scratch.codeReviewId,
            `${deps.displayName} **${itemId}** failed: ${deps.agentRole} returned approved verdict without any EMIT child-item records.${suffix}`,
          );
        }
        return {
          verdictOverride: "failed",
          summaryOverride: `${deps.agentRole} approved without any EMIT child-item records`,
        };
      }

      if (scratch.item.status === "pending") {
        await updateStatusAndSync(scratch.filePath, "in-progress", deps.state, ctx);
        deps.log?.info(
          `${stage.name}: ${itemId} status: pending → in-progress (plan created)`,
          { stage: stage.name, itemId, childrenCreated: createdIds.length },
        );
      }

      if (scratch.codeReviewId) {
        const taskList = createdIds.map((id) => `- [ ] **${id}**`).join("\n");
        await deps.prManager.postBotComment(
          scratch.codeReviewId,
          `${deps.displayName} **${itemId}** verified. ${createdIds.length} item(s) created:\n\n${taskList}`,
        );
      }

      deps.log?.info(`${stage.name}: ${itemId} valid, ${createdIds.length} children created`, {
        stage: stage.name, itemId, childrenCreated: createdIds.length, childIds: createdIds,
      });

      return {
        summaryOverride: `${deps.displayName} ${itemId} verified; ${createdIds.length} item(s) created: ${createdIds.join(", ")}`,
      };
    } catch (err) {
      deps.log?.error(`${stage.name}: afterAgent failed for ${itemId}`, {
        stage: stage.name, itemId, error: errorMessage(err),
      });
      throw err;
    }
    // Scratch cleared in buildPR's finally — buildPR is the last hook
    // that reads scratch (it consumes scratch.rejection set above on the
    // rejected path to render REJECTED title + reason in the PR body).
    // Matches the pattern used by discovery-iteration-stage + weekly-
    // metrics-stage. If buildPR is somehow skipped, the entry sticks
    // around for the current cycle's traceId and is GC'd when ctx goes
    // out of scope (next cycle uses a fresh traceId, no leak).
  };
}

function buildTerminalComment(displayName: string, itemId: string, disposition: "failed" | "cancelled" | "rejected", reason: string): string {
  switch (disposition) {
    case "failed":
      return `${displayName} **${itemId}** failed: ${reason}. Remove the failed label to retry.`;
    case "cancelled":
      return `${displayName} **${itemId}** cancelled: ${reason}. Closing PR — no retry will be attempted.`;
    case "rejected":
      return `${displayName} **${itemId}** rejected: ${reason}. Closing PR — the retrospective will regenerate a replacement item with updated scope.`;
  }
}
