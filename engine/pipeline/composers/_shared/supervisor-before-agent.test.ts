import { describe, it, expect, vi } from "vitest";
import type { OperationContext } from "@operator/core";
import type { StageDef, StageInput } from "../../types.js";
import type { WorkspaceHandle } from "../../primitives/workspace-scope.js";
import type { PrFeedbackSupervisorHookDeps } from "./supervisor-stage-deps.js";
import { buildPrFeedbackSupervisorBeforeAgent } from "./supervisor-before-agent.js";
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

function makeStage(): StageDef {
  return {
    name: "pr-review", agent: "supervisor", selector: "pr-feedback",
    merge: "gated", branchScope: "pr", schedule: "* * * * *",
    enabled: true, baseBranch: "develop",
  };
}

function makeInput(prType: string) {
  const data = {
    prId: 99, branch: "ai/tasks/T-99", baseBranch: "develop", prType,
    newFeedback: "fix it", fullThread: "", botAttempts: 0, oldestFreshAt: "",
    checks: { value: "passing" as const, observedAt: "", checks: [] },
    respondedIds: [], ciAttempts: 0, maxCiRetryAttempts: 3,
    reviewThreads: [], freshReviewCommentIds: [],
  };
  return { scopeKey: "99", data } satisfies StageInput;
}

function makeDeps(commitCount: number): PrFeedbackSupervisorHookDeps {
  return {
    prManager: { markProcessing: vi.fn().mockResolvedValue(undefined) } as never,
    git: {
      commitCount: vi.fn().mockResolvedValue(commitCount),
      headSha: vi.fn().mockResolvedValue("sha-pre"),
    } as never,
    agentsConfig: {} as never,
    promptSource: {} as never,
    defaults: { limits: { maxReviewAttempts: 20, maxCiRetryAttempts: 3 } } as never,
    automationDir: "/tmp", workspacePath: "/tmp/ws",
    kindRegistry: {} as never, workItemSource: {} as never, agentEventStream: {} as never,
    agentRole: "supervisor", verifierTopic: "pr-feedback",
    log: { info: vi.fn(), warn: vi.fn() } as never,
  };
}

const workspace = { branch: "ai/tasks/T-99", baseBranch: "develop", existedRemote: true } as WorkspaceHandle;

describe("buildPrFeedbackSupervisorBeforeAgent", () => {
  it("computes task reviewAttempts with initial offset 2", async () => {
    const deps = makeDeps(5);
    const ctx = makeCtx();
    await buildPrFeedbackSupervisorBeforeAgent(deps)(makeStage(), makeInput("task"), workspace, ctx);
    const scratch = prFeedbackSupervisorScratch.get(ctx, prFeedbackSupervisorScratchKey(99));
    expect(scratch?.reviewAttempts).toBe(3); // 5 - 2
    expect(deps.prManager.markProcessing).toHaveBeenCalledWith(99);
  });

  it("computes non-task reviewAttempts with initial offset 1", async () => {
    const deps = makeDeps(5);
    const ctx = makeCtx();
    await buildPrFeedbackSupervisorBeforeAgent(deps)(makeStage(), makeInput("finding"), workspace, ctx);
    const scratch = prFeedbackSupervisorScratch.get(ctx, prFeedbackSupervisorScratchKey(99));
    expect(scratch?.reviewAttempts).toBe(4); // 5 - 1
  });

  it("defaults reviewAttempts to 0 when commitCount fails", async () => {
    const deps = makeDeps(0);
    deps.git.commitCount = vi.fn().mockRejectedValue(new Error("git down"));
    const ctx = makeCtx();
    await buildPrFeedbackSupervisorBeforeAgent(deps)(makeStage(), makeInput("task"), workspace, ctx);
    const scratch = prFeedbackSupervisorScratch.get(ctx, prFeedbackSupervisorScratchKey(99));
    expect(scratch?.reviewAttempts).toBe(0);
    expect(deps.log?.warn).toHaveBeenCalled();
  });

  it("captures preAgentHeadSha for afterAgent change detection", async () => {
    const deps = makeDeps(2);
    const ctx = makeCtx();
    await buildPrFeedbackSupervisorBeforeAgent(deps)(makeStage(), makeInput("task"), workspace, ctx);
    const scratch = prFeedbackSupervisorScratch.get(ctx, prFeedbackSupervisorScratchKey(99));
    expect(scratch?.preAgentHeadSha).toBe("sha-pre");
  });
});
