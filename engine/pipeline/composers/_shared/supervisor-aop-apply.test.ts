import { describe, it, expect, vi } from "vitest";
import type { OperationContext } from "@operator/core";
import type { StageDef } from "../../types.js";
import type { PrFeedbackPayload } from "../../primitives/pr-feedback-selector.js";
import type { SupervisorAfterAgentDeps } from "./supervisor-after-agent-deps.js";
import { applySupervisorAgentEvents } from "./supervisor-aop-apply.js";

function makeCtx(): OperationContext {
  return {
    traceId: `trace-${Math.random()}`,
    repoId: "sample",
    action: "test",
    budget: { limitUsd: undefined, spentUsd: 0, add: () => {}, isExceeded: () => false },
    signal: AbortSignal.timeout(10_000),
  };
}

function makePayload(): PrFeedbackPayload {
  return {
    prId: 10, branch: "ai/tasks/T-10", baseBranch: "develop", prType: "task",
    newFeedback: "", fullThread: "", botAttempts: 0, oldestFreshAt: "",
    checks: { value: "passing", observedAt: "", checks: [] },
    respondedIds: [], ciAttempts: 0, maxCiRetryAttempts: 3,
    reviewThreads: [{
      threadId: "THREAD_1", isResolved: false, authorType: "Bot", commentIds: ["c1"],
    }],
    freshReviewCommentIds: ["c1"],
  };
}

function makeDeps(events: unknown[]): SupervisorAfterAgentDeps {
  return {
    prManager: {
      postThreadReply: vi.fn().mockResolvedValue(undefined),
      resolveThread: vi.fn().mockResolvedValue(undefined),
    } as never,
    git: {} as never,
    kindRegistry: {
      all: [{
        name: "task", idPrefix: "T", dataDir: ".operator/data/tasks",
        branchPrefix: "ai/tasks", terminalStatuses: [], parentKinds: [],
      }],
    } as never,
    workItemSource: {} as never,
    agentEventStream: {
      parse: vi.fn().mockReturnValue({ events, diagnostics: [] }),
    } as never,
    log: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
  };
}

const stage = { name: "pr-review" } as StageDef;

describe("applySupervisorAgentEvents", () => {
  it("applies agent output and disposes review threads when replies are present", async () => {
    const deps = makeDeps([
      { type: "comment-reply", thread: "c1", disposition: "fixed", note: "done" },
      { type: "verdict", value: "approved", summary: "fixed" },
    ]);
    const result = await applySupervisorAgentEvents(
      deps, stage, makePayload(), "agent stdout", makeCtx(),
    );
    expect(result.verdict).toBe("approved");
    expect(deps.prManager.postThreadReply).toHaveBeenCalled();
    expect(deps.prManager.resolveThread).toHaveBeenCalledWith("THREAD_1");
  });

  it("skips thread disposition when there are no threads and no replies", async () => {
    const deps = makeDeps([{ type: "verdict", value: "approved", summary: "ok" }]);
    const payload = { ...makePayload(), reviewThreads: [], freshReviewCommentIds: [] };
    await applySupervisorAgentEvents(deps, stage, payload, "out", makeCtx());
    expect(deps.prManager.postThreadReply).not.toHaveBeenCalled();
  });
});
