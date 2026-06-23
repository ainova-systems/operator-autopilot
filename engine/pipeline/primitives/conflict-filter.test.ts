import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OperationContext, StateManager, WorkItem } from "@operator/core";
import type { WorkItemFileData } from "../../work-items/work-items.js";
import {
  extractDomains,
  hasConflict,
  hasUnmetDeps,
  collectInProgressDomains,
  buildConflictFilter,
} from "./conflict-filter.js";
import { makeTestKindRegistry } from "../../test-helpers/test-kind-registry.js";

function makeCtx(): OperationContext {
  return {
    traceId: "t",
    repoId: "sample",
    action: "test",
    budget: { limitUsd: undefined, spentUsd: 0, add: () => {}, isExceeded: () => false },
    signal: AbortSignal.timeout(10_000),
  };
}

function makeFileData(overrides?: Partial<WorkItemFileData>): WorkItemFileData {
  return {
    id: "T-1",
    kind: "task",
    title: "sample",
    body: "body",
    status: "pending",
    priority: 3,
    createdAt: "2026-04-16T10:00:00Z",
    ...overrides,
  };
}

function makeWorkItem(overrides?: Partial<WorkItem>): WorkItem {
  return {
    id: "T-1",
    kind: "task",
    title: "sample",
    body: "body",
    status: "pending",
    priority: 3,
    createdAt: "2026-04-16T10:00:00Z",
    updatedAt: "2026-04-16T10:00:00Z",
    ...overrides,
  };
}

describe("extractDomains", () => {
  it("extracts domain from Source/Layer/src/Domain/SubDomain pattern", () => {
    expect(extractDomains("Source/Server/src/Catalog/ProductManagement"))
      .toEqual(["catalog"]);
  });

  it("returns empty array for empty path", () => {
    expect(extractDomains(undefined)).toEqual([]);
    expect(extractDomains("")).toEqual([]);
  });

  it("deduplicates multiple domain matches", () => {
    const path = "Source/A/src/Catalog/X Source/B/src/Catalog/Y";
    expect(extractDomains(path)).toEqual(["catalog"]);
  });

  it("falls back to glob-style domain extraction", () => {
    expect(extractDomains("libs/shared/tools")).toEqual(["tools"]);
  });

  it("ignores star-only path", () => {
    expect(extractDomains("*")).toEqual([]);
  });
});

describe("hasConflict", () => {
  it("returns false when inProgressDomains is empty", () => {
    const task = makeFileData({ path: "Source/Server/src/Catalog/X" });
    expect(hasConflict(task, new Set())).toBe(false);
  });

  it("returns true on domain overlap", () => {
    const task = makeFileData({ path: "Source/Server/src/Catalog/X" });
    expect(hasConflict(task, new Set(["catalog"]))).toBe(true);
  });

  it("returns false on disjoint domains", () => {
    const task = makeFileData({ path: "Source/Server/src/Catalog/X" });
    expect(hasConflict(task, new Set(["orders"]))).toBe(false);
  });

  it("returns false when task has no path", () => {
    const task = makeFileData({ path: undefined });
    expect(hasConflict(task, new Set(["catalog"]))).toBe(false);
  });
});

describe("hasUnmetDeps", () => {
  let tasksDir: string;
  beforeEach(async () => {
    tasksDir = await mkdtemp(join(tmpdir(), "op-confdeps-"));
  });
  afterEach(async () => {
    await rm(tasksDir, { recursive: true, force: true });
  });

  async function writeTask(id: string, status: string): Promise<void> {
    const content = `---\nid: ${id}\ntype: task\ntitle: "${id}"\nstatus: ${status}\npriority: 3\ncreated_at: "2026-04-16"\n---\n\n${id} body.`;
    await writeFile(join(tasksDir, `${id}.md`), content, "utf-8");
  }

  it("returns false when task has no dependsOn", async () => {
    const task = makeFileData();
    expect(await hasUnmetDeps(task, tasksDir)).toBe(false);
  });

  it("returns false when all deps are completed", async () => {
    await writeTask("T-DEP", "completed");
    const task = makeFileData({ dependsOn: ["T-DEP"] });
    expect(await hasUnmetDeps(task, tasksDir)).toBe(false);
  });

  it("returns true when any dep is not completed", async () => {
    await writeTask("T-DEP", "pending");
    const task = makeFileData({ dependsOn: ["T-DEP"] });
    expect(await hasUnmetDeps(task, tasksDir)).toBe(true);
  });

  it("returns true when dep file is missing", async () => {
    const task = makeFileData({ dependsOn: ["T-GHOST"] });
    expect(await hasUnmetDeps(task, tasksDir)).toBe(true);
  });
});

