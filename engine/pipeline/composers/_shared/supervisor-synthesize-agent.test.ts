import { describe, it, expect, vi } from "vitest";
import type { OperationContext } from "@operator/core";
import type { StageDef, StageInput } from "../../types.js";
import type { WorkspaceHandle } from "../../primitives/workspace-scope.js";
import type { PrFeedbackSupervisorHookDeps } from "./supervisor-stage-deps.js";
import { buildPrFeedbackSupervisorSynthesizeAgentResult } from "./supervisor-synthesize-agent.js";
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

function makeInput() {
  return {
    scopeKey: "1",
    data: {
      prId: 1, branch: "ai/tasks/T-1", baseBranch: "develop", prType: "task",
      newFeedback: "", fullThread: "", botAttempts: 0, oldestFreshAt: "",
      checks: { value: "passing" as const, observedAt: "", checks: [] },
      respondedIds: [], ciAttempts: 0, maxCiRetryAttempts: 3,
      reviewThreads: [], freshReviewCommentIds: [],
    },
  } satisfies StageInput;
}

const stage = { name: "pr-review" } as StageDef;
const workspace = {} as WorkspaceHandle;

describe("buildPrFeedbackSupervisorSynthesizeAgentResult", () => {
  it("returns null when review cap is not reached (normal path)", async () => {
    const deps = { log: { info: vi.fn() } } as unknown as PrFeedbackSupervisorHookDeps;
    const ctx = makeCtx();
    prFeedbackSupervisorScratch.set(ctx, prFeedbackSupervisorScratchKey(1), {
      prId: 1, branch: "ai/tasks/T-1", prType: "task",
      reviewAttempts: 1, maxAttempts: 20, limitReached: false,
      threadFile: "", newFeedback: "", checksContextFile: "", preAgentHeadSha: "",
    });
    const result = await buildPrFeedbackSupervisorSynthesizeAgentResult(deps)(
      stage, makeInput(), workspace, ctx,
    );
    expect(result).toBeNull();
  });

  it("returns failed placeholder when review cap is reached", async () => {
    const deps = { log: { info: vi.fn() } } as unknown as PrFeedbackSupervisorHookDeps;
    const ctx = makeCtx();
    prFeedbackSupervisorScratch.set(ctx, prFeedbackSupervisorScratchKey(1), {
      prId: 1, branch: "ai/tasks/T-1", prType: "task",
      reviewAttempts: 20, maxAttempts: 20, limitReached: true,
      threadFile: "", newFeedback: "", checksContextFile: "", preAgentHeadSha: "",
    });
    const result = await buildPrFeedbackSupervisorSynthesizeAgentResult(deps)(
      stage, makeInput(), workspace, ctx,
    );
    expect(result).toMatchObject({
      verdict: "failed",
      output: "",
      attempts: 0,
      summary: "review cycle limit reached (20/20)",
    });
  });
});
