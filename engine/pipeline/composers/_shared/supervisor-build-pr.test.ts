import { describe, it, expect } from "vitest";
import type { OperationContext } from "@operator/core";
import type { StageDef, StageInput } from "../../types.js";
import type { PrFeedbackSupervisorHookDeps } from "./supervisor-stage-deps.js";
import { buildPrFeedbackSupervisorBuildPR } from "./supervisor-build-pr.js";
import {
  prFeedbackSupervisorScratch,
  prFeedbackSupervisorScratchKey,
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

const deps = {} as PrFeedbackSupervisorHookDeps;
const stage = { name: "pr-review" } as StageDef;

describe("buildPrFeedbackSupervisorBuildPR", () => {
  it("clears scratch and returns in-review PR metadata", async () => {
    const ctx = makeCtx();
    prFeedbackSupervisorScratch.set(ctx, prFeedbackSupervisorScratchKey(55), {
      prId: 55, branch: "ai/tasks/T-55", prType: "task",
      reviewAttempts: 0, maxAttempts: 20, limitReached: false,
      threadFile: "", newFeedback: "", checksContextFile: "", preAgentHeadSha: "",
    });
    const input: StageInput = {
      scopeKey: "55",
      data: {
        prId: 55, branch: "ai/tasks/T-55", baseBranch: "develop", prType: "task",
        newFeedback: "", fullThread: "", botAttempts: 0, oldestFreshAt: "",
        checks: { value: "passing", observedAt: "", checks: [] },
        respondedIds: [], ciAttempts: 0, maxCiRetryAttempts: 3,
        reviewThreads: [], freshReviewCommentIds: [],
      },
    };
    const result = await buildPrFeedbackSupervisorBuildPR(deps)(stage, input, ctx);
    expect(result).toMatchObject({
      title: "PR #55 supervisor decision",
      onSuccess: "in-review",
    });
    expect(prFeedbackSupervisorScratch.get(ctx, prFeedbackSupervisorScratchKey(55))).toBeUndefined();
  });
});
