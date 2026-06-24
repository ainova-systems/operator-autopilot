import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OperationContext, KVStore, KVEntry, WorkItem } from "@operator/core";
import type { Logger } from "../../logging/logger.js";
import { TestStateManager } from "../../test-helpers/test-state-manager.js";
import { makeTestKindRegistry } from "../../test-helpers/test-kind-registry.js";
import { buildRejectionLearningBrief } from "./rejection-learning.js";

let workspace = "";

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "rejection-learning-"));
  await mkdir(join(workspace, ".operator", "analyst"), { recursive: true });
});

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
});

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

const DISCOVERY_STAGE = {
  category: "workflow-stages", key: "research",
  value: {
    selector: "discovery", outputSink: { kind: "finding" },
    selectorConfig: { discoveryDir: ".operator/analyst" },
  },
} as unknown as KVEntry;

function makeKv(rows: KVEntry[]): KVStore {
  return { list: vi.fn(async (cat: string) => (cat === "workflow-stages" ? rows : [])) } as unknown as KVStore;
}

function finding(id: string, status: string, source: string, createdAt = "2026-05-01T00:00:00Z"): WorkItem {
  return {
    id, kind: "finding", title: `Finding ${id}`, body: "",
    status: status as WorkItem["status"], priority: 3, source, createdAt, updatedAt: "",
  };
}

async function writeAnalyzer(name: string): Promise<void> {
  await writeFile(join(workspace, ".operator", "analyst", `${name}.md`), "---\nschedule: daily\n---\nrules", "utf-8");
}

function deps(state: TestStateManager, kv: KVStore, log?: Logger) {
  return {
    state, kv, registry: makeTestKindRegistry(), workspacePath: workspace, log: log ?? makeLog(),
  };
}

describe("buildRejectionLearningBrief", () => {
  it("groups rejected/duplicate findings by analyzer with the resolved prompt path", async () => {
    await writeAnalyzer("security");
    await writeAnalyzer("backend-coverage");
    const state = new TestStateManager();
    state.workItems.set("F1", finding("F1", "rejected", "security#FINDING-001"));
    state.workItems.set("F2", finding("F2", "duplicate", "backend-coverage#FINDING-002"));
    state.workItems.set("F3", finding("F3", "merged", "security#FINDING-003")); // not learnable

    const brief = await buildRejectionLearningBrief(deps(state, makeKv([DISCOVERY_STAGE])), makeCtx());

    expect(brief).toContain("## Analyzer Rejection Learning");
    expect(brief).toContain(".operator/analyst/security.md");
    expect(brief).toContain(".operator/analyst/backend-coverage.md");
    expect(brief).toContain("F1 [rejected]");
    expect(brief).toContain("F2 [duplicate]");
    expect(brief).not.toContain("F3"); // merged is not a learnable rejection
  });

  it("skips synthetic duplicate-of sources", async () => {
    await writeAnalyzer("security");
    const state = new TestStateManager();
    state.workItems.set("F1", finding("F1", "rejected", "duplicate-of:F20260101-0001"));

    const brief = await buildRejectionLearningBrief(deps(state, makeKv([DISCOVERY_STAGE])), makeCtx());

    expect(brief).toBe("");
  });

  it("skips findings whose analyzer prompt file does not exist", async () => {
    // no analyzer file written
    const state = new TestStateManager();
    state.workItems.set("F1", finding("F1", "rejected", "ghost-analyzer#FINDING-001"));

    const brief = await buildRejectionLearningBrief(deps(state, makeKv([DISCOVERY_STAGE])), makeCtx());

    expect(brief).toBe("");
  });

  it("skips findings with no source", async () => {
    await writeAnalyzer("security");
    const state = new TestStateManager();
    state.workItems.set("F1", { ...finding("F1", "rejected", "security#x"), source: undefined });

    const brief = await buildRejectionLearningBrief(deps(state, makeKv([DISCOVERY_STAGE])), makeCtx());

    expect(brief).toBe("");
  });

  it("returns empty when there are no discovery stages", async () => {
    const state = new TestStateManager();
    state.workItems.set("F1", finding("F1", "rejected", "security#x"));

    const brief = await buildRejectionLearningBrief(deps(state, makeKv([])), makeCtx());

    expect(brief).toBe("");
  });

  it("ignores non-discovery stages and defaults discoveryDir when unset", async () => {
    await writeAnalyzer("security");
    const state = new TestStateManager();
    state.workItems.set("F1", finding("F1", "rejected", "security#FINDING-001"));
    const rows = [
      { category: "workflow-stages", key: "pr-review", value: { selector: "pr-feedback", outputSink: {} } } as unknown as KVEntry,
      // discovery stage with NO discoveryConfig → defaults to .operator/analyst
      { category: "workflow-stages", key: "research", value: { selector: "discovery", outputSink: { kind: "finding" } } } as unknown as KVEntry,
    ];

    const brief = await buildRejectionLearningBrief(deps(state, makeKv(rows)), makeCtx());

    expect(brief).toContain(".operator/analyst/security.md");
  });

  it("ignores discovery stages with no output kind", async () => {
    await writeAnalyzer("security");
    const state = new TestStateManager();
    state.workItems.set("F1", finding("F1", "rejected", "security#x"));
    const row = { category: "workflow-stages", key: "research", value: { selector: "discovery", outputSink: {} } } as unknown as KVEntry;

    const brief = await buildRejectionLearningBrief(deps(state, makeKv([row])), makeCtx());

    expect(brief).toBe("");
  });

  it("caps the list at 10 most-recent rejections per analyzer", async () => {
    await writeAnalyzer("security");
    const state = new TestStateManager();
    for (let i = 0; i < 14; i++) {
      const id = `F${String(i).padStart(2, "0")}`;
      state.workItems.set(id, finding(id, "rejected", "security#x", `2026-05-${String(i + 1).padStart(2, "0")}T00:00:00Z`));
    }

    const brief = await buildRejectionLearningBrief(deps(state, makeKv([DISCOVERY_STAGE])), makeCtx());

    expect(brief).toContain("10 rejected/duplicate finding(s)");
    expect(brief).toContain("F13"); // newest kept
    expect(brief).not.toContain("F00"); // oldest dropped past the cap
  });
});
