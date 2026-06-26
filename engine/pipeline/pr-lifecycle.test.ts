import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  CodeReview, ConventionsConfig, KindRegistry, KindDefinition,
} from "@operator/core";
import { runPrLifecycle, type PrLifecycleDeps } from "./pr-lifecycle.js";

const HOUR_MS = 60 * 60 * 1000;

const CONVENTIONS: ConventionsConfig = {
  labels: {
    pending: "ai:pending",
    processing: "ai:processing",
    inReview: "ai:in-review",
    readyToMerge: "ai:ready-to-merge",
    failed: "ai:failed",
  },
  branches: {
    aiPrefix: "ai", init: "ai/init", tasks: "ai/tasks",
    findings: "ai/findings", research: "ai/research", improver: "ai/improver",
  },
  prPrefixes: {
    task: "[AI:Task]", finding: "[AI:Finding]", research: "[AI:Research]",
    improver: "[AI:Improver]", init: "[AI:Init]",
  },
  patterns: { taskId: "T[0-9]{8}-[0-9]{6}", findingPrefix: "F" },
  commentMarker: "<!-- bot:operator -->",
};

function makePR(overrides: Partial<CodeReview>): CodeReview {
  return {
    id: 1, title: "PR", url: "https://example.com/pr/1",
    branch: "ai/findings/F20260101-0001", baseBranch: "develop",
    draft: false, labels: [], comments: [],
    merged: false, closed: false,
    updatedAt: new Date(Date.now() - 2 * HOUR_MS).toISOString(),
    ...overrides,
  };
}

function labelsOf(...names: string[]): CodeReview["labels"] {
  return names.map((name) => ({ name }));
}

function makeKindRegistry(): KindRegistry {
  const findings: KindDefinition = {
    name: "finding", label: "Finding", idPrefix: "F",
    dataDir: ".operator/data/findings", branchPrefix: "ai/findings",
    prPrefix: "[AI:Finding]",
    nonTerminalStatuses: ["pending", "in-progress", "reopened"],
    terminalStatuses: ["completed", "failed", "cancelled", "rejected", "duplicate"],
  } as KindDefinition;
  return {
    all: [findings],
    get: (name) => (name === "finding" ? findings : undefined),
    isTerminal: (_kind, status) => ["completed", "failed", "cancelled", "rejected", "duplicate"].includes(status),
  };
}

function makeDeps(overrides: Partial<PrLifecycleDeps>): PrLifecycleDeps {
  const prManager = {
    markReadyToMerge: vi.fn().mockResolvedValue(undefined),
    markInReview: vi.fn().mockResolvedValue(undefined),
    markFailed: vi.fn().mockResolvedValue(undefined),
    postBotComment: vi.fn().mockResolvedValue(undefined),
  };
  const vcs = {
    getCodeReviews: vi.fn().mockResolvedValue([]),
    closeCodeReview: vi.fn().mockResolvedValue(undefined),
    mergeCodeReview: vi.fn().mockResolvedValue(true),
    getComments: vi.fn().mockResolvedValue([]),
    getReviewComments: vi.fn().mockResolvedValue([]),
    getCheckRuns: vi.fn().mockResolvedValue([]),
    getJobLogTail: vi.fn().mockResolvedValue(undefined),
    reRunFailedChecks: vi.fn().mockResolvedValue(true),
  };
  return {
    vcs: vcs as never,
    prManager: prManager as never,
    conventions: CONVENTIONS,
    lifecycle: {
      promoteToReadyAfterIdleHours: 1,
      autoMergeReadyAfterHours: null,
      autoCloseStuckAfterHours: null,
    },
    ...overrides,
  };
}

