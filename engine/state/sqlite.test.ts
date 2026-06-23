import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OperationContext } from "@operator/core";
import type { WorkItem } from "@operator/core";
import { SQLiteStateManager } from "./sqlite.js";

let tempDir: string;
let manager: SQLiteStateManager;

function makeCtx(overrides?: Partial<OperationContext>): OperationContext {
  return {
    traceId: "trace-1",
    repoId: "test-repo",
    action: "test",
    budget: { spentUsd: 0, add: vi.fn(), isExceeded: () => false },
    signal: AbortSignal.timeout(30_000),
    ...overrides,
  };
}

function makeWorkItem(overrides?: Partial<WorkItem>): WorkItem {
  return {
    id: "T20260319-000101",
    kind: "task",
    title: "Fix bug",
    body: "Details here",
    status: "pending",
    priority: 2,
    source: "F20260319-0001",
    createdAt: "2026-03-19T10:00:00Z",
    updatedAt: "2026-03-19T10:00:00Z",
    ...overrides,
  };
}

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "operator-state-test-"));
  manager = new SQLiteStateManager(join(tempDir, "state.db"));
});

afterEach(() => {
  manager.close();
});

describe("SQLiteStateManager", () => {
  describe("work items", () => {
    it("upserts and retrieves a work item", async () => {
      const ctx = makeCtx();
      const item = makeWorkItem();
      await manager.upsertWorkItem(ctx, item);

      const result = await manager.getWorkItem(ctx, item.id);
      expect(result).not.toBeNull();
      expect(result?.id).toBe(item.id);
      expect(result?.kind).toBe("task");
      expect(result?.status).toBe("pending");
      expect(result?.priority).toBe(2);
      expect(result?.source).toBe("F20260319-0001");
    });

    it("returns null for non-existent work item", async () => {
      const result = await manager.getWorkItem(makeCtx(), "nonexistent");
      expect(result).toBeNull();
    });

    it("updates existing work item on upsert", async () => {
      const ctx = makeCtx();
      const item = makeWorkItem();
      await manager.upsertWorkItem(ctx, item);

      const updated = makeWorkItem({ status: "in-progress", updatedAt: "2026-03-19T11:00:00Z" });
      await manager.upsertWorkItem(ctx, updated);

      const result = await manager.getWorkItem(ctx, item.id);
      expect(result?.status).toBe("in-progress");
    });

    // Regression: 2026-05-20 stale-kind bug. The ON CONFLICT clause used
    // to omit `kind=excluded.kind`, so once a row was inserted with a
    // legacy kind ("analyzer" from the v3 era) every subsequent sync
    // preserved that kind even though the .md file's frontmatter had
    // been rewritten to `kind: finding`. On a real repo this left 87
    // rows pinned at kind=analyzer; the finding-plan selector filters by
    // kind=finding and reported "no finding items in state" while 97
    // finding files sat on develop. Files are source of truth — the DB
    // row MUST follow when frontmatter kind changes.
    it("propagates kind change on upsert (legacy `analyzer` → `finding` regression)", async () => {
      const ctx = makeCtx();
      const original = makeWorkItem({ id: "F20260227-0001", kind: "analyzer" });
      await manager.upsertWorkItem(ctx, original);

      const rewritten = makeWorkItem({
        id: "F20260227-0001", kind: "finding",
        updatedAt: "2026-05-20T00:00:00Z",
      });
      await manager.upsertWorkItem(ctx, rewritten);

      const result = await manager.getWorkItem(ctx, "F20260227-0001");
      expect(result?.kind).toBe("finding");

      // Verify the selector-facing kind filter actually finds it now.
      const findings = await manager.listWorkItems(ctx, { kind: "finding" });
      expect(findings.map((f) => f.id)).toContain("F20260227-0001");
    });

    it("lists work items filtered by kind", async () => {
      const ctx = makeCtx();
      await manager.upsertWorkItem(ctx, makeWorkItem({ id: "T1", kind: "task" }));
      await manager.upsertWorkItem(ctx, makeWorkItem({ id: "F1", kind: "finding" }));

      const tasks = await manager.listWorkItems(ctx, { kind: "task" });
      expect(tasks).toHaveLength(1);
      expect(tasks[0].id).toBe("T1");
    });

    it("lists work items filtered by status", async () => {
      const ctx = makeCtx();
      await manager.upsertWorkItem(ctx, makeWorkItem({ id: "T1", status: "pending" }));
      await manager.upsertWorkItem(ctx, makeWorkItem({ id: "T2", status: "completed" }));
      await manager.upsertWorkItem(ctx, makeWorkItem({ id: "T3", status: "in-progress" }));

      const active = await manager.listWorkItems(ctx, { status: ["pending", "in-progress"] });
      expect(active).toHaveLength(2);
    });

    it("lists work items ordered by priority then created_at", async () => {
      const ctx = makeCtx();
      await manager.upsertWorkItem(ctx, makeWorkItem({ id: "T1", priority: 3, createdAt: "2026-03-19T10:00:00Z" }));
      await manager.upsertWorkItem(ctx, makeWorkItem({ id: "T2", priority: 1, createdAt: "2026-03-19T11:00:00Z" }));
      await manager.upsertWorkItem(ctx, makeWorkItem({ id: "T3", priority: 1, createdAt: "2026-03-19T09:00:00Z" }));

      const all = await manager.listWorkItems(ctx);
      expect(all[0].id).toBe("T3"); // priority 1, earlier
      expect(all[1].id).toBe("T2"); // priority 1, later
      expect(all[2].id).toBe("T1"); // priority 3
    });

    it("respects limit", async () => {
      const ctx = makeCtx();
      await manager.upsertWorkItem(ctx, makeWorkItem({ id: "T1" }));
      await manager.upsertWorkItem(ctx, makeWorkItem({ id: "T2" }));
      await manager.upsertWorkItem(ctx, makeWorkItem({ id: "T3" }));

      const limited = await manager.listWorkItems(ctx, { limit: 2 });
      expect(limited).toHaveLength(2);
    });

    it("updates work item status", async () => {
      const ctx = makeCtx();
      await manager.upsertWorkItem(ctx, makeWorkItem());
      await manager.updateWorkItemStatus(ctx, "T20260319-000101", "completed");

      const result = await manager.getWorkItem(ctx, "T20260319-000101");
      expect(result?.status).toBe("completed");
    });

    it("scopes listWorkItems by repoId", async () => {
      const ctx1 = makeCtx({ repoId: "repo-1" });
      const ctx2 = makeCtx({ repoId: "repo-2" });
      await manager.upsertWorkItem(ctx1, makeWorkItem({ id: "T1" }));
      await manager.upsertWorkItem(ctx2, makeWorkItem({ id: "T2" }));

      const repo1Items = await manager.listWorkItems(ctx1);
      expect(repo1Items).toHaveLength(1);
      expect(repo1Items[0].id).toBe("T1");
    });
  });

  describe("execution log", () => {
    it("appends and lists executions", async () => {
      const ctx = makeCtx();
      await manager.appendExecution(ctx, {
        id: "exec-1",
        traceId: "trace-1",
        pipeline: "task",
        agent: "creator",
        status: "completed",
        startedAt: "2026-03-19T10:00:00Z",
        finishedAt: "2026-03-19T10:05:00Z",
      });

      const execs = await manager.listExecutions(ctx);
      expect(execs).toHaveLength(1);
      expect(execs[0].id).toBe("exec-1");
      expect(execs[0].agent).toBe("creator");
    });

    it("filters executions by date range", async () => {
      const ctx = makeCtx();
      await manager.appendExecution(ctx, {
        id: "e1", traceId: "t1", pipeline: "task", status: "completed",
        startedAt: "2026-03-18T10:00:00Z",
      });
      await manager.appendExecution(ctx, {
        id: "e2", traceId: "t2", pipeline: "task", status: "completed",
        startedAt: "2026-03-19T10:00:00Z",
      });

      const filtered = await manager.listExecutions(ctx, {
        from: "2026-03-19T00:00:00Z",
        to: "2026-03-19T23:59:59Z",
      });
      expect(filtered).toHaveLength(1);
      expect(filtered[0].id).toBe("e2");
    });
  });

  describe("outcomes", () => {
    it("saves and lists outcomes", async () => {
      const ctx = makeCtx();
      await manager.saveOutcome(ctx, {
        id: "out-1",
        workItemId: "T1",
        deliveredAt: "2026-03-19T12:00:00Z",
        status: "healthy",
        signals: ["ci-passed", "no-errors"],
      });

      const outcomes = await manager.listOutcomes(ctx);
      expect(outcomes).toHaveLength(1);
      expect(outcomes[0].status).toBe("healthy");
      expect(outcomes[0].signals).toEqual(["ci-passed", "no-errors"]);
    });

    it("updates outcome on conflict", async () => {
      const ctx = makeCtx();
      await manager.saveOutcome(ctx, {
        id: "out-1", workItemId: "T1",
        deliveredAt: "2026-03-19T12:00:00Z",
        status: "unknown", signals: [],
      });
      await manager.saveOutcome(ctx, {
        id: "out-1", workItemId: "T1",
        deliveredAt: "2026-03-19T12:00:00Z",
        observedAt: "2026-03-19T13:00:00Z",
        status: "healthy", signals: ["ci-passed"],
        recommendation: "keep",
      });

      const outcomes = await manager.listOutcomes(ctx);
      expect(outcomes).toHaveLength(1);
      expect(outcomes[0].status).toBe("healthy");
      expect(outcomes[0].recommendation).toBe("keep");
    });

    it("filters outcomes by date range", async () => {
      const ctx = makeCtx();
      await manager.saveOutcome(ctx, {
        id: "o1", workItemId: "T1",
        deliveredAt: "2026-03-18T12:00:00Z",
        status: "healthy", signals: [],
      });
      await manager.saveOutcome(ctx, {
        id: "o2", workItemId: "T2",
        deliveredAt: "2026-03-19T12:00:00Z",
        status: "degraded", signals: ["error-rate-up"],
      });

      const filtered = await manager.listOutcomes(ctx, {
        from: "2026-03-19T00:00:00Z",
        to: "2026-03-19T23:59:59Z",
      });
      expect(filtered).toHaveLength(1);
      expect(filtered[0].id).toBe("o2");
    });
  });

  describe("schedule tracking", () => {
    it("returns true for never-run schedule", async () => {
      const ctx = makeCtx();
      const due = await manager.isScheduleDue(ctx, "test-repo", "research", 60);
      expect(due).toBe(true);
    });

    it("returns false for recently-run schedule", async () => {
      const ctx = makeCtx();
      await manager.markScheduleRun(ctx, "test-repo", "research");

      const due = await manager.isScheduleDue(ctx, "test-repo", "research", 60);
      expect(due).toBe(false);
    });

    it("returns true when interval has passed", async () => {
      const ctx = makeCtx();
      // Manually insert a lastRun 2 hours ago
      const twoHoursAgo = new Date(Date.now() - 120 * 60_000).toISOString();
      await manager.markScheduleRun(ctx, "test-repo", "research");
      // Override with old timestamp
      (manager as unknown as { db: { prepare: (sql: string) => { run: (...args: unknown[]) => void } } })
        .db.prepare("UPDATE schedule_state SET last_run = ? WHERE repo_id = ? AND action = ?")
        .run(twoHoursAgo, "test-repo", "research");

      const due = await manager.isScheduleDue(ctx, "test-repo", "research", 60);
      expect(due).toBe(true);
    });

    it("tracks schedules per repo and action independently", async () => {
      const ctx = makeCtx();
      await manager.markScheduleRun(ctx, "repo-a", "research");

      // Different repo → still due
      expect(await manager.isScheduleDue(ctx, "repo-b", "research", 5)).toBe(true);
      // Different action → still due
      expect(await manager.isScheduleDue(ctx, "repo-a", "review", 5)).toBe(true);
      // Same repo+action → not due
      expect(await manager.isScheduleDue(ctx, "repo-a", "research", 5)).toBe(false);
    });
  });

  describe("deduplication", () => {
    it("returns false for unknown item", async () => {
      const known = await manager.isKnownItem(makeCtx(), "test-repo", "issue:42");
      expect(known).toBe(false);
    });

    it("returns true after marking as known", async () => {
      const ctx = makeCtx();
      await manager.markKnownItem(ctx, "test-repo", "issue:42");

      const known = await manager.isKnownItem(ctx, "test-repo", "issue:42");
      expect(known).toBe(true);
    });

    it("does not throw on duplicate mark", async () => {
      const ctx = makeCtx();
      await manager.markKnownItem(ctx, "test-repo", "issue:42");
      await manager.markKnownItem(ctx, "test-repo", "issue:42");

      const known = await manager.isKnownItem(ctx, "test-repo", "issue:42");
      expect(known).toBe(true);
    });

    it("scopes known items per repo", async () => {
      const ctx = makeCtx();
      await manager.markKnownItem(ctx, "repo-a", "issue:42");

      expect(await manager.isKnownItem(ctx, "repo-a", "issue:42")).toBe(true);
      expect(await manager.isKnownItem(ctx, "repo-b", "issue:42")).toBe(false);
    });
  });

  describe("lifecycle", () => {
    it("can close and reopen with same db path", async () => {
      const ctx = makeCtx();
      const dbPath = join(tempDir, "lifecycle.db");
      const mgr1 = new SQLiteStateManager(dbPath);
      await mgr1.upsertWorkItem(ctx, makeWorkItem());
      mgr1.close();

      const mgr2 = new SQLiteStateManager(dbPath);
      const item = await mgr2.getWorkItem(ctx, "T20260319-000101");
      expect(item).not.toBeNull();
      mgr2.close();
    });
  });
});
