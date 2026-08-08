import { describe, it, expect } from "vitest";
import type { OperationContext } from "@operator/core";
import {
  prFeedbackSupervisorScratch,
  prFeedbackSupervisorScratchKey,
  type PrFeedbackSupervisorScratch,
} from "./supervisor-scratch.js";

function makeCtx(): OperationContext {
  return {
    traceId: `trace-${Math.random()}`,
    repoId: "sample",
    action: "test",
    budget: { limitUsd: undefined, spentUsd: 0, add: () => {}, isExceeded: () => false },
    signal: AbortSignal.timeout(10_000),
  };
}

function makeEntry(prId: number): PrFeedbackSupervisorScratch {
  return {
    prId, branch: `ai/tasks/T-${prId}`, prType: "task",
    reviewAttempts: 0, maxAttempts: 20, limitReached: false,
    threadFile: "", newFeedback: "", checksContextFile: "",
    preAgentHeadSha: "",
  };
}

describe("prFeedbackSupervisorScratch", () => {
  it("scopes entries by traceId and prId key", () => {
    const ctxA = makeCtx();
    const ctxB = makeCtx();
    const key = prFeedbackSupervisorScratchKey(42);
    prFeedbackSupervisorScratch.set(ctxA, key, makeEntry(42));
    expect(prFeedbackSupervisorScratch.get(ctxA, key)?.prId).toBe(42);
    expect(prFeedbackSupervisorScratch.get(ctxB, key)).toBeUndefined();
  });

  it("clear removes the entry for the current trace", () => {
    const ctx = makeCtx();
    const key = prFeedbackSupervisorScratchKey(7);
    prFeedbackSupervisorScratch.set(ctx, key, makeEntry(7));
    prFeedbackSupervisorScratch.clear(ctx, key);
    expect(prFeedbackSupervisorScratch.get(ctx, key)).toBeUndefined();
  });
});
