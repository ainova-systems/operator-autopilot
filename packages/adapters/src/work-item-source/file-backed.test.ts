import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  KindDefinition,
  KindRegistry,
  OperationContext,
  WorkItemKind,
  WorkItemRecord,
  WorkItemStatus,
} from "@operator/core";
import { WorkItemSourceError } from "@operator/core";
import { FileBackedWorkItemSource } from "./file-backed.js";

const KINDS: KindDefinition[] = [
  {
    name: "finding",
    label: "Finding",
    idPrefix: "F",
    dataDir: ".operator/data/findings",
    branchPrefix: "ai/findings",
    prPrefix: "[AI:Finding]",
    terminalStatuses: ["completed", "failed", "rejected", "duplicate", "merged"],
  },
  {
    name: "task",
    label: "Task",
    idPrefix: "T",
    dataDir: ".operator/data/tasks",
    branchPrefix: "ai/tasks",
    prPrefix: "[AI:Task]",
    terminalStatuses: ["completed", "failed", "rejected", "duplicate", "merged"],
  },
];

class TestRegistry implements KindRegistry {
  readonly all = KINDS;
  get(kind: WorkItemKind): KindDefinition | undefined { return KINDS.find((k) => k.name === kind); }
  isTerminal(kind: WorkItemKind, status: WorkItemStatus): boolean {
    return (this.get(kind)?.terminalStatuses ?? []).includes(status);
  }
  async generateId(kind: WorkItemKind): Promise<string> { return `${this.get(kind)!.idPrefix}19990101-0001`; }
  labelFor(kind: WorkItemKind): string { return this.get(kind)!.label; }
  branchPrefixFor(kind: WorkItemKind): string { return this.get(kind)!.branchPrefix; }
  dataDirFor(kind: WorkItemKind): string { return this.get(kind)!.dataDir; }
  parentKindsFor(): readonly WorkItemKind[] { return []; }
  terminalStatusesFor(kind: WorkItemKind): ReadonlySet<WorkItemStatus> {
    return new Set(this.get(kind)?.terminalStatuses ?? []);
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
    id: "F20260502-0001",
    kind: "finding",
    title: "SQL injection in login",
    body: "## Problem\n\nDescription here.",
    status: "pending",
    priority: 3,
    source: "code-analyzer",
    createdAt: "2026-05-02T10:00:00Z",
    ...overrides,
  };
}

