import type { OperationContext } from "@operator/core";
import type { Logger } from "../../../logging/logger.js";
import type { StageDef } from "../../types.js";
import type { PrFeedbackPayload } from "../../primitives/pr-feedback-selector.js";
import { applyAgentEvents, type AopApplyResult } from "../../primitives/aop-applier.js";
import { applyThreadDispositions } from "./thread-dispositions.js";
import { inferKindFromBranch } from "./supervisor-branch-item.js";
import type { SupervisorAfterAgentDeps } from "./supervisor-after-agent-deps.js";

export async function applySupervisorAgentEvents(
  deps: SupervisorAfterAgentDeps,
  stage: StageDef,
  payload: PrFeedbackPayload,
  agentOutput: string,
  ctx: OperationContext,
  log?: Logger,
): Promise<AopApplyResult> {
  const activeItem = inferKindFromBranch(payload.branch, deps.kindRegistry);
  const applied = await applyAgentEvents(
    agentOutput,
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
  log?.info(`${stage.name}: PR #${payload.prId} applied ${applied.applied.childItems.length} child-item(s), ${applied.applied.statusUpdates.length} status-update(s); applier verdict=${applied.verdict}`, {
    stage: stage.name, prNumber: payload.prId,
    applierVerdict: applied.verdict,
    childItems: applied.applied.childItems.length,
    statusUpdates: applied.applied.statusUpdates.length,
    bodyUpdates: applied.applied.bodyUpdates.length,
    applyErrors: applied.applyErrors.length,
  });

  if (payload.reviewThreads.length > 0 || applied.commentReplies.length > 0) {
    await applyThreadDispositions({
      prId: payload.prId,
      stage: stage.name,
      commentReplies: applied.commentReplies,
      reviewThreads: payload.reviewThreads,
      freshReviewCommentIds: payload.freshReviewCommentIds,
      prManager: deps.prManager,
      log: deps.log,
    });
  }

  return applied;
}
