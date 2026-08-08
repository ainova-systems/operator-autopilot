import { describe, it, expect, vi } from "vitest";
import type { OperationContext } from "@operator/core";
import type { AgentResult, StageDef, StageInput } from "../../types.js";
import type { WorkspaceHandle } from "../../primitives/workspace-scope.js";
import type { PrFeedbackSupervisorHookDeps } from "./supervisor-stage-deps.js";
import { StageLogicError } from "../errors.js";
import { buildPrFeedbackSupervisorAfterAgent } from "./supervisor-after-agent-hook.js";

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
    scopeKey: "8",
    data: {
      prId: 8, branch: "ai/tasks/T-8", baseBranch: "develop", prType: "task",
      newFeedback: "", fullThread: "", botAttempts: 0, oldestFreshAt: "",
      checks: { value: "passing" as const, observedAt: "", checks: [] },
      respondedIds: [], ciAttempts: 0, maxCiRetryAttempts: 3,
      reviewThreads: [], freshReviewCommentIds: [],
    },
  };
}

function makeDeps(): PrFeedbackSupervisorHookDeps {
  return {
    prManager: { postBotComment: vi.fn().mockResolvedValue(undefined) } as never,
    git: {
      isClean: vi.fn().mockResolvedValue(true),
      headSha: vi.fn().mockResolvedValue("sha"),
    } as never,
    kindRegistry: { all: [] } as never,
    workItemSource: {} as never,
    agentEventStream: {
      parse: vi.fn().mockReturnValue({
        events: [{ type: "verdict", value: "approved", summary: "ok" }],
        diagnostics: [],
      }),
    } as never,
    log: { info: vi.fn(), error: vi.fn() } as never,
    agentsConfig: {} as never,
    promptSource: {} as never,
    defaults: {} as never,
    automationDir: "/tmp",
    workspacePath: "/tmp/ws",
    agentRole: "supervisor",
    verifierTopic: "pr-feedback",
  };
}

const stage = { name: "pr-review" } as StageDef;
const workspace = {} as WorkspaceHandle;
const agentResult = { verdict: "approved", summary: "ok", output: "", attempts: 1 } as AgentResult;

describe("buildPrFeedbackSupervisorAfterAgent", () => {
  it("throws STAGE_SCRATCH_MISSING when scratch is absent", async () => {
    const hook = buildPrFeedbackSupervisorAfterAgent(makeDeps());
    await expect(
      hook(stage, makeInput(), agentResult, workspace, makeCtx()),
    ).rejects.toBeInstanceOf(StageLogicError);
    await expect(
      hook(stage, makeInput(), agentResult, workspace, makeCtx()),
    ).rejects.toMatchObject({ code: "STAGE_SCRATCH_MISSING" });
  });
});