describe("collectInProgressDomains", () => {
  let tasksDir: string;
  beforeEach(async () => {
    tasksDir = await mkdtemp(join(tmpdir(), "op-collect-"));
  });
  afterEach(async () => {
    await rm(tasksDir, { recursive: true, force: true });
  });

  async function writeTask(id: string, status: string, path?: string): Promise<void> {
    const extra = path !== undefined ? `path: "${path}"\n` : "";
    const content = `---\nid: ${id}\ntype: task\ntitle: "${id}"\nstatus: ${status}\npriority: 3\ncreated_at: "2026-04-16"\n${extra}---\n\n${id} body.`;
    await writeFile(join(tasksDir, `${id}.md`), content, "utf-8");
  }

  it("returns empty set when no items are in-progress", async () => {
    await writeTask("T-1", "pending", "Source/Server/src/Catalog/X");
    const items: WorkItem[] = [makeWorkItem({ id: "T-1", status: "pending" })];
    const domains = await collectInProgressDomains(items, tasksDir);
    expect(domains).toEqual(new Set());
  });

  it("collects domains from all in-progress items, skipping others", async () => {
    await writeTask("T-1", "in-progress", "Source/Server/src/Catalog/X");
    await writeTask("T-2", "completed", "Source/Server/src/Orders/X");
    await writeTask("T-3", "in-progress", "Source/Server/src/Billing/X");
    const items: WorkItem[] = [
      makeWorkItem({ id: "T-1", status: "in-progress" }),
      makeWorkItem({ id: "T-2", status: "completed" }),
      makeWorkItem({ id: "T-3", status: "in-progress" }),
    ];
    const domains = await collectInProgressDomains(items, tasksDir);
    expect(domains).toEqual(new Set(["catalog", "billing"]));
  });

  it("skips unreadable files and keeps collecting", async () => {
    await writeTask("T-1", "in-progress", "Source/Server/src/Catalog/X");
    // T-GHOST has no file on disk.
    const items: WorkItem[] = [
      makeWorkItem({ id: "T-1", status: "in-progress" }),
      makeWorkItem({ id: "T-GHOST", status: "in-progress" }),
    ];
    const domains = await collectInProgressDomains(items, tasksDir);
    expect(domains).toEqual(new Set(["catalog"]));
  });
});

describe("buildConflictFilter", () => {
  let tasksDir: string;
  beforeEach(async () => {
    tasksDir = await mkdtemp(join(tmpdir(), "op-conflictfilter-"));
  });
  afterEach(async () => {
    await rm(tasksDir, { recursive: true, force: true });
  });

  async function writeTask(id: string, status: string, extra = ""): Promise<void> {
    const content = `---\nid: ${id}\ntype: task\ntitle: "${id}"\nstatus: ${status}\npriority: 3\ncreated_at: "2026-04-16"\n${extra}---\n\n${id} body.`;
    await writeFile(join(tasksDir, `${id}.md`), content, "utf-8");
  }

  function makeState(items: WorkItem[]): StateManager {
    return {
      listWorkItems: vi.fn().mockResolvedValue(items),
      upsertWorkItem: vi.fn(), getWorkItem: vi.fn(), updateWorkItemStatus: vi.fn(),
      appendExecution: vi.fn(), listExecutions: vi.fn(),
      saveOutcome: vi.fn(), listOutcomes: vi.fn(),
      isScheduleDue: vi.fn(), markScheduleRun: vi.fn(),
      isKnownItem: vi.fn(), markKnownItem: vi.fn(), close: vi.fn(),
    };
  }

  it("excludes terminal item via file-status check", async () => {
    await writeTask("T-DONE", "merged");
    const filter = buildConflictFilter({
      state: makeState([]), kindRegistry: makeTestKindRegistry(), dataDir: tasksDir, kind: "task",
    });
    const result = await filter(makeWorkItem({ id: "T-DONE" }), makeCtx());
    expect(result).toBe(false);
  });

  it("excludes item with unmet deps", async () => {
    await writeTask("T-DEP", "pending");
    await writeTask("T-ME", "pending", "depends_on: T-DEP\n");
    const state = makeState([makeWorkItem({ id: "T-DEP", status: "pending" })]);
    const filter = buildConflictFilter({
      state, kindRegistry: makeTestKindRegistry(), dataDir: tasksDir, kind: "task",
    });
    const result = await filter(makeWorkItem({ id: "T-ME" }), makeCtx());
    expect(result).toBe(false);
  });

  it("accepts item with no conflicts and no deps", async () => {
    await writeTask("T-OK", "pending");
    const filter = buildConflictFilter({
      state: makeState([]), kindRegistry: makeTestKindRegistry(), dataDir: tasksDir, kind: "task",
    });
    const result = await filter(makeWorkItem({ id: "T-OK" }), makeCtx());
    expect(result).toBe(true);
  });

  it("excludes item with domain conflict against in-progress sibling", async () => {
    await writeTask("T-IP", "in-progress", "path: \"Source/Server/src/Catalog/X\"\n");
    await writeTask("T-ME", "pending", "path: \"Source/Server/src/Catalog/Y\"\n");
    const state = makeState([
      makeWorkItem({ id: "T-IP", status: "in-progress" }),
    ]);
    const filter = buildConflictFilter({
      state, kindRegistry: makeTestKindRegistry(), dataDir: tasksDir, kind: "task",
    });
    const result = await filter(makeWorkItem({ id: "T-ME" }), makeCtx());
    expect(result).toBe(false);
  });

  it("allows item with no file on current branch — beforeAgent re-reads after checkout", async () => {
    const filter = buildConflictFilter({
      state: makeState([]), kindRegistry: makeTestKindRegistry(), dataDir: tasksDir, kind: "task",
    });
    const result = await filter(makeWorkItem({ id: "T-GHOST", status: "pending" }), makeCtx());
    expect(result).toBe(true);
  });

  it("still excludes a missing-file item when its KV status is terminal", async () => {
    const filter = buildConflictFilter({
      state: makeState([]), kindRegistry: makeTestKindRegistry(), dataDir: tasksDir, kind: "task",
    });
    const result = await filter(makeWorkItem({ id: "T-DONE", status: "merged" }), makeCtx());
    expect(result).toBe(false);
  });
});
