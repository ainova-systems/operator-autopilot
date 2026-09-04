import { describe, it, expect } from "vitest";
import type { StageInput } from "../../types.js";
import { StageLogicError } from "../errors.js";
import { payloadOf } from "./supervisor-payload.js";

describe("payloadOf", () => {
  it("returns PrFeedbackPayload when data is valid", () => {
    const payload = { prId: 42, branch: "ai/tasks/T-1" };
    const input: StageInput = { scopeKey: "42", data: payload };
    expect(payloadOf("pr-review", input)).toBe(payload);
  });

  it("throws INVALID_STAGE_INPUT when data is missing", () => {
    const input: StageInput = { scopeKey: "42", data: undefined };
    expect(() => payloadOf("pr-review", input)).toThrow(StageLogicError);
    try {
      payloadOf("pr-review", input);
    } catch (err) {
      expect((err as StageLogicError).code).toBe("INVALID_STAGE_INPUT");
      expect((err as Error).message).toContain("scopeKey: 42");
    }
  });

  it("throws INVALID_STAGE_INPUT when prId is not a number", () => {
    const input: StageInput = { scopeKey: "x", data: { prId: "42" } };
    try {
      payloadOf("pr-review", input);
    } catch (err) {
      expect((err as StageLogicError).code).toBe("INVALID_STAGE_INPUT");
    }
  });
});
