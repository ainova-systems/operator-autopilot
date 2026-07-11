import type { OperationContext } from "@operator/core";
import type { StageDef, StageInput, AgentResult } from "../../types.js";
import type { WorkspaceHandle } from "../../primitives/workspace-scope.js";
import {
  prFeedbackSupervisorScratch,
  prFeedbackSupervisorScratchKey,
} from "./supervisor-scratch.js";
import type { PrFeedbackSupervisorHookDeps } from "./supervisor-stage-deps.js";
import { payloadOf } from "./supervisor-payload.js";

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
