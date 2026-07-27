import type { OperationContext } from "@operator/core";
import { errorMessage } from "@operator/core";
import { formatDebugRunLinkSuffix } from "../../delivery/vcs-helpers.js";
import { updateStatusAndSync } from "../../work-items/work-items.js";
import type { StageDef, StageInput, AgentResult, Verdict } from "../types.js";
import type { WorkspaceHandle } from "../primitives/workspace-scope.js";
import { applyAgentEvents } from "../primitives/aop-applier.js";
import { verifyHeadUnchanged } from "../primitives/head-snapshot-contract.js";
import { aopPlannerScratch } from "./_shared/aop-planner-scratch.js";
import { buildPlannerTerminalComment } from "./_shared/planner-pr-body.js";
import type { AopPlannerHookDeps } from "./_shared/aop-planner-deps.js";
import { StageLogicError } from "./errors.js";

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
          const body = buildPlannerTerminalComment(deps.displayName, itemId, status as "failed" | "cancelled" | "rejected", agentResult.summary) + suffix;
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
