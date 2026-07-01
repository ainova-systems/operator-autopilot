import { describe, it, expect, vi } from "vitest";
import type {
  OperationContext, KVStore, KVEntry, PRManager, WorkItemSource,
  WorkItem, WorkItemKindEntry, CodeReview,
} from "@operator/core";
import type { Logger } from "../../logging/logger.js";
import { TestStateManager } from "../../test-helpers/test-state-manager.js";
import { TestVCSPlatform } from "../../test-helpers/test-vcs-platform.js";
import { makeTestKindRegistry } from "../../test-helpers/test-kind-registry.js";
import { reconcileOrphanedItems } from "./orphan-reconciler.js";

const NOW = Date.parse("2026-06-24T00:00:00Z");
const OLD = "2026-04-01T00:00:00Z";   // > 30 days before NOW
const RECENT = "2026-06-20T00:00:00Z"; // < 30 days before NOW

// finding + task kinds WITH `cancelled` terminal (mirrors the kinds.yaml change).
const KIND_ENTRIES: readonly WorkItemKindEntry[] = [
  {
    name: "finding", label: "Finding", idPrefix: "F", dataDir: "findings",
    branchPrefix: "ai/findings", prPrefix: "[AI:Finding]",
    terminalStatuses: ["merged", "completed", "failed", "rejected", "duplicate", "cancelled"],
    parentKinds: [],
  },
  {
    name: "task", label: "Task", idPrefix: "T", dataDir: "tasks",
    branchPrefix: "ai/tasks", prPrefix: "[AI:Task]",
    terminalStatuses: ["merged", "completed", "failed", "rejected", "duplicate", "cancelled"],
    parentKinds: ["finding"],
  },
];

const DISCOVERY_STAGE_ROW = {
  category: "workflow-stages", key: "research",
  value: { selector: "discovery", outputSink: { kind: "finding" } },
} as unknown as KVEntry;

function makeCtx(): OperationContext {
  return {
    traceId: "t", repoId: "r", action: "retrospective",
    budget: { spentUsd: 0, add: vi.fn(), isExceeded: () => false },
    signal: AbortSignal.timeout(30_000),
  };
}

function makeLog(): Logger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger;
}

function makeKv(rows: KVEntry[]): KVStore {
  return { list: vi.fn(async (cat: string) => (cat === "workflow-stages" ? rows : [])) } as unknown as KVStore;
}

/** prManager whose findOpenPR resolves a per-branch map. */
function makePrManager(openByBranch: Record<string, CodeReview> = {}): PRManager {
  return {
    findOpenPR: vi.fn(async (branch: string) => openByBranch[branch] ?? null),
  } as unknown as PRManager;
}

function makeWorkItemSource(): WorkItemSource & { updateStatus: ReturnType<typeof vi.fn> } {
  return {
    updateStatus: vi.fn().mockResolvedValue(undefined),
  } as unknown as WorkItemSource & { updateStatus: ReturnType<typeof vi.fn> };
}

function finding(id: string, status: string, createdAt: string): WorkItem {
  return {
    id, kind: "finding", title: `Finding ${id}`, body: "",
    status: status as WorkItem["status"], priority: 3,
    source: "scanner", createdAt, updatedAt: "",
  };
}

function openPR(branch: string): CodeReview {
  return {
    id: 1, title: "x", url: "u", branch, baseBranch: "develop",
    draft: false, labels: [], comments: [], merged: false, closed: false,
  };
}

function makeDeps(state: TestStateManager, extra?: {
  prManager?: PRManager; kv?: KVStore; log?: Logger;
  workItemSource?: ReturnType<typeof makeWorkItemSource>;
}) {
  const workItemSource = extra?.workItemSource ?? makeWorkItemSource();
  return {
    deps: {
      state,
      kv: extra?.kv ?? makeKv([DISCOVERY_STAGE_ROW]),
      registry: makeTestKindRegistry(KIND_ENTRIES),
      vcs: new TestVCSPlatform(),
      prManager: extra?.prManager ?? makePrManager(),
      workItemSource,
      log: extra?.log ?? makeLog(),
    },
    workItemSource,
  };
}

