import { describe, it, expect, vi } from "vitest";
import type { VCSPlatform } from "@operator/core";
import type { ConventionsConfig } from "@operator/core";
import { cleanupBranches } from "./cleanup.js";

const CONVENTIONS: ConventionsConfig = {
  labels: { pending: "ai:pending", processing: "ai:processing", inReview: "ai:in-review", readyToMerge: "ai:ready-to-merge", failed: "ai:failed" },
  branches: { aiPrefix: "ai", init: "ai/init", tasks: "ai/tasks", findings: "ai/findings", research: "ai/research", retrospective: "ai/retrospective" },
  prPrefixes: { task: "[AI:Task]", finding: "[AI:Finding]", research: "[AI:Research]", improver: "[AI:Improver]", init: "[AI:Init]" },
  patterns: { taskId: "T{DATE}-{SEQ}", findingPrefix: "F" },
  commentMarker: "<!-- bot:operator -->",
};

function makeVCS(overrides?: Partial<VCSPlatform>): VCSPlatform {
  return {
    id: "github", capabilities: { codeReviews: true, labels: true, branches: true, comments: true, workItems: true, issueHierarchy: false },
    getCodeReviews: vi.fn().mockResolvedValue([]),
    getCodeReview: vi.fn(), createCodeReview: vi.fn(), updateCodeReview: vi.fn(), closeCodeReview: vi.fn(),
    getComments: vi.fn().mockResolvedValue([]), getReviewComments: vi.fn().mockResolvedValue([]), postComment: vi.fn(),
    getLabels: vi.fn().mockResolvedValue([]), addLabel: vi.fn(), removeLabel: vi.fn(),
    createBranch: vi.fn(), deleteBranch: vi.fn().mockResolvedValue(undefined),
    listBranches: vi.fn().mockResolvedValue([]),
    ...overrides,
  };
}

describe("cleanupBranches", () => {
  it("deletes branches for merged PRs", async () => {
    const vcs = makeVCS({
      listBranches: vi.fn().mockResolvedValue(["ai/tasks/T1", "ai/findings/F1"]),
      getCodeReviews: vi.fn().mockResolvedValue([
        { id: 1, branch: "ai/tasks/T1", merged: true, closed: true },
        { id: 2, branch: "ai/findings/F1", merged: false, closed: false },
      ]),
    });

    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn() };
    const deleted = await cleanupBranches(vcs, CONVENTIONS, log as never);

    expect(deleted).toBe(1);
    expect(vcs.deleteBranch).toHaveBeenCalledWith("ai/tasks/T1");
    expect(vcs.deleteBranch).not.toHaveBeenCalledWith("ai/findings/F1");
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining("Deleted branch"));
  });

  it("deletes branches for closed (unmerged) PRs", async () => {
    const vcs = makeVCS({
      listBranches: vi.fn().mockResolvedValue(["ai/tasks/T1"]),
      getCodeReviews: vi.fn().mockResolvedValue([
        { id: 1, branch: "ai/tasks/T1", merged: false, closed: true },
      ]),
    });

    const deleted = await cleanupBranches(vcs, CONVENTIONS);
    expect(deleted).toBe(1);
  });

  it("skips init branch", async () => {
    const vcs = makeVCS({
      listBranches: vi.fn().mockResolvedValue(["ai/init"]),
      getCodeReviews: vi.fn().mockResolvedValue([
        { id: 1, branch: "ai/init", merged: true, closed: true },
      ]),
    });

    const deleted = await cleanupBranches(vcs, CONVENTIONS);
    expect(deleted).toBe(0);
    expect(vcs.deleteBranch).not.toHaveBeenCalled();
  });

  it("skips orphan branches younger than the threshold", async () => {
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const vcs = makeVCS({
      listBranches: vi.fn().mockResolvedValue(["ai/tasks/T-orphan"]),
      getCodeReviews: vi.fn().mockResolvedValue([]),
      getBranchTipCommitTime: vi.fn().mockResolvedValue(oneHourAgo),
    });

    const deleted = await cleanupBranches(vcs, CONVENTIONS);
    expect(deleted).toBe(0);
    expect(vcs.deleteBranch).not.toHaveBeenCalled();
  });

  it("deletes orphan branches older than the 24h threshold", async () => {
    const twoDaysAgo = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    const vcs = makeVCS({
      listBranches: vi.fn().mockResolvedValue(["ai/retrospective/2026W17"]),
      getCodeReviews: vi.fn().mockResolvedValue([]),
      getBranchTipCommitTime: vi.fn().mockResolvedValue(twoDaysAgo),
    });

    const deleted = await cleanupBranches(vcs, CONVENTIONS);
    expect(deleted).toBe(1);
    expect(vcs.deleteBranch).toHaveBeenCalledWith("ai/retrospective/2026W17");
  });

  it("falls back to no-op for orphan branches when adapter cannot expose tip time", async () => {
    const vcs = makeVCS({
      listBranches: vi.fn().mockResolvedValue(["ai/tasks/T-unknown-age"]),
      getCodeReviews: vi.fn().mockResolvedValue([]),
      // getBranchTipCommitTime intentionally absent
    });

    const deleted = await cleanupBranches(vcs, CONVENTIONS);
    expect(deleted).toBe(0);
  });

  it("returns 0 when no branches", async () => {
    const vcs = makeVCS();
    expect(await cleanupBranches(vcs, CONVENTIONS)).toBe(0);
  });

  it("handles deletion failure gracefully", async () => {
    const vcs = makeVCS({
      listBranches: vi.fn().mockResolvedValue(["ai/tasks/T1"]),
      getCodeReviews: vi.fn().mockResolvedValue([
        { id: 1, branch: "ai/tasks/T1", merged: true, closed: true },
      ]),
      deleteBranch: vi.fn().mockRejectedValue(new Error("protected")),
    });

    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn() };
    const deleted = await cleanupBranches(vcs, CONVENTIONS, log as never);
    expect(deleted).toBe(0);
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining("Failed to delete"));
  });
});
