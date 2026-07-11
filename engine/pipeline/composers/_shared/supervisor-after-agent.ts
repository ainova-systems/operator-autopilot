import type { OperationContext } from "@operator/core";
import { formatDebugRunLinkSuffix } from "../../../delivery/vcs-helpers.js";
import type { BotAttribution } from "../../../delivery/bot-footer.js";
import type { StageDef, AgentResult, Verdict } from "../../types.js";
import type { PrFeedbackPayload } from "../../primitives/pr-feedback-selector.js";
import { formatReviewLimitReachedMessage } from "./supervisor-bot-messages.js";
import type { PrFeedbackSupervisorScratch } from "./supervisor-scratch.js";
import type { SupervisorAfterAgentDeps } from "./supervisor-after-agent-deps.js";
import { applySupervisorAgentEvents } from "./supervisor-aop-apply.js";
import { detectSupervisorChanges } from "./supervisor-change-detection.js";
import { routeSupervisorVerdict } from "./supervisor-verdict-routing.js";

export type { SupervisorAfterAgentDeps } from "./supervisor-after-agent-deps.js";

export async function processSupervisorAfterAgent(
  deps: SupervisorAfterAgentDeps,
  stage: StageDef,
  payload: PrFeedbackPayload,
  scratch: PrFeedbackSupervisorScratch,
  agentResult: AgentResult,
  ctx: OperationContext,
): Promise<{ verdictOverride?: Verdict; summaryOverride?: string } | void> {
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
    const msg = formatReviewLimitReachedMessage(scratch.reviewAttempts, scratch.maxAttempts, suffix);
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

  const applied = await applySupervisorAgentEvents(
    deps, stage, payload, agentResult.output, ctx, deps.log,
  );
  const changes = await detectSupervisorChanges(deps.git, scratch, stage, payload, deps.log);
  return routeSupervisorVerdict(
    deps, stage, payload, scratch, agentResult, applied, changes, nextAttribution, ciFailing,
  );
}
