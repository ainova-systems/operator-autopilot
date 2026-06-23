import { describe, it, expect, vi } from "vitest";
import type { OperationContext, KVStore, KVEntry, ExecutionEntry, VCSPlatform, CodeReview, ConventionsConfig } from "@operator/core";
import { reconcileStuckExecutions, revertOrphanProcessingLabels } from "./execution-reconcile.js";

function makeCtx(): OperationContext {
  return {
    traceId: "trace-1",
    repoId: "sample",
    action: "reconcile",
    budget: { spentUsd: 0, add: () => {}, isExceeded: () => false },
    signal: AbortSignal.timeout(10_000),
  };
}

interface FakeKV {
  readonly rows: Map<string, { value: unknown; metadata?: unknown }>;
  readonly kv: Pick<KVStore, "list" | "put">;
  readonly put: ReturnType<typeof vi.fn>;
}

function makeFakeKV(seed: Record<string, ExecutionEntry>): FakeKV {
  const rows = new Map<string, { value: unknown; metadata?: unknown }>();
  for (const [k, v] of Object.entries(seed)) {
    rows.set(k, { value: v, metadata: { source: "content", readonly: false } });
  }
  const put = vi.fn(async (category: string, key: string, value: unknown, opts?: { metadata?: unknown }) => {
    if (category !== "executions") throw new Error(`unexpected category ${category}`);
    rows.set(key, { value, metadata: opts?.metadata });
  });
  const kv = {
    list: async (category: string): Promise<KVEntry[]> => {
      if (category !== "executions") return [];
      return [...rows.entries()].map(([key, entry]) => ({
        key, value: entry.value, metadata: entry.metadata as KVEntry["metadata"],
      }));
    },
    put,
  } as unknown as Pick<KVStore, "list" | "put">;
  return { rows, kv: kv, put };
}

const NOW_MS = Date.parse("2026-04-24T20:00:00Z");
const THREE_HOURS_AGO = new Date(NOW_MS - 3 * 60 * 60 * 1000).toISOString();
const ONE_HOUR_AGO = new Date(NOW_MS - 60 * 60 * 1000).toISOString();

function runningEntry(id: string, startedAt: string): ExecutionEntry {
  return {
    id, traceId: "t", repoId: "sample", stageName: "task-execute",
    workItemId: "T1", startedAt, status: "running",
  };
}

describe("reconcileStuckExecutions", () => {
  it("finalises a running row older than the threshold as timed-out", async () => {
    const fake = makeFakeKV({
      "task-execute-run-1": runningEntry("task-execute-run-1", THREE_HOURS_AGO),
    });

    const result = await reconcileStuckExecutions(
      fake.kv as KVStore,
      { now: () => NOW_MS },
      makeCtx(),
    );

    expect(result).toEqual({ scanned: 1, reconciled: 1, skipped: 0 });
    const updated = fake.rows.get("task-execute-run-1")!.value as ExecutionEntry;
    expect(updated.status).toBe("timed-out");
    expect(updated.finishedAt).toBe("2026-04-24T20:00:00.000Z");
    expect(updated.durationMs).toBe(3 * 60 * 60 * 1000);
    expect(updated.verdict).toBe("failed");
    expect(updated.summary).toMatch(/timed out/);
    expect(updated.error).toBe("stuck-execution-auto-timeout");
  });

  it("leaves a recent running row untouched", async () => {
    const fake = makeFakeKV({
      "task-execute-run-fresh": runningEntry("task-execute-run-fresh", ONE_HOUR_AGO),
    });

    const result = await reconcileStuckExecutions(
      fake.kv as KVStore,
      { now: () => NOW_MS },
      makeCtx(),
    );

    expect(result).toEqual({ scanned: 1, reconciled: 0, skipped: 0 });
    expect(fake.put).not.toHaveBeenCalled();
    const untouched = fake.rows.get("task-execute-run-fresh")!.value as ExecutionEntry;
    expect(untouched.status).toBe("running");
  });

  it("ignores rows that are already finalised", async () => {
    const completed: ExecutionEntry = {
      id: "done", traceId: "t", repoId: "sample", stageName: "research",
      startedAt: THREE_HOURS_AGO, finishedAt: ONE_HOUR_AGO,
      status: "completed", verdict: "approved",
    };
    const fake = makeFakeKV({ done: completed });

    const result = await reconcileStuckExecutions(
      fake.kv as KVStore,
      { now: () => NOW_MS },
      makeCtx(),
    );

    expect(result.reconciled).toBe(0);
    expect(fake.put).not.toHaveBeenCalled();
  });

  it("respects a custom threshold", async () => {
    const fake = makeFakeKV({
      "short-stuck": runningEntry("short-stuck", ONE_HOUR_AGO),
    });

    const result = await reconcileStuckExecutions(
      fake.kv as KVStore,
      { now: () => NOW_MS, stuckAfterMs: 30 * 60 * 1000 }, // 30 minutes
      makeCtx(),
    );

    expect(result.reconciled).toBe(1);
    expect((fake.rows.get("short-stuck")!.value as ExecutionEntry).status).toBe("timed-out");
  });

  it("preserves existing verdict and summary when present on stuck row", async () => {
    const partial: ExecutionEntry = {
      id: "p", traceId: "t", repoId: "sample", stageName: "task-execute",
      startedAt: THREE_HOURS_AGO, status: "running",
      verdict: "approved", summary: "partial summary captured before crash",
    };
    const fake = makeFakeKV({ p: partial });

    await reconcileStuckExecutions(fake.kv as KVStore, { now: () => NOW_MS }, makeCtx());

    const updated = fake.rows.get("p")!.value as ExecutionEntry;
    expect(updated.verdict).toBe("approved");
    expect(updated.summary).toBe("partial summary captured before crash");
    expect(updated.status).toBe("timed-out");
    expect(updated.error).toBe("stuck-execution-auto-timeout");
  });

  it("skips rows with unparseable startedAt", async () => {
    const broken: ExecutionEntry = {
      id: "broken", traceId: "t", repoId: "sample", stageName: "x",
      startedAt: "not-a-date", status: "running",
    };
    const fake = makeFakeKV({ broken });

    const result = await reconcileStuckExecutions(
      fake.kv as KVStore,
      { now: () => NOW_MS },
      makeCtx(),
    );

    expect(result).toEqual({ scanned: 1, reconciled: 0, skipped: 1 });
    expect((fake.rows.get("broken")!.value as ExecutionEntry).status).toBe("running");
  });

  it("handles empty executions category", async () => {
    const fake = makeFakeKV({});
    const result = await reconcileStuckExecutions(fake.kv as KVStore, { now: () => NOW_MS }, makeCtx());
    expect(result).toEqual({ scanned: 0, reconciled: 0, skipped: 0 });
  });
});

