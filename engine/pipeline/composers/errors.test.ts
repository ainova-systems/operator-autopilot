import { describe, it, expect } from "vitest";
import { OperatorError } from "@operator/core";
import { StageLogicError } from "./errors.js";

describe("StageLogicError", () => {
  it("extends OperatorError (so generic catches still match)", () => {
    const err = new StageLogicError("STAGE_SCRATCH_MISSING", "scratch missing");
    expect(err).toBeInstanceOf(OperatorError);
    expect(err).toBeInstanceOf(Error);
  });

  it("sets name to StageLogicError for pino + UI formatting", () => {
    const err = new StageLogicError("INVALID_STAGE_INPUT", "bad payload");
    expect(err.name).toBe("StageLogicError");
  });

  it("carries the provided code verbatim", () => {
    const err = new StageLogicError("HEAD_CHANGED", "planner moved HEAD");
    expect(err.code).toBe("HEAD_CHANGED");
    expect(err.message).toBe("planner moved HEAD");
  });

  it("preserves cause for stack-chain diagnostics", () => {
    const cause = new Error("inner");
    const err = new StageLogicError("STAGE_SCRATCH_MISSING", "wrapped", { cause });
    expect(err.cause).toBe(cause);
  });
});
