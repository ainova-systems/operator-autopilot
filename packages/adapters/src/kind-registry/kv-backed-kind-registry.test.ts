import { describe, it, expect } from "vitest";
import type { OperationContext, KVStore, KVEntry } from "@operator/core";
import { KVBackedKindRegistry } from "./kv-backed-kind-registry.js";

/**
 * Simple in-memory KVStore double for registry tests. Only the `list` API
 * is exercised — the other methods throw so any accidental use surfaces.
 */
class FakeKVStore implements KVStore {
  private readonly rows = new Map<string, { value: unknown }>();

  seed(category: string, key: string, value: unknown): void {
    this.rows.set(`${category}/${key}`, { value });
  }

  async list(category: string): Promise<KVEntry[]> {
    const out: KVEntry[] = [];
    for (const [k, v] of this.rows) {
      if (!k.startsWith(`${category}/`)) continue;
      out.push({ key: k.slice(category.length + 1), value: v.value });
    }
    return out;
  }
  async get(): Promise<KVEntry | null> { throw new Error("unused"); }
  async put(): Promise<void> { throw new Error("unused"); }
  async delete(): Promise<void> { throw new Error("unused"); }
  close(): void { /* no-op */ }
}

function ctx(): OperationContext {
  return {
    traceId: "t",
    repoId: "r",
    action: "test",
    budget: { spentUsd: 0, add: () => {}, isExceeded: () => false },
    signal: AbortSignal.timeout(30_000),
  };
}

function seedStandardKinds(kv: FakeKVStore): void {
  kv.seed("work-item-kinds", "finding", {
    name: "finding", label: "Finding",
    idPrefix: "F", dataDir: "findings",
    branchPrefix: "ai/findings", prPrefix: "[AI:Finding]",
    terminalStatuses: ["completed", "failed", "rejected", "duplicate"],
  });
  kv.seed("work-item-kinds", "task", {
    name: "task", label: "Task",
    idPrefix: "T", dataDir: "tasks",
    branchPrefix: "ai/tasks", prPrefix: "[AI:Task]",
    terminalStatuses: ["completed", "failed", "rejected", "duplicate", "cancelled"],
  });
  kv.seed("work-item-kinds", "request", {
    name: "request", label: "Request",
    idPrefix: "R", dataDir: "requests",
    branchPrefix: "ai/requests", prPrefix: "[AI:Request]",
    terminalStatuses: ["completed", "rejected"],
  });
}