const CONVENTIONS: ConventionsConfig = {
  labels: {
    pending: "ai:pending", processing: "ai:processing",
    inReview: "ai:in-review", readyToMerge: "ai:ready-to-merge",
    failed: "ai:failed",
  },
  branches: {
    aiPrefix: "ai", init: "ai/init", tasks: "ai/tasks",
    findings: "ai/findings", research: "ai/research", retrospective: "ai/retrospective",
  },
  prPrefixes: { task: "", finding: "", research: "", improver: "", init: "" },
  patterns: { taskId: "", findingPrefix: "F" },
  commentMarker: "",
};

function makePR(id: number, branch: string, labels: string[]): CodeReview {
  return {
    id, title: "", url: "", branch, baseBranch: "develop",
    labels: labels.map((name) => ({ name })),
    comments: [], draft: true, merged: false, closed: false,
  };
}

function makeFakeVCS(prs: CodeReview[]): Pick<VCSPlatform, "getCodeReviews" | "addLabel" | "removeLabel"> & {
  readonly addLabel: ReturnType<typeof vi.fn>;
  readonly removeLabel: ReturnType<typeof vi.fn>;
} {
  return {
    getCodeReviews: vi.fn(async () => prs),
    addLabel: vi.fn(async () => {}),
    removeLabel: vi.fn(async () => {}),
  };
}

describe("revertOrphanProcessingLabels", () => {
  it("flips orphan ai:processing PRs to ai:pending", async () => {
    const vcs = makeFakeVCS([
      makePR(791, "ai/tasks/T1", ["ai:processing"]),
      makePR(800, "ai/tasks/T2", ["ai:in-review"]),     // not orphan
      makePR(801, "ai/findings/F1", ["ai:processing"]), // also orphan
    ]);

    const result = await revertOrphanProcessingLabels(
      vcs, { conventions: CONVENTIONS }, makeCtx(),
    );

    expect(result).toEqual({ scanned: 2, reverted: 2, errors: 0 });
    expect(vcs.removeLabel).toHaveBeenCalledWith(791, "ai:processing");
    expect(vcs.addLabel).toHaveBeenCalledWith(791, "ai:pending");
    expect(vcs.removeLabel).toHaveBeenCalledWith(801, "ai:processing");
    expect(vcs.addLabel).toHaveBeenCalledWith(801, "ai:pending");
    expect(vcs.removeLabel).not.toHaveBeenCalledWith(800, expect.anything());
  });

  it("ignores PRs whose branch is not under aiPrefix", async () => {
    const vcs = makeFakeVCS([
      makePR(900, "feature/foo", ["ai:processing"]), // human branch with stray label
    ]);

    const result = await revertOrphanProcessingLabels(
      vcs, { conventions: CONVENTIONS }, makeCtx(),
    );

    expect(result).toEqual({ scanned: 0, reverted: 0, errors: 0 });
    expect(vcs.removeLabel).not.toHaveBeenCalled();
  });

  it("returns zero counts when no processing PR exists (idempotent on clean state)", async () => {
    const vcs = makeFakeVCS([
      makePR(800, "ai/tasks/T2", ["ai:pending"]),
      makePR(801, "ai/tasks/T3", ["ai:in-review"]),
    ]);

    const result = await revertOrphanProcessingLabels(
      vcs, { conventions: CONVENTIONS }, makeCtx(),
    );

    expect(result).toEqual({ scanned: 0, reverted: 0, errors: 0 });
    expect(vcs.removeLabel).not.toHaveBeenCalled();
  });
});
