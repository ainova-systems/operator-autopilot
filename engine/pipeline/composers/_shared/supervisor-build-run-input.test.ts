import { describe, it, expect, vi } from "vitest";
import type { OperationContext } from "@operator/core";
import type { StageDef, StageInput } from "../../types.js";
import type { PrFeedbackSupervisorHookDeps } from "./supervisor-stage-deps.js";
import { StageLogicError } from "../errors.js";
import { buildPrFeedbackSupervisorBuildRunInput } from "./supervisor-build-run-input.js";
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

function makeInput(): StageInput {
  return {
    scopeKey: "3",
    data: {
      prId: 3, branch: "ai/tasks/T-3", baseBranch: "develop", prType: "task",
      newFeedback: "please fix", fullThread: "", botAttempts: 0, oldestFreshAt: "",
      checks: { value: "passing" as const, observedAt: "", checks: [] },
      respondedIds: [], ciAttempts: 0, maxCiRetryAttempts: 3,
      reviewThreads: [], freshReviewCommentIds: [],
    },
  };
}

function makeDeps(): PrFeedbackSupervisorHookDeps {
  return {
    prManager: {} as never,
    git: {} as never,
    agentsConfig: {
      defaultProvider: "claude",
      providers: { claude: { command: "claude" } },
      agents: {
        supervisor: {
          provider: "claude", instructions: "agents/supervisor.md",
          timeout: 3600, model: "opus", review: true,
          tools: "Read", maxBudget: 1, context: ["base"],
        },
      },
    } as never,
    promptSource: { loadChain: vi.fn().mockResolvedValue("criteria") } as never,
    defaults: {} as never,
    automationDir: "/tmp/.operator",
    workspacePath: "/tmp/ws",
    kindRegistry: {} as never,
    workItemSource: {} as never,
    agentEventStream: {} as never,
    agentRole: "supervisor",
    verifierTopic: "pr-feedback",
    log: { warn: vi.fn() } as never,
  };
}

const stage = { name: "pr-review" } as StageDef;

describe("buildPrFeedbackSupervisorBuildRunInput", () => {
  it("throws STAGE_SCRATCH_MISSING when beforeAgent did not run", async () => {
    const ctx = makeCtx();
    await expect(
      buildPrFeedbackSupervisorBuildRunInput(makeDeps())(stage, makeInput(), ctx),
    ).rejects.toBeInstanceOf(StageLogicError);
    await expect(
      buildPrFeedbackSupervisorBuildRunInput(makeDeps())(stage, makeInput(), ctx),
    ).rejects.toMatchObject({ code: "STAGE_SCRATCH_MISSING" });
  });

  it("loads verifier chain from verifier/{verifierTopic}", async () => {
    const deps = makeDeps();
    const ctx = makeCtx();
    prFeedbackSupervisorScratch.set(ctx, prFeedbackSupervisorScratchKey(3), {
      prId: 3, branch: "ai/tasks/T-3", prType: "task",
      reviewAttempts: 0, maxAttempts: 20, limitReached: false,
      threadFile: "", newFeedback: "please fix", checksContextFile: "", preAgentHeadSha: "",
    });
    const runInput = await buildPrFeedbackSupervisorBuildRunInput(deps)(stage, makeInput(), ctx);
    expect(deps.promptSource.loadChain).toHaveBeenCalledWith("verifier/pr-feedback");
    expect(runInput.taskContent).toContain("please fix");
    expect(runInput.cwd).toBe("/tmp/ws");
  });
});
