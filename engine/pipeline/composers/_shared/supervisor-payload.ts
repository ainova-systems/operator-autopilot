import type { StageInput } from "../../types.js";
import type { PrFeedbackPayload } from "../../primitives/pr-feedback-selector.js";
import { StageLogicError } from "../errors.js";

export function payloadOf(stageName: string, input: StageInput): PrFeedbackPayload {
  const data = input.data as PrFeedbackPayload | undefined;
  if (!data || typeof data.prId !== "number") {
    throw new StageLogicError(
      "INVALID_STAGE_INPUT",
      `${stageName} hook: stage input missing PrFeedbackPayload (scopeKey: ${input.scopeKey})`,
    );
  }
  return data;
}