describe("FileBackedWorkItemSource", () => {
  let dir: string;
  let registry: TestRegistry;
  let source: FileBackedWorkItemSource;
  const FROZEN_NOW = new Date("2026-05-07T12:00:00Z");

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "wi-fb-"));
    registry = new TestRegistry();
    source = new FileBackedWorkItemSource({ registry, workspacePath: dir, now: () => FROZEN_NOW });
  });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  describe("create", () => {
    it("writes a fresh file with frontmatter + body, returns the record with resolved path", async () => {
      const record = makeRecord();
      const result = await source.create(record, makeCtx());
      expect(result.id).toBe(record.id);
      expect(result.path).toBe(join(dir, ".operator/data/findings", `${record.id}.md`));
      const onDisk = await readFile(result.path!, "utf-8");
      expect(onDisk).toContain("status: pending");
      expect(onDisk).toContain("title: SQL injection in login");
      expect(onDisk).toContain("priority: 3");
      expect(onDisk).toContain("## Problem");
    });

    it("creates the per-kind directory if it does not exist", async () => {
      const record = makeRecord();
      const result = await source.create(record, makeCtx());
      expect(result.path).toMatch(/findings/);
    });

    it("idempotent on identical content", async () => {
      const record = makeRecord();
      await source.create(record, makeCtx());
      const second = await source.create(record, makeCtx());
      expect(second.id).toBe(record.id);
    });

    it("throws WI_DUPLICATE when an existing file has different content under the same id", async () => {
      const record = makeRecord();
      await source.create(record, makeCtx());
      await expect(source.create({ ...record, body: "different body" }, makeCtx()))
        .rejects.toThrow(WorkItemSourceError);
    });

    it("throws WI_KIND_UNKNOWN for an unregistered kind", async () => {
      await expect(source.create({ ...makeRecord(), kind: "ghost" as WorkItemKind }, makeCtx()))
        .rejects.toThrow(/WI_KIND_UNKNOWN|not registered/);
    });

    it("stamps createdAt from clock when not provided", async () => {
      const result = await source.create({ ...makeRecord(), createdAt: "" }, makeCtx());
      expect(result.createdAt).toBe(FROZEN_NOW.toISOString());
    });
  });

  describe("read", () => {
    it("returns the record for an existing file", async () => {
      const record = makeRecord();
      await source.create(record, makeCtx());
      const fetched = await source.read({ kind: "finding", id: record.id }, makeCtx());
      expect(fetched).not.toBeNull();
      expect(fetched!.title).toBe(record.title);
      expect(fetched!.priority).toBe(3);
    });

    it("returns null for a missing file (ENOENT)", async () => {
      const result = await source.read({ kind: "finding", id: "F99999999-0001" }, makeCtx());
      expect(result).toBeNull();
    });

    it("throws WI_INVALID_FRONTMATTER when the file lacks delimiters", async () => {
      await mkdir(join(dir, ".operator/data/findings"), { recursive: true });
      await writeFile(join(dir, ".operator/data/findings/F-bad.md"), "no frontmatter here", "utf-8");
      await expect(source.read({ kind: "finding", id: "F-bad" }, makeCtx()))
        .rejects.toThrow(/WI_INVALID_FRONTMATTER|delimiters/);
    });

    it("preserves dependsOn as comma-split array", async () => {
      const record = makeRecord({ kind: "task", id: "T20260502-000101", dependsOn: ["T1", "T2"] });
      await source.create(record, makeCtx());
      const fetched = await source.read({ kind: "task", id: record.id }, makeCtx());
      expect(fetched!.dependsOn).toEqual(["T1", "T2"]);
    });

    it("preserves extra/unknown frontmatter fields verbatim under `extra`", async () => {
      await mkdir(join(dir, ".operator/data/findings"), { recursive: true });
      await writeFile(
        join(dir, ".operator/data/findings/F20260502-0099.md"),
        `---\nid: F20260502-0099\nkind: finding\ntitle: hello\nstatus: pending\npriority: 3\ncreated_at: "2026-05-02T10:00:00Z"\ncustom_field: custom-value\n---\n\nbody`,
        "utf-8",
      );
      const fetched = await source.read({ kind: "finding", id: "F20260502-0099" }, makeCtx());
      expect(fetched!.extra?.custom_field).toBe("custom-value");
    });
  });

  describe("updateStatus", () => {
    it("flips status and stamps startedAt on first transition to in-progress", async () => {
      const record = makeRecord();
      await source.create(record, makeCtx());
      const updated = await source.updateStatus({ kind: "finding", id: record.id }, "in-progress", "children-merged", makeCtx());
      expect(updated.status).toBe("in-progress");
      expect(updated.startedAt).toBe(FROZEN_NOW.toISOString());
      const onDisk = await readFile(updated.path!, "utf-8");
      expect(onDisk).toContain("status_reason: children-merged");
    });

    it("stamps completedAt on terminal completed status", async () => {
      const record = makeRecord();
      await source.create(record, makeCtx());
      const updated = await source.updateStatus({ kind: "finding", id: record.id }, "completed", undefined, makeCtx());
      expect(updated.completedAt).toBe(FROZEN_NOW.toISOString());
    });

    it("stamps rejectedAt on rejected status", async () => {
      const record = makeRecord();
      await source.create(record, makeCtx());
      const updated = await source.updateStatus({ kind: "finding", id: record.id }, "rejected", undefined, makeCtx());
      expect(updated.rejectedAt).toBe(FROZEN_NOW.toISOString());
    });

    it("preserves prior startedAt when transitioning between non-initial states", async () => {
      const record = makeRecord({ startedAt: "2026-04-01T00:00:00Z", status: "in-progress" });
      await source.create(record, makeCtx());
      const updated = await source.updateStatus({ kind: "finding", id: record.id }, "completed", undefined, makeCtx());
      expect(updated.startedAt).toBe("2026-04-01T00:00:00Z");
      expect(updated.completedAt).toBe(FROZEN_NOW.toISOString());
    });

    it("throws WI_NOT_FOUND for a missing ref", async () => {
      await expect(source.updateStatus(
        { kind: "finding", id: "F00000000-0000" }, "in-progress", undefined, makeCtx(),
      )).rejects.toThrowError(WorkItemSourceError);
    });
  });

  describe("updateBody", () => {
    it("replaces the body when mergeStrategy = replace", async () => {
      const record = makeRecord();
      await source.create(record, makeCtx());
      const updated = await source.updateBody({ kind: "finding", id: record.id }, "## New body\n\ncontent", "replace", undefined, makeCtx());
      expect(updated.body).toContain("## New body");
      expect(updated.body).not.toContain("## Problem");
    });

    it("appends a section when mergeStrategy = append-section", async () => {
      const record = makeRecord();
      await source.create(record, makeCtx());
      const updated = await source.updateBody({ kind: "finding", id: record.id }, "appendix content", "append-section", "Appendix", makeCtx());
      expect(updated.body).toContain("## Problem");
      expect(updated.body).toContain("## Appendix");
      expect(updated.body).toContain("appendix content");
    });

    it("throws WI_NOT_FOUND for a missing ref", async () => {
      await expect(source.updateBody(
        { kind: "finding", id: "F00000000-0000" }, "x", "replace", undefined, makeCtx(),
      )).rejects.toThrowError(WorkItemSourceError);
    });
  });

  describe("list", () => {
    it("lists all records of a kind, sorted by id", async () => {
      await source.create(makeRecord({ id: "F20260502-0002" }), makeCtx());
      await source.create(makeRecord({ id: "F20260502-0001" }), makeCtx());
      const results = await source.list({ kind: "finding" }, makeCtx());
      expect(results.map((r) => r.id)).toEqual(["F20260502-0001", "F20260502-0002"]);
    });

    it("filters by status when provided", async () => {
      await source.create(makeRecord({ id: "F1", status: "pending" }), makeCtx());
      await source.create(makeRecord({ id: "F2", status: "completed" }), makeCtx());
      const pending = await source.list({ kind: "finding", status: "pending" }, makeCtx());
      expect(pending.map((r) => r.id)).toEqual(["F1"]);
    });

    it("filters by parentId when provided", async () => {
      await source.create(makeRecord({ kind: "task", id: "T1", parentId: "F1" }), makeCtx());
      await source.create(makeRecord({ kind: "task", id: "T2", parentId: "F2" }), makeCtx());
      const children = await source.list({ kind: "task", parentId: "F1" }, makeCtx());
      expect(children.map((r) => r.id)).toEqual(["T1"]);
    });

    it("returns [] when the data dir does not exist", async () => {
      const results = await source.list({ kind: "finding" }, makeCtx());
      expect(results).toEqual([]);
    });

    it("skips files that fail to parse (does not abort the whole listing)", async () => {
      await source.create(makeRecord(), makeCtx());
      await mkdir(join(dir, ".operator/data/findings"), { recursive: true });
      await writeFile(join(dir, ".operator/data/findings/F-bad.md"), "no frontmatter", "utf-8");
      const results = await source.list({ kind: "finding" }, makeCtx());
      expect(results).toHaveLength(1);
    });

    it("ignores files that don't match the kind's idPrefix", async () => {
      await mkdir(join(dir, ".operator/data/findings"), { recursive: true });
      await writeFile(join(dir, ".operator/data/findings/README.md"), "---\nid: x\nkind: finding\ntitle: t\nstatus: pending\npriority: 3\n---\n\nbody", "utf-8");
      const results = await source.list({ kind: "finding" }, makeCtx());
      expect(results).toEqual([]);
    });
  });
});