describe("reconcileOrphanedItems", () => {
  it("terminalizes a non-terminal finding with no live PR after the stale window (orphaned-finding regression)", async () => {
    const state = new TestStateManager();
    state.workItems.set("F1", finding("F1", "ready-to-merge", OLD));
    const { deps, workItemSource } = makeDeps(state);

    const result = await reconcileOrphanedItems(deps, { now: NOW }, makeCtx());

    expect(result).toEqual({ scanned: 1, terminalized: 1, skipped: 0 });
    expect(workItemSource.updateStatus).toHaveBeenCalledTimes(1);
    const [ref, status, reason] = workItemSource.updateStatus.mock.calls[0];
    expect(ref).toEqual({ id: "F1", kind: "finding" });
    expect(status).toBe("cancelled");
    expect(reason).toContain("no live PR");
    expect(reason).toContain("ready-to-merge");
  });

  it("leaves a finding alone when an open PR still exists", async () => {
    const state = new TestStateManager();
    state.workItems.set("F1", finding("F1", "in-progress", OLD));
    const prManager = makePrManager({ "ai/findings/F1": openPR("ai/findings/F1") });
    const { deps, workItemSource } = makeDeps(state, { prManager });

    const result = await reconcileOrphanedItems(deps, { now: NOW }, makeCtx());

    expect(result).toEqual({ scanned: 1, terminalized: 0, skipped: 1 });
    expect(workItemSource.updateStatus).not.toHaveBeenCalled();
  });

  it("leaves a finding alone when it is not yet past its lifetime", async () => {
    const state = new TestStateManager();
    state.workItems.set("F1", finding("F1", "in-progress", RECENT));
    const { deps, workItemSource } = makeDeps(state);

    const result = await reconcileOrphanedItems(deps, { now: NOW }, makeCtx());

    expect(result).toEqual({ scanned: 1, terminalized: 0, skipped: 1 });
    expect(workItemSource.updateStatus).not.toHaveBeenCalled();
  });

  it("never touches pending backlog or already-terminal findings", async () => {
    const state = new TestStateManager();
    state.workItems.set("F-pending", finding("F-pending", "pending", OLD));
    state.workItems.set("F-cancelled", finding("F-cancelled", "cancelled", OLD));
    state.workItems.set("F-merged", finding("F-merged", "merged", OLD));
    const { deps, workItemSource } = makeDeps(state);

    const result = await reconcileOrphanedItems(deps, { now: NOW }, makeCtx());

    expect(result.scanned).toBe(0);       // none are non-terminal limbo
    expect(result.terminalized).toBe(0);
    expect(workItemSource.updateStatus).not.toHaveBeenCalled();
  });

  it("logs every terminalization with the prior status and reason", async () => {
    const state = new TestStateManager();
    state.workItems.set("F1", finding("F1", "in-review", OLD));
    const log = makeLog();
    const { deps } = makeDeps(state, { log });

    await reconcileOrphanedItems(deps, { now: NOW }, makeCtx());

    const infoCalls = (log.info as ReturnType<typeof vi.fn>).mock.calls;
    const cancelLine = infoCalls.find((c) => String(c[0]).includes("cancelled finding F1"));
    expect(cancelLine).toBeTruthy();
    expect(cancelLine?.[1]).toMatchObject({ itemId: "F1", prevStatus: "in-review" });
  });

  it("is idempotent — an already-cancelled finding is skipped, not re-written", async () => {
    const state = new TestStateManager();
    state.workItems.set("F1", finding("F1", "cancelled", OLD));
    const { deps, workItemSource } = makeDeps(state);

    const result = await reconcileOrphanedItems(deps, { now: NOW }, makeCtx());

    expect(result.terminalized).toBe(0);
    expect(workItemSource.updateStatus).not.toHaveBeenCalled();
  });

  it("resolves discovery kinds from config — no discovery stage means nothing to do", async () => {
    const state = new TestStateManager();
    state.workItems.set("F1", finding("F1", "ready-to-merge", OLD));
    const { deps, workItemSource } = makeDeps(state, { kv: makeKv([]) });

    const result = await reconcileOrphanedItems(deps, { now: NOW }, makeCtx());

    expect(result).toEqual({ scanned: 0, terminalized: 0, skipped: 0 });
    expect(workItemSource.updateStatus).not.toHaveBeenCalled();
  });

  it("skips a discovery kind that is not in the registry", async () => {
    const state = new TestStateManager();
    state.workItems.set("F1", finding("F1", "ready-to-merge", OLD));
    const ghostStage = {
      category: "workflow-stages", key: "ghost",
      value: { selector: "discovery", outputSink: { kind: "ghost" } },
    } as unknown as KVEntry;
    const { deps, workItemSource } = makeDeps(state, { kv: makeKv([ghostStage]) });

    const result = await reconcileOrphanedItems(deps, { now: NOW }, makeCtx());

    expect(result).toEqual({ scanned: 0, terminalized: 0, skipped: 0 });
    expect(workItemSource.updateStatus).not.toHaveBeenCalled();
  });

  it("treats a kind with no branch prefix as having no PR (reaps over-lifetime)", async () => {
    const state = new TestStateManager();
    state.workItems.set("F1", finding("F1", "in-progress", OLD));
    const noPrefixRegistry = makeTestKindRegistry([
      { ...KIND_ENTRIES[0], branchPrefix: "" },
    ]);
    const workItemSource = makeWorkItemSource();
    const result = await reconcileOrphanedItems(
      {
        state, kv: makeKv([DISCOVERY_STAGE_ROW]), registry: noPrefixRegistry,
        vcs: new TestVCSPlatform(), prManager: makePrManager(),
        workItemSource, log: makeLog(),
      },
      { now: NOW },
      makeCtx(),
    );

    expect(result).toEqual({ scanned: 1, terminalized: 1, skipped: 0 });
    expect(workItemSource.updateStatus).toHaveBeenCalledTimes(1);
  });

  it("reaps stuck TASKS too — reapable kinds come from any producing stage, not just discovery", async () => {
    const state = new TestStateManager();
    state.workItems.set("T1", { ...finding("T1", "ready-to-merge", OLD), kind: "task" });
    const taskStage = {
      category: "workflow-stages", key: "finding-plan",
      value: { selector: "per-item", outputSink: { kind: "task" } },
    } as unknown as KVEntry;
    const { deps, workItemSource } = makeDeps(state, { kv: makeKv([taskStage]) });

    const result = await reconcileOrphanedItems(deps, { now: NOW }, makeCtx());

    expect(result).toEqual({ scanned: 1, terminalized: 1, skipped: 0 });
    const [ref, status] = workItemSource.updateStatus.mock.calls[0];
    expect(ref).toEqual({ id: "T1", kind: "task" });
    expect(status).toBe("cancelled");
  });

  it("ignores a stage that declares no output kind", async () => {
    const state = new TestStateManager();
    state.workItems.set("F1", finding("F1", "ready-to-merge", OLD));
    const noKindStage = {
      category: "workflow-stages", key: "research",
      value: { selector: "discovery", outputSink: {} },
    } as unknown as KVEntry;
    const { deps, workItemSource } = makeDeps(state, { kv: makeKv([noKindStage]) });

    const result = await reconcileOrphanedItems(deps, { now: NOW }, makeCtx());

    expect(result).toEqual({ scanned: 0, terminalized: 0, skipped: 0 });
    expect(workItemSource.updateStatus).not.toHaveBeenCalled();
  });

  it("treats a closed (un-merged) PR as no live PR and reaps over-lifetime", async () => {
    const state = new TestStateManager();
    state.workItems.set("F1", finding("F1", "ready-to-merge", OLD));
    const vcs = new TestVCSPlatform();
    vcs.codeReviews = [{
      id: 9, title: "x", url: "u", branch: "ai/findings/F1", baseBranch: "develop",
      draft: false, labels: [], comments: [], merged: false, closed: true,
    }];
    const workItemSource = makeWorkItemSource();
    const result = await reconcileOrphanedItems(
      {
        state, kv: makeKv([DISCOVERY_STAGE_ROW]), registry: makeTestKindRegistry(KIND_ENTRIES),
        vcs, prManager: makePrManager(), workItemSource, log: makeLog(),
      },
      { now: NOW },
      makeCtx(),
    );

    expect(result).toEqual({ scanned: 1, terminalized: 1, skipped: 0 });
  });

  it("counts a failed terminalization as skipped and warns (never throws)", async () => {
    const state = new TestStateManager();
    state.workItems.set("F1", finding("F1", "ready-to-merge", OLD));
    const workItemSource = makeWorkItemSource();
    workItemSource.updateStatus.mockRejectedValueOnce(new Error("disk full"));
    const log = makeLog();
    const { deps } = makeDeps(state, { workItemSource, log });

    const result = await reconcileOrphanedItems(deps, { now: NOW }, makeCtx());

    expect(result).toEqual({ scanned: 1, terminalized: 0, skipped: 1 });
    expect(log.warn).toHaveBeenCalled();
  });
});
