import { describe, it, expect, beforeEach } from "vitest";
import type {
  KVEntry,
  KVStore,
  KindDefinition,
  KindRegistry,
  OperationContext,
  WorkItemKind,
  WorkItemRecord,
  WorkItemStatus,
} from "@operator/core";
import { WorkItemSourceError } from "@operator/core";
import { VirtualWorkItemSource } from "./virtual.js";

const KINDS: KindDefinition[] = [
  {
    name: "retrospective-cycle",
    label: "Retrospective Cycle",
    idPrefix: "RC",
    dataDir: ".operator/data/retrospectives",
    branchPrefix: "ai/retrospective",
    prPrefix: "[AI:Retro]",
    terminalStatuses: ["completed", "failed"],
  },
  {
    name: "agent-improvement",
    label: "Agent Improvement",
    idPrefix: "AI",
    dataDir: ".operator/data/improvements",
    branchPrefix: "ai/improvement",
    prPrefix: "[AI:Improve]",
    terminalStatuses: ["completed", "rejected"],
  },
];

class TestRegistry implements KindRegistry {
  readonly all = KINDS;
  get(kind: WorkItemKind): KindDefinition | undefined { return KINDS.find((k) => k.name === kind); }
  isTerminal(): boolean { return false; }
  async generateId(): Promise<string> { return "RC20260507-0001"; }
  labelFor(kind: WorkItemKind): string { return this.get(kind)!.label; }
  branchPrefixFor(kind: WorkItemKind): string { return this.get(kind)!.branchPrefix; }
  dataDirFor(kind: WorkItemKind): string { return this.get(kind)!.dataDir; }
  parentKindsFor(): readonly WorkItemKind[] { return []; }
  terminalStatusesFor(kind: WorkItemKind): ReadonlySet<WorkItemStatus> {
    return new Set(this.get(kind)?.terminalStatuses ?? []);
  }
}

class FakeKV implements KVStore {
  private readonly rows = new Map<string, { value: unknown }>();
  async get(category: string, key: string): Promise<KVEntry | null> {
    const v = this.rows.get(`${category}/${key}`);
    return v ? { key, value: v.value } : null;
  }
  async put(category: string, key: string, value: unknown): Promise<void> {
    this.rows.set(`${category}/${key}`, { value });
  }
  async list(category: string): Promise<KVEntry[]> {
    const out: KVEntry[] = [];
    for (const [k, v] of this.rows) {
      const [cat, ...rest] = k.split("/");
      if (cat !== category) continue;
      out.push({ key: rest.join("/"), value: v.value });
    }
    return out;
  }
  async delete(category: string, key: string): Promise<void> {
    this.rows.delete(`${category}/${key}`);
  }
  close(): void { /* no-op */ }
  /** Test helper — peek at internal storage without going through the API. */
  peek(category: string, key: string): unknown {
    return this.rows.get(`${category}/${key}`)?.value;
  }
}

function makeCtx(): OperationContext {
  return {
    traceId: "t", repoId: "r", action: "test",
    budget: { spentUsd: 0, add: () => {}, isExceeded: () => false },
    signal: AbortSignal.timeout(30_000),
  };
}

function makeRecord(overrides: Partial<WorkItemRecord> = {}): WorkItemRecord {
  return {
    id: "RC20260507-0001",
    kind: "retrospective-cycle",
    title: "Week of 2026-05-04",
    body: "## Highlights\n\n- 12 PRs merged",
    status: "pending",
    priority: 3,
    createdAt: "2026-05-07T10:00:00Z",
    ...overrides,
  };
}

