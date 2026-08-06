import type { OperationContext } from "@operator/core";
import type { StageDef, StageInput, AgentResult } from "../../types.js";
import type { WorkspaceHandle } from "../../primitives/workspace-scope.js";
import {
  prFeedbackSupervisorScratch,
  prFeedbackSupervisorScratchKey,
} from "./supervisor-scratch.js";
import type { PrFeedbackSupervisorHookDeps } from "./supervisor-stage-deps.js";
import { payloadOf } from "./supervisor-payload.js";

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
