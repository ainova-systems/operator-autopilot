import { describe, it, expect, vi } from "vitest";
import type { AgentResult, StageDef } from "../../types.js";
import type { PrFeedbackPayload } from "../../primitives/pr-feedback-selector.js";
import type { AopApplyResult } from "../../primitives/aop-applier.js";
import type { BotAttribution } from "../../../delivery/bot-footer.js";
import type { PrFeedbackSupervisorScratch } from "./supervisor-scratch.js";
import type { SupervisorAfterAgentDeps } from "./supervisor-after-agent-deps.js";
import type { SupervisorChanges } from "./supervisor-change-detection.js";
import { routeSupervisorVerdict } from "./supervisor-verdict-routing.js";

function makePayload(checks: PrFeedbackPayload["checks"]): PrFeedbackPayload {
  return {
    prId: 100, branch: "ai/tasks/T-100", baseBranch: "develop", prType: "task",
    newFeedback: "", fullThread: "", botAttempts: 0, oldestFreshAt: "",
    checks, respondedIds: [], ciAttempts: 0, maxCiRetryAttempts: 3,
    reviewThreads: [], freshReviewCommentIds: [],
  };
}

function makeScratch(): PrFeedbackSupervisorScratch {
  return {
    prId: 100, branch: "ai/tasks/T-100", prType: "task",
    reviewAttempts: 0, maxAttempts: 20, limitReached: false,
    threadFile: "", newFeedback: "", checksContextFile: "", preAgentHeadSha: "sha-pre",
  };
}

function makeApplied(verdict: AopApplyResult["verdict"]): AopApplyResult {
  return {
    verdict,
    summary: "applier summary",
    applyErrors: [],
    applied: { childItems: [], statusUpdates: [], bodyUpdates: [] },
    commentReplies: [],
  };
}

function makeChanges(changesApplied: boolean): SupervisorChanges {
  return {
    workspaceDirty: changesApplied,
    headAdvanced: false,
    changesApplied,
    postAgentHeadSha: "sha-post",
  };
}

function makeAgentResult(verdict: AgentResult["verdict"]): AgentResult {
  return { verdict, summary: "agent summary", output: "", attempts: 1 } as AgentResult;
}

function makeDeps(): SupervisorAfterAgentDeps {
  return {
    prManager: { postBotComment: vi.fn().mockResolvedValue(undefined) } as never,
    git: {} as never,
    kindRegistry: { all: [] } as never,
    workItemSource: {} as never,
    agentEventStream: {} as never,
    log: { info: vi.fn() } as never,
  };
}

const stage = { name: "pr-review" } as StageDef;
const attribution = { responded: new Set<string>() } as BotAttribution;

describe("routeSupervisorVerdict", () => {
  it("downgrades failed verdict to approved when fix was pushed over stale failing CI", async () => {
    const deps = makeDeps();
    const payload = makePayload({
      value: "failing", observedAt: "2026-06-26T00:00:00Z",
      headSha: "abc123def456", checks: [],
    });
    const result = await routeSupervisorVerdict(
      deps, stage, payload, makeScratch(),
      makeAgentResult("failed"), makeApplied("approved"),
      makeChanges(true), attribution, true,
    );
    expect(result).toMatchObject({ verdictOverride: "approved" });
    expect(deps.prManager.postBotComment).toHaveBeenCalledWith(
      100, expect.stringContaining("pushed fix supersedes"), attribution,
    );
  });

  it("does not override approved verdict when CI is failing but no changes were pushed", async () => {
    const deps = makeDeps();
    const payload = makePayload({
      value: "failing", observedAt: "2026-06-26T00:00:00Z",
      headSha: "abc123", checks: [],
    });
    const result = await routeSupervisorVerdict(
      deps, stage, payload, makeScratch(),
      makeAgentResult("approved"), makeApplied("approved"),
      makeChanges(false), attribution, true,
    );
    expect(result?.verdictOverride).toBeUndefined();
    expect(deps.prManager.postBotComment).toHaveBeenCalledWith(
      100, expect.stringContaining("No code changes"), attribution,
    );
  });

  it("posts terminal comment for non-approved applier verdict", async () => {
    const deps = makeDeps();
    const result = await routeSupervisorVerdict(
      deps, stage, makePayload({ value: "passing", observedAt: "", checks: [] }),
      makeScratch(), makeAgentResult("approved"), makeApplied("cancelled"),
      makeChanges(false), attribution, false,
    );
    expect(result).toMatchObject({ verdictOverride: "cancelled" });
    expect(deps.prManager.postBotComment).toHaveBeenCalledWith(
      100, expect.stringContaining("Supervisor decision"), attribution,
    );
  });
});