describe("KVBackedKindRegistry", () => {

  describe("fromKV", () => {
    it("loads every seeded kind row", async () => {
      const kv = new FakeKVStore();
      seedStandardKinds(kv);

      const reg = await KVBackedKindRegistry.fromKV(kv, ctx());

      expect(reg.all).toHaveLength(3);
      expect(reg.all.map((k) => k.name).sort()).toEqual(["finding", "request", "task"]);
    });

    it("throws when the category is empty (boot-time failure)", async () => {
      const kv = new FakeKVStore();
      await expect(KVBackedKindRegistry.fromKV(kv, ctx())).rejects.toThrow(
        /work-item-kinds/,
      );
    });

    it("throws on schema violation with offending key in message", async () => {
      const kv = new FakeKVStore();
      kv.seed("work-item-kinds", "broken", { name: "broken" /* missing fields */ });
      await expect(KVBackedKindRegistry.fromKV(kv, ctx())).rejects.toThrow(
        /broken/,
      );
    });

    it("loads dynamically-added kinds without code changes (e.g. 'plan')", async () => {
      const kv = new FakeKVStore();
      seedStandardKinds(kv);
      kv.seed("work-item-kinds", "plan", {
        name: "plan", label: "Plan",
        idPrefix: "P", dataDir: "plans",
        branchPrefix: "ai/plans", prPrefix: "[AI:Plan]",
        terminalStatuses: ["completed", "failed"],
      });

      const reg = await KVBackedKindRegistry.fromKV(kv, ctx());

      expect(reg.get("plan")?.label).toBe("Plan");
      expect(reg.labelFor("plan")).toBe("Plan");
      expect(reg.branchPrefixFor("plan")).toBe("ai/plans");
      expect(reg.dataDirFor("plan")).toBe("plans");
      const id = await reg.generateId("plan", "20260417");
      expect(id).toMatch(/^P20260417-[0-9A-F]{8}$/);
    });
  });

  describe("get / lookups", () => {
    it("returns undefined for unknown kind (non-throwing lookup)", async () => {
      const kv = new FakeKVStore();
      seedStandardKinds(kv);
      const reg = await KVBackedKindRegistry.fromKV(kv, ctx());
      expect(reg.get("unknown-kind")).toBeUndefined();
    });

    it("throws via requireKind for labelFor on unknown kind", async () => {
      const kv = new FakeKVStore();
      seedStandardKinds(kv);
      const reg = await KVBackedKindRegistry.fromKV(kv, ctx());
      expect(() => reg.labelFor("unknown-kind")).toThrow(/Unknown work-item kind/);
    });

    it("labelFor / branchPrefixFor / dataDirFor project the right fields", async () => {
      const kv = new FakeKVStore();
      seedStandardKinds(kv);
      const reg = await KVBackedKindRegistry.fromKV(kv, ctx());
      expect(reg.labelFor("finding")).toBe("Finding");
      expect(reg.branchPrefixFor("task")).toBe("ai/tasks");
      expect(reg.dataDirFor("request")).toBe("requests");
    });

    it("parentKindsFor returns the kind's parents, or [] for none / unknown", async () => {
      const kv = new FakeKVStore();
      seedStandardKinds(kv);
      kv.seed("work-item-kinds", "child-task", {
        name: "child-task", label: "Child Task",
        idPrefix: "C", dataDir: "child-tasks",
        branchPrefix: "ai/child-tasks", prPrefix: "[AI:Child]",
        terminalStatuses: ["completed"],
        parentKinds: ["finding"],
      });
      const reg = await KVBackedKindRegistry.fromKV(kv, ctx());
      expect(reg.parentKindsFor("child-task")).toEqual(["finding"]);
      expect(reg.parentKindsFor("finding")).toEqual([]);
      expect(reg.parentKindsFor("unknown-kind")).toEqual([]);
    });

    it("terminalStatusesFor returns the kind's terminal set, or empty for unknown", async () => {
      const kv = new FakeKVStore();
      seedStandardKinds(kv);
      const reg = await KVBackedKindRegistry.fromKV(kv, ctx());
      expect(reg.terminalStatusesFor("task").has("cancelled")).toBe(true);
      expect(reg.terminalStatusesFor("finding").has("pending")).toBe(false);
      expect(reg.terminalStatusesFor("unknown-kind").size).toBe(0);
    });
  });

  describe("isTerminal", () => {
    it("returns true for statuses listed in the kind's terminalStatuses", async () => {
      const kv = new FakeKVStore();
      seedStandardKinds(kv);
      const reg = await KVBackedKindRegistry.fromKV(kv, ctx());
      expect(reg.isTerminal("finding", "completed")).toBe(true);
      expect(reg.isTerminal("finding", "failed")).toBe(true);
      expect(reg.isTerminal("finding", "rejected")).toBe(true);
      expect(reg.isTerminal("finding", "duplicate")).toBe(true);
      expect(reg.isTerminal("task", "cancelled")).toBe(true);
      expect(reg.isTerminal("request", "completed")).toBe(true);
    });

    it("returns false for non-terminal statuses", async () => {
      const kv = new FakeKVStore();
      seedStandardKinds(kv);
      const reg = await KVBackedKindRegistry.fromKV(kv, ctx());
      expect(reg.isTerminal("finding", "pending")).toBe(false);
      expect(reg.isTerminal("task", "in-progress")).toBe(false);
      expect(reg.isTerminal("task", "reopened")).toBe(false);
    });

    it("returns false for unknown kind (graceful default)", async () => {
      const kv = new FakeKVStore();
      seedStandardKinds(kv);
      const reg = await KVBackedKindRegistry.fromKV(kv, ctx());
      expect(reg.isTerminal("unknown", "completed")).toBe(false);
    });
  });

  describe("generateId", () => {
    it("returns '{idPrefix}{date}-{8 uppercase hex}' for the given date", async () => {
      const kv = new FakeKVStore();
      seedStandardKinds(kv);
      const reg = await KVBackedKindRegistry.fromKV(kv, ctx());
      const id = await reg.generateId("finding", "20260322");
      expect(id).toMatch(/^F20260322-[0-9A-F]{8}$/);
    });

    it("uses the kind's idPrefix", async () => {
      const kv = new FakeKVStore();
      seedStandardKinds(kv);
      const reg = await KVBackedKindRegistry.fromKV(kv, ctx());
      expect(await reg.generateId("task", "20260322")).toMatch(/^T20260322-/);
      expect(await reg.generateId("request", "20260322")).toMatch(/^R20260322-/);
    });

    it("defaults date to today (YYYYMMDD UTC) when omitted", async () => {
      const kv = new FakeKVStore();
      seedStandardKinds(kv);
      const reg = await KVBackedKindRegistry.fromKV(kv, ctx());
      const id = await reg.generateId("task");
      expect(id).toMatch(/^T\d{8}-[0-9A-F]{8}$/);
    });

    // Regression for PR #892 (2026-05-21). Two finding planners ran on
    // sibling feature branches off develop; each scanned only its own branch
    // tree, so both minted `T20260323-0001` for unrelated tasks. When the
    // second branch merged into develop, the shared work-item file collided
    // add/add. Unique-by-construction ids must never repeat for the same
    // kind+date, regardless of any branch-local filesystem view.
    it("never repeats an id across many calls for the same kind and date (PR-892 collision regression)", async () => {
      const kv = new FakeKVStore();
      seedStandardKinds(kv);
      const reg = await KVBackedKindRegistry.fromKV(kv, ctx());
      const ids = new Set<string>();
      for (let i = 0; i < 1000; i++) {
        ids.add(await reg.generateId("task", "20260322"));
      }
      expect(ids.size).toBe(1000);
    });

    it("throws when kind is unknown", async () => {
      const kv = new FakeKVStore();
      seedStandardKinds(kv);
      const reg = await KVBackedKindRegistry.fromKV(kv, ctx());
      await expect(reg.generateId("bogus", "20260322")).rejects.toThrow(/Unknown/);
    });
  });
});