describe("runPrLifecycle", () => {
  it("promotes ai:in-review → ai:ready-to-merge after idle threshold", async () => {
    const pr = makePR({
      id: 100,
      labels: labelsOf("ai:in-review"),
      updatedAt: new Date(Date.now() - 2 * HOUR_MS).toISOString(),
    });
    const deps = makeDeps({});
    (deps.vcs.getCodeReviews as ReturnType<typeof vi.fn>).mockResolvedValue([pr]);

    const result = await runPrLifecycle(deps);

    expect(result.promoted).toBe(1);
    expect(result.merged).toBe(0);
    expect(result.closed).toBe(0);
    expect(deps.prManager.markReadyToMerge).toHaveBeenCalledWith(100);
  });

  it("does not promote ai:in-review when idle is below threshold", async () => {
    const pr = makePR({
      id: 101,
      labels: labelsOf("ai:in-review"),
      updatedAt: new Date(Date.now() - 0.5 * HOUR_MS).toISOString(),
    });
    const deps = makeDeps({});
    (deps.vcs.getCodeReviews as ReturnType<typeof vi.fn>).mockResolvedValue([pr]);

    const result = await runPrLifecycle(deps);

    expect(result.promoted).toBe(0);
    expect(result.skipped).toBe(1);
    expect(deps.prManager.markReadyToMerge).not.toHaveBeenCalled();
  });

  it("merges ai:ready-to-merge after autoMergeReadyAfterHours", async () => {
    const pr = makePR({
      id: 102,
      labels: labelsOf("ai:ready-to-merge"),
      updatedAt: new Date(Date.now() - 5 * HOUR_MS).toISOString(),
    });
    const deps = makeDeps({
      lifecycle: {
        promoteToReadyAfterIdleHours: 1,
        autoMergeReadyAfterHours: 4,
        autoCloseStuckAfterHours: null,
      },
    });
    (deps.vcs.getCodeReviews as ReturnType<typeof vi.fn>).mockResolvedValue([pr]);

    const result = await runPrLifecycle(deps);

    expect(result.merged).toBe(1);
    expect(deps.vcs.mergeCodeReview).toHaveBeenCalledWith(102);
  });

  it("counts a refused merge as skipped, not merged", async () => {
    const pr = makePR({
      id: 103,
      labels: labelsOf("ai:ready-to-merge"),
      updatedAt: new Date(Date.now() - 5 * HOUR_MS).toISOString(),
    });
    const deps = makeDeps({
      lifecycle: {
        promoteToReadyAfterIdleHours: 1,
        autoMergeReadyAfterHours: 4,
        autoCloseStuckAfterHours: null,
      },
    });
    (deps.vcs.getCodeReviews as ReturnType<typeof vi.fn>).mockResolvedValue([pr]);
    (deps.vcs.mergeCodeReview as ReturnType<typeof vi.fn>).mockResolvedValue(false);

    const result = await runPrLifecycle(deps);

    expect(result.merged).toBe(0);
    expect(result.skipped).toBe(1);
  });

  it("closes stuck PRs after autoCloseStuckAfterHours", async () => {
    const pr = makePR({
      id: 104,
      labels: labelsOf("ai:processing"),
      updatedAt: new Date(Date.now() - 200 * HOUR_MS).toISOString(),
    });
    const deps = makeDeps({
      lifecycle: {
        promoteToReadyAfterIdleHours: 1,
        autoMergeReadyAfterHours: null,
        autoCloseStuckAfterHours: 168,
      },
    });
    (deps.vcs.getCodeReviews as ReturnType<typeof vi.fn>).mockResolvedValue([pr]);

    const result = await runPrLifecycle(deps);

    expect(result.closed).toBe(1);
    expect(deps.vcs.closeCodeReview).toHaveBeenCalledWith(104);
  });

  it("skips when promoteToReadyAfterIdleHours is null", async () => {
    const pr = makePR({
      id: 105,
      labels: labelsOf("ai:in-review"),
      updatedAt: new Date(Date.now() - 100 * HOUR_MS).toISOString(),
    });
    const deps = makeDeps({
      lifecycle: {
        promoteToReadyAfterIdleHours: null,
        autoMergeReadyAfterHours: null,
        autoCloseStuckAfterHours: null,
      },
    });
    (deps.vcs.getCodeReviews as ReturnType<typeof vi.fn>).mockResolvedValue([pr]);

    const result = await runPrLifecycle(deps);

    expect(result.promoted).toBe(0);
    expect(deps.prManager.markReadyToMerge).not.toHaveBeenCalled();
  });

  it("ignores draft PRs and non-AI branches", async () => {
    const draftPR = makePR({ id: 200, draft: true, labels: labelsOf("ai:in-review") });
    const nonAi = makePR({ id: 201, branch: "feature/manual-fix", labels: [] });
    const deps = makeDeps({});
    (deps.vcs.getCodeReviews as ReturnType<typeof vi.fn>).mockResolvedValue([draftPR, nonAi]);

    const result = await runPrLifecycle(deps);

    expect(result.promoted).toBe(0);
    expect(result.skipped).toBe(0);
    expect(deps.prManager.markReadyToMerge).not.toHaveBeenCalled();
  });

  it("falls back to skip when platform has no mergeCodeReview", async () => {
    const pr = makePR({
      id: 300,
      labels: labelsOf("ai:ready-to-merge"),
      updatedAt: new Date(Date.now() - 5 * HOUR_MS).toISOString(),
    });
    const deps = makeDeps({
      lifecycle: {
        promoteToReadyAfterIdleHours: 1,
        autoMergeReadyAfterHours: 4,
        autoCloseStuckAfterHours: null,
      },
    });
    (deps.vcs.getCodeReviews as ReturnType<typeof vi.fn>).mockResolvedValue([pr]);
    delete (deps.vcs as { mergeCodeReview?: unknown }).mergeCodeReview;

    const result = await runPrLifecycle(deps);

    expect(result.merged).toBe(0);
    expect(result.skipped).toBe(1);
  });

  describe("per-work-item overrides", () => {
    let workspacePath: string;

    beforeEach(async () => {
      workspacePath = await mkdtemp(join(tmpdir(), "pr-lifecycle-test-"));
    });

    afterEach(async () => {
      await rm(workspacePath, { recursive: true, force: true });
    });

    it("respects lifecycle_promote_to_ready_after_idle_hours from frontmatter", async () => {
      const findingsDir = join(workspacePath, ".operator", "data", "findings");
      await mkdir(findingsDir, { recursive: true });
      await writeFile(
        join(findingsDir, "F20260101-0001.md"),
        [
          "---",
          "id: F20260101-0001",
          "title: \"x\"",
          "kind: finding",
          "priority: 5",
          "status: pending",
          "lifecycle_promote_to_ready_after_idle_hours: 24",
          "---",
          "",
          "Body",
          "",
        ].join("\n"),
      );

      const pr = makePR({
        id: 400,
        labels: labelsOf("ai:in-review"),
        updatedAt: new Date(Date.now() - 2 * HOUR_MS).toISOString(),
      });
      const deps = makeDeps({
        workspacePath,
        kindRegistry: makeKindRegistry(),
        lifecycle: {
          promoteToReadyAfterIdleHours: 1,
          autoMergeReadyAfterHours: null,
          autoCloseStuckAfterHours: null,
        },
      });
      (deps.vcs.getCodeReviews as ReturnType<typeof vi.fn>).mockResolvedValue([pr]);

      const result = await runPrLifecycle(deps);

      // System default fires at 1h, but item override raised it to 24h.
      expect(result.promoted).toBe(0);
      expect(result.skipped).toBe(1);
    });

    it("disables promote when item override is null", async () => {
      const findingsDir = join(workspacePath, ".operator", "data", "findings");
      await mkdir(findingsDir, { recursive: true });
      await writeFile(
        join(findingsDir, "F20260101-0001.md"),
        [
          "---",
          "id: F20260101-0001",
          "title: \"x\"",
          "kind: finding",
          "priority: 5",
          "status: pending",
          "lifecycle_promote_to_ready_after_idle_hours: null",
          "---",
          "",
          "Body",
          "",
        ].join("\n"),
      );

      const pr = makePR({
        id: 401,
        labels: labelsOf("ai:in-review"),
        updatedAt: new Date(Date.now() - 100 * HOUR_MS).toISOString(),
      });
      const deps = makeDeps({
        workspacePath,
        kindRegistry: makeKindRegistry(),
      });
      (deps.vcs.getCodeReviews as ReturnType<typeof vi.fn>).mockResolvedValue([pr]);

      const result = await runPrLifecycle(deps);

      expect(result.promoted).toBe(0);
      expect(deps.prManager.markReadyToMerge).not.toHaveBeenCalled();
    });
  });

  it("does nothing when no AI PRs are open", async () => {
    const deps = makeDeps({});
    const result = await runPrLifecycle(deps);
    expect(result).toEqual({ promoted: 0, merged: 0, closed: 0, skipped: 0, reran: 0 });
  });

  it("defers promote when there is fresh user feedback since last bot reply", async () => {
    const pr = makePR({
      id: 793,
      labels: labelsOf("ai:in-review"),
      updatedAt: new Date(Date.now() - 5 * HOUR_MS).toISOString(),
    });
    const deps = makeDeps({});
    (deps.vcs.getCodeReviews as ReturnType<typeof vi.fn>).mockResolvedValue([pr]);
    (deps.vcs.getComments as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        id: "c1", author: "owner", authorAssociation: "OWNER", authorType: "User",
        body: "Russian text not allowed", createdAt: new Date(Date.now() - 1 * HOUR_MS).toISOString(),
      },
    ]);

    const result = await runPrLifecycle(deps);

    expect(result.promoted).toBe(0);
    expect(result.skipped).toBe(1);
    expect(deps.prManager.markReadyToMerge).not.toHaveBeenCalled();
  });

  it("defers auto-merge when there is fresh user feedback", async () => {
    const pr = makePR({
      id: 794,
      labels: labelsOf("ai:ready-to-merge"),
      updatedAt: new Date(Date.now() - 10 * HOUR_MS).toISOString(),
    });
    const deps = makeDeps({
      lifecycle: {
        promoteToReadyAfterIdleHours: 1,
        autoMergeReadyAfterHours: 4,
        autoCloseStuckAfterHours: null,
      },
    });
    (deps.vcs.getCodeReviews as ReturnType<typeof vi.fn>).mockResolvedValue([pr]);
    (deps.vcs.getComments as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        id: "c1", author: "owner", authorAssociation: "OWNER", authorType: "User",
        body: "Wait, please revisit", createdAt: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
      },
    ]);

    const result = await runPrLifecycle(deps);

    expect(result.merged).toBe(0);
    expect(result.skipped).toBe(1);
    expect(deps.vcs.mergeCodeReview).not.toHaveBeenCalled();
  });

  it("defers promote when CI has failing checks (PR #812 incident gate)", async () => {
    const pr = makePR({
      id: 812,
      labels: labelsOf("ai:in-review"),
      updatedAt: new Date(Date.now() - 5 * HOUR_MS).toISOString(),
    });
    const deps = makeDeps({});
    (deps.vcs.getCodeReviews as ReturnType<typeof vi.fn>).mockResolvedValue([pr]);
    (deps.vcs.getCheckRuns as ReturnType<typeof vi.fn>).mockResolvedValue([
      { name: "frontend-e2e", conclusion: "failure" },
      { name: "lint", conclusion: "success" },
    ]);

    const result = await runPrLifecycle(deps);

    expect(result.promoted).toBe(0);
    expect(result.skipped).toBe(1);
    expect(deps.prManager.markReadyToMerge).not.toHaveBeenCalled();
  });

  it("defers promote when CI is still pending (in_progress / queued)", async () => {
    const pr = makePR({
      id: 813,
      labels: labelsOf("ai:in-review"),
      updatedAt: new Date(Date.now() - 5 * HOUR_MS).toISOString(),
    });
    const deps = makeDeps({});
    (deps.vcs.getCodeReviews as ReturnType<typeof vi.fn>).mockResolvedValue([pr]);
    (deps.vcs.getCheckRuns as ReturnType<typeof vi.fn>).mockResolvedValue([
      { name: "build", conclusion: "in_progress" },
    ]);

    const result = await runPrLifecycle(deps);

    expect(result.promoted).toBe(0);
    expect(result.skipped).toBe(1);
  });

  it("escalates to ai:failed when CI retry budget is exhausted on the same head SHA", async () => {
    const HEAD = "abc12345";
    const exhaustedFooter = "<!-- bot:operator/attribution\nci-head: " + HEAD + "\nci-attempt: 3/3\n-->";
    const pr = makePR({
      id: 815,
      labels: labelsOf("ai:in-review"),
      updatedAt: new Date(Date.now() - 5 * HOUR_MS).toISOString(),
    });
    const deps = makeDeps({});
    (deps.vcs.getCodeReviews as ReturnType<typeof vi.fn>).mockResolvedValue([pr]);
    (deps.vcs.getCheckRuns as ReturnType<typeof vi.fn>).mockResolvedValue([
      { name: "e2e", conclusion: "failure", headSha: HEAD, completedAt: "2026-05-01T10:00:00Z" },
    ]);
    (deps.vcs.getComments as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: "b1", author: "bot", body: `<!-- bot:operator -->\non head\n\n${exhaustedFooter}`, createdAt: "2026-05-01T11:00:00Z" },
    ]);
    deps.prManager.postBotComment = vi.fn().mockResolvedValue(undefined);

    const result = await runPrLifecycle(deps);

    expect(deps.prManager.markFailed).toHaveBeenCalledWith(815);
    expect(deps.prManager.postBotComment).toHaveBeenCalledWith(
      815,
      expect.stringContaining("CI retry budget exhausted"),
      expect.objectContaining({ ciAttempt: { current: 3, max: 3 } }),
    );
    // markFailed path counts as "closed" in the result tally.
    expect(result.closed).toBe(1);
    expect(deps.prManager.markReadyToMerge).not.toHaveBeenCalled();
  });

  it("does not escalate when head SHA differs from the footer's recorded ci-head (new code pushed)", async () => {
    const exhaustedFooter = "<!-- bot:operator/attribution\nci-head: oldhead00\nci-attempt: 3/3\n-->";
    const pr = makePR({
      id: 816,
      labels: labelsOf("ai:in-review"),
      updatedAt: new Date(Date.now() - 5 * HOUR_MS).toISOString(),
    });
    const deps = makeDeps({});
    (deps.vcs.getCodeReviews as ReturnType<typeof vi.fn>).mockResolvedValue([pr]);
    (deps.vcs.getCheckRuns as ReturnType<typeof vi.fn>).mockResolvedValue([
      { name: "e2e", conclusion: "failure", headSha: "newhead11", completedAt: "2026-05-02T10:00:00Z" },
    ]);
    (deps.vcs.getComments as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: "b1", author: "bot", body: `<!-- bot:operator -->\non old head\n\n${exhaustedFooter}`, createdAt: "2026-05-01T11:00:00Z" },
    ]);

    const result = await runPrLifecycle(deps);

    // Different head SHA → counter reset → defer to normal CI gate (which
    // skips because checks are failing) but does NOT markFailed.
    expect(deps.prManager.markFailed).not.toHaveBeenCalled();
    expect(result.skipped).toBe(1);
  });

  it("re-runs the pipeline (not the agent) for a transient CI failure with budget left", async () => {
    const HEAD = "abc12345";
    const pr = makePR({
      id: 820,
      labels: labelsOf("ai:in-review"),
      updatedAt: new Date(Date.now() - 5 * HOUR_MS).toISOString(),
    });
    const deps = makeDeps({});
    (deps.vcs.getCodeReviews as ReturnType<typeof vi.fn>).mockResolvedValue([pr]);
    (deps.vcs.getCheckRuns as ReturnType<typeof vi.fn>).mockResolvedValue([
      { name: "Deploy PR Environment", conclusion: "failure", headSha: HEAD, jobId: 111 },
    ]);
    (deps.vcs.getJobLogTail as ReturnType<typeof vi.fn>).mockResolvedValue(
      "RUN npm ci --include=dev\nnpm error code ECONNRESET\nnpm error network aborted",
    );

    const result = await runPrLifecycle(deps);

    expect(deps.vcs.reRunFailedChecks).toHaveBeenCalledWith(820);
    expect(deps.prManager.postBotComment).toHaveBeenCalledWith(
      820,
      expect.stringContaining("Transient CI failure"),
      expect.objectContaining({ ciHead: HEAD, ciRerun: { current: 1, max: 2 } }),
    );
    expect(result.reran).toBe(1);
    expect(deps.prManager.markFailed).not.toHaveBeenCalled();
    expect(deps.prManager.markReadyToMerge).not.toHaveBeenCalled();
  });

  it("still advances the re-run budget when the platform refuses to re-run (forward progress)", async () => {
    const HEAD = "abc12345";
    const pr = makePR({
      id: 822,
      labels: labelsOf("ai:in-review"),
      updatedAt: new Date(Date.now() - 5 * HOUR_MS).toISOString(),
    });
    const deps = makeDeps({});
    (deps.vcs.getCodeReviews as ReturnType<typeof vi.fn>).mockResolvedValue([pr]);
    (deps.vcs.getCheckRuns as ReturnType<typeof vi.fn>).mockResolvedValue([
      { name: "Deploy", conclusion: "failure", headSha: HEAD, jobId: 111 },
    ]);
    (deps.vcs.getJobLogTail as ReturnType<typeof vi.fn>).mockResolvedValue("npm error code ECONNRESET");
    (deps.vcs.reRunFailedChecks as ReturnType<typeof vi.fn>).mockResolvedValue(false);

    const result = await runPrLifecycle(deps);

    expect(result.reran).toBe(1);
    expect(deps.prManager.postBotComment).toHaveBeenCalledWith(
      822,
      expect.stringContaining("Could not re-run"),
      expect.objectContaining({ ciRerun: { current: 1, max: 2 } }),
    );
  });

  it("stops re-running a transient failure once the re-run budget is spent and escalates via the agent path", async () => {
    const HEAD = "abc12345";
    const spentFooter = "<!-- bot:operator/attribution\nci-head: " + HEAD + "\nci-rerun: 2/2\n-->";
    const pr = makePR({
      id: 821,
      labels: labelsOf("ai:in-review"),
      updatedAt: new Date(Date.now() - 5 * HOUR_MS).toISOString(),
    });
    const deps = makeDeps({});
    (deps.vcs.getCodeReviews as ReturnType<typeof vi.fn>).mockResolvedValue([pr]);
    (deps.vcs.getCheckRuns as ReturnType<typeof vi.fn>).mockResolvedValue([
      { name: "Deploy PR Environment", conclusion: "failure", headSha: HEAD, jobId: 111 },
    ]);
    (deps.vcs.getJobLogTail as ReturnType<typeof vi.fn>).mockResolvedValue("npm error code ECONNRESET");
    (deps.vcs.getComments as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: "b1", author: "bot", body: `<!-- bot:operator -->\nre-ran\n\n${spentFooter}`, createdAt: "2026-05-01T11:00:00Z" },
    ]);

    const result = await runPrLifecycle(deps);

    expect(deps.vcs.reRunFailedChecks).not.toHaveBeenCalled();
    expect(result.reran).toBe(0);
    expect(result.skipped).toBe(1);
  });

  it("defers auto-merge when CI is failing", async () => {
    const pr = makePR({
      id: 814,
      labels: labelsOf("ai:ready-to-merge"),
      updatedAt: new Date(Date.now() - 10 * HOUR_MS).toISOString(),
    });
    const deps = makeDeps({
      lifecycle: {
        promoteToReadyAfterIdleHours: 1,
        autoMergeReadyAfterHours: 4,
        autoCloseStuckAfterHours: null,
      },
    });
    (deps.vcs.getCodeReviews as ReturnType<typeof vi.fn>).mockResolvedValue([pr]);
    (deps.vcs.getCheckRuns as ReturnType<typeof vi.fn>).mockResolvedValue([
      { name: "build", conclusion: "failure" },
    ]);

    const result = await runPrLifecycle(deps);

    expect(result.merged).toBe(0);
    expect(result.skipped).toBe(1);
    expect(deps.vcs.mergeCodeReview).not.toHaveBeenCalled();
  });
});

