import { describe, it, expect, vi } from "vitest";
import type { WorkspaceGit } from "../../../infra/git.js";
import type { StageDef } from "../../types.js";
import type { PrFeedbackPayload } from "../../primitives/pr-feedback-selector.js";
import type { PrFeedbackSupervisorScratch } from "./supervisor-scratch.js";
import { detectSupervisorChanges } from "./supervisor-change-detection.js";

function makeScratch(preAgentHeadSha: string): PrFeedbackSupervisorScratch {
  return {
    prId: 1, branch: "ai/tasks/T-1", prType: "task",
    reviewAttempts: 0, maxAttempts: 20, limitReached: false,
    threadFile: "", newFeedback: "", checksContextFile: "",
    preAgentHeadSha,
  };
}

function makePayload(): PrFeedbackPayload {
  return {
    prId: 1, branch: "ai/tasks/T-1", baseBranch: "develop", prType: "task",
    newFeedback: "", fullThread: "", botAttempts: 0, oldestFreshAt: "",
    checks: { value: "passing", observedAt: "", checks: [] },
    respondedIds: [], ciAttempts: 0, maxCiRetryAttempts: 3,
    reviewThreads: [], freshReviewCommentIds: [],
  };
}

const stage = { name: "pr-review" } as StageDef;

describe("detectSupervisorChanges", () => {
  it("reports changesApplied when workspace is dirty", async () => {
    const git = {
      isClean: vi.fn().mockResolvedValue(false),
      headSha: vi.fn().mockResolvedValue("sha-same"),
    } as unknown as WorkspaceGit;
    const result = await detectSupervisorChanges(git, makeScratch("sha-same"), stage, makePayload());
    expect(result).toMatchObject({
      workspaceDirty: true,
      headAdvanced: false,
      changesApplied: true,
      postAgentHeadSha: "sha-same",
    });
  });

  it("reports headAdvanced when post-agent SHA differs from pre-agent anchor", async () => {
    const git = {
      isClean: vi.fn().mockResolvedValue(true),
      headSha: vi.fn().mockResolvedValue("sha-post"),
    } as unknown as WorkspaceGit;
    const result = await detectSupervisorChanges(git, makeScratch("sha-pre"), stage, makePayload());
    expect(result).toMatchObject({
      workspaceDirty: false,
      headAdvanced: true,
      changesApplied: true,
      postAgentHeadSha: "sha-post",
    });
  });

  it("falls back to dirty-only check when headSha() throws", async () => {
    const log = { warn: vi.fn() };
    const git = {
      isClean: vi.fn().mockResolvedValue(true),
      headSha: vi.fn().mockRejectedValue(new Error("git unavailable")),
    } as unknown as WorkspaceGit;
    const result = await detectSupervisorChanges(
      git, makeScratch("sha-pre"), stage, makePayload(), log as never,
    );
    expect(result).toMatchObject({
      workspaceDirty: false,
      headAdvanced: false,
      changesApplied: false,
      postAgentHeadSha: "",
    });
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining("falling back to dirty-only check"),
      expect.any(Object),
    );
  });
});