describe("VirtualWorkItemSource", () => {
  let kv: FakeKV;
  let registry: TestRegistry;
  let source: VirtualWorkItemSource;
  const FROZEN_NOW = new Date("2026-05-07T12:00:00Z");

  beforeEach(() => {
    kv = new FakeKV();
    registry = new TestRegistry();
    source = new VirtualWorkItemSource({ kv, registry, now: () => FROZEN_NOW });
  });

  describe("create", () => {
    it("writes a fresh row to kv:work-items-virtual", async () => {
      const record = makeRecord();
      await source.create(record, makeCtx());
      const stored = kv.peek("work-items-virtual", record.id) as Record<string, unknown>;
      expect(stored).not.toBeNull();
      expect(stored.title).toBe(record.title);
      expect(stored.kind).toBe("retrospective-cycle");
      expect(stored.status).toBe("pending");
    });

    it("idempotent on identical content", async () => {
      const record = makeRecord();
      await source.create(record, makeCtx());
      const second = await source.create(record, makeCtx());
      expect(second.id).toBe(record.id);
    });

    it("throws WI_DUPLICATE when same id has different content", async () => {
      const record = makeRecord();
      await source.create(record, makeCtx());
      await expect(source.create({ ...record, body: "different" }, makeCtx()))
        .rejects.toThrow(WorkItemSourceError);
    });

    it("throws WI_KIND_UNKNOWN for an unregistered kind", async () => {
      await expect(source.create({ ...makeRecord(), kind: "ghost" as WorkItemKind }, makeCtx()))
        .rejects.toThrow(/WI_KIND_UNKNOWN|not registered/);
    });

    it("stamps createdAt from clock when not provided", async () => {
      await source.create({ ...makeRecord(), createdAt: "" }, makeCtx());
      const stored = kv.peek("work-items-virtual", "RC20260507-0001") as Record<string, unknown>;
      expect(stored.createdAt).toBe(FROZEN_NOW.toISOString());
    });
  });

  describe("read", () => {
    it("returns the record for an existing key", async () => {
      const record = makeRecord();
      await source.create(record, makeCtx());
      const fetched = await source.read({ kind: record.kind, id: record.id }, makeCtx());
      expect(fetched).not.toBeNull();
      expect(fetched!.title).toBe(record.title);
    });

    it("returns null for a missing key", async () => {
      const result = await source.read({ kind: "retrospective-cycle", id: "RCxx" }, makeCtx());
      expect(result).toBeNull();
    });

    it("returns null when stored row's kind disagrees with the ref's kind", async () => {
      const record = makeRecord(); // kind: retrospective-cycle
      await source.create(record, makeCtx());
      // Read with a different kind under the same id — defensive guard.
      const fetched = await source.read({ kind: "agent-improvement", id: record.id }, makeCtx());
      expect(fetched).toBeNull();
    });

    it("throws WI_INVALID_FRONTMATTER when stored row fails schema validation", async () => {
      await kv.put("work-items-virtual", "RC-bad", { not: "valid" });
      await expect(source.read({ kind: "retrospective-cycle", id: "RC-bad" }, makeCtx()))
        .rejects.toThrow(WorkItemSourceError);
    });
  });

  describe("updateStatus", () => {
    it("flips status and stamps startedAt on first transition to in-progress", async () => {
      await source.create(makeRecord(), makeCtx());
      const updated = await source.updateStatus(
        { kind: "retrospective-cycle", id: "RC20260507-0001" },
        "in-progress", "begin", makeCtx(),
      );
      expect(updated.status).toBe("in-progress");
      expect(updated.startedAt).toBe(FROZEN_NOW.toISOString());
      const stored = kv.peek("work-items-virtual", "RC20260507-0001") as Record<string, unknown>;
      expect(stored.statusReason).toBe("begin");
    });

    it("stamps completedAt on terminal completed status", async () => {
      await source.create(makeRecord(), makeCtx());
      const updated = await source.updateStatus(
        { kind: "retrospective-cycle", id: "RC20260507-0001" },
        "completed", undefined, makeCtx(),
      );
      expect(updated.completedAt).toBe(FROZEN_NOW.toISOString());
    });

    it("throws WI_NOT_FOUND for a missing ref", async () => {
      await expect(source.updateStatus(
        { kind: "retrospective-cycle", id: "RCxxxx" },
        "in-progress", undefined, makeCtx(),
      )).rejects.toThrow(WorkItemSourceError);
    });
  });

  describe("updateBody", () => {
    it("replaces the body when mergeStrategy = replace", async () => {
      await source.create(makeRecord(), makeCtx());
      const updated = await source.updateBody(
        { kind: "retrospective-cycle", id: "RC20260507-0001" },
        "## New body", "replace", undefined, makeCtx(),
      );
      expect(updated.body).toBe("## New body");
    });

    it("appends a section when mergeStrategy = append-section", async () => {
      await source.create(makeRecord(), makeCtx());
      const updated = await source.updateBody(
        { kind: "retrospective-cycle", id: "RC20260507-0001" },
        "appendix", "append-section", "Notes", makeCtx(),
      );
      expect(updated.body).toContain("## Highlights");
      expect(updated.body).toContain("## Notes");
      expect(updated.body).toContain("appendix");
    });

    it("throws WI_NOT_FOUND for a missing ref", async () => {
      await expect(source.updateBody(
        { kind: "retrospective-cycle", id: "RCxxxx" }, "x", "replace", undefined, makeCtx(),
      )).rejects.toThrow(WorkItemSourceError);
    });
  });

  describe("list", () => {
    it("lists records matching the kind, sorted by id", async () => {
      await source.create(makeRecord({ id: "RC2" }), makeCtx());
      await source.create(makeRecord({ id: "RC1" }), makeCtx());
      const results = await source.list({ kind: "retrospective-cycle" }, makeCtx());
      expect(results.map((r) => r.id)).toEqual(["RC1", "RC2"]);
    });

    it("filters by status", async () => {
      await source.create(makeRecord({ id: "RC1", status: "pending" }), makeCtx());
      await source.create(makeRecord({ id: "RC2", status: "completed" }), makeCtx());
      const pending = await source.list({ kind: "retrospective-cycle", status: "pending" }, makeCtx());
      expect(pending.map((r) => r.id)).toEqual(["RC1"]);
    });

    it("filters by parentId", async () => {
      await source.create(makeRecord({ id: "RC1", parentId: "P1" }), makeCtx());
      await source.create(makeRecord({ id: "RC2", parentId: "P2" }), makeCtx());
      const filtered = await source.list({ kind: "retrospective-cycle", parentId: "P1" }, makeCtx());
      expect(filtered.map((r) => r.id)).toEqual(["RC1"]);
    });

    it("ignores rows whose stored kind differs from the filter kind", async () => {
      await source.create(makeRecord({ id: "RC1" }), makeCtx());
      await source.create(makeRecord({ id: "AI1", kind: "agent-improvement" }), makeCtx());
      const onlyRetros = await source.list({ kind: "retrospective-cycle" }, makeCtx());
      expect(onlyRetros.map((r) => r.id)).toEqual(["RC1"]);
    });

    it("skips malformed rows without aborting the listing", async () => {
      await source.create(makeRecord({ id: "RC1" }), makeCtx());
      await kv.put("work-items-virtual", "RC-bad", { garbage: true });
      const results = await source.list({ kind: "retrospective-cycle" }, makeCtx());
      expect(results.map((r) => r.id)).toEqual(["RC1"]);
    });

    it("returns [] when nothing in the category matches", async () => {
      const results = await source.list({ kind: "retrospective-cycle" }, makeCtx());
      expect(results).toEqual([]);
    });
  });
});
