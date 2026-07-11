import type { OperationContext } from "@operator/core";
import type { StageDef, StageInput } from "../../types.js";
import {
  prFeedbackSupervisorScratch,
  prFeedbackSupervisorScratchKey,
} from "./supervisor-scratch.js";
import type { PrFeedbackSupervisorHookDeps } from "./supervisor-stage-deps.js";
import { payloadOf } from "./supervisor-payload.js";

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
