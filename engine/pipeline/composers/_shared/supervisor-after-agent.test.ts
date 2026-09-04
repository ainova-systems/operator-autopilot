import { describe, it, expect, vi } from "vitest";
import type { OperationContext } from "@operator/core";
import type { AgentResult, StageDef } from "../../types.js";
import type { PrFeedbackPayload } from "../../primitives/pr-feedback-selector.js";
import type { SupervisorAfterAgentDeps } from "./supervisor-after-agent-deps.js";
import type { PrFeedbackSupervisorScratch } from "./supervisor-scratch.js";
import { processSupervisorAfterAgent } from "./supervisor-after-agent.js";

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
    prId: 7, branch: "ai/tasks/T-7", baseBranch: "develop", prType: "task",
    newFeedback: "", fullThread: "", botAttempts: 0, oldestFreshAt: "",
    checks: { value: "passing", observedAt: "", checks: [] },
    respondedIds: [], ciAttempts: 0, maxCiRetryAttempts: 3,
    reviewThreads: [], freshReviewCommentIds: [],
  };
}

function makeScratch(overrides: Partial<PrFeedbackSupervisorScratch> = {}): PrFeedbackSupervisorScratch {
  return {
    prId: 7, branch: "ai/tasks/T-7", prType: "task",
    reviewAttempts: 0, maxAttempts: 20, limitReached: false,
    threadFile: "", newFeedback: "", checksContextFile: "", preAgentHeadSha: "sha-pre",
    ...overrides,
  };
}

function makeAgentResult(verdict: AgentResult["verdict"]): AgentResult {
  return { verdict, summary: "ok", output: "", attempts: 1 } as AgentResult;
}

function makeDeps(): SupervisorAfterAgentDeps {
  return {
    prManager: { postBotComment: vi.fn().mockResolvedValue(undefined) } as never,
    git: {
      isClean: vi.fn().mockResolvedValue(true),
      headSha: vi.fn().mockResolvedValue("sha-pre"),
    } as never,
    kindRegistry: { all: [] } as never,
    workItemSource: {} as never,
    agentEventStream: {
      parse: vi.fn().mockReturnValue({
        events: [{ type: "verdict", value: "approved", summary: "ok" }],
        diagnostics: [],
      }),
    } as never,
    log: { info: vi.fn(), warn: vi.fn() } as never,
  };
}

const stage = { name: "pr-review" } as StageDef;

describe("processSupervisorAfterAgent", () => {
  it("overrides verdict to failed when review limit was reached", async () => {
    const deps = makeDeps();
    const result = await processSupervisorAfterAgent(
      deps, stage, makePayload(),
      makeScratch({ limitReached: true, reviewAttempts: 20, maxAttempts: 20 }),
      makeAgentResult("approved"), makeCtx(),
    );
    expect(result).toMatchObject({
      verdictOverride: "failed",
      summaryOverride: "review cycle limit reached (20/20)",
    });
    expect(deps.prManager.postBotComment).toHaveBeenCalledWith(
      7, expect.stringContaining("Review cycle limit reached"), expect.any(Object),
    );
  });

  it("posts applied-feedback comment when workspace has changes", async () => {
    const deps = makeDeps();
    deps.git.isClean = vi.fn().mockResolvedValue(false);
    await processSupervisorAfterAgent(
      deps, stage, makePayload(), makeScratch(),
      makeAgentResult("approved"), makeCtx(),
    );
    expect(deps.prManager.postBotComment).toHaveBeenCalledWith(
      7, expect.stringContaining("Applied review feedback"), expect.any(Object),
    );
  });
});
