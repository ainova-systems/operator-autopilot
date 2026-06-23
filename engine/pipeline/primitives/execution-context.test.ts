import { describe, it, expect, vi } from "vitest";
import type { KVStore, KVEntry } from "@operator/core";
import {
  buildExecutionHistoryBlock,
  EXECUTION_HISTORY_LIMIT,
  EXECUTION_HISTORY_CHAR_CAP,
} from "./execution-context.js";

function makeKV(rows: Array<{ key: string; value: unknown }>): KVStore {
  return {
    get: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
    close: vi.fn(),
    list: vi.fn(async () => rows.map((r): KVEntry => ({ key: r.key, value: r.value }))),
  };
}

describe("buildExecutionHistoryBlock", () => {
  it("returns empty string when kv or workItemId is missing", async () => {
    expect(await buildExecutionHistoryBlock(undefined, "T1")).toBe("");
    expect(await buildExecutionHistoryBlock(makeKV([]), undefined)).toBe("");
  });

  it("returns empty string when no execution for the work item has a summary", async () => {
    const kv = makeKV([
      { key: "e1", value: { workItemId: "T2", summary: "other item" } },
      { key: "e2", value: { workItemId: "T1", summary: "" } },
    ]);
    const block = await buildExecutionHistoryBlock(kv, "T1");
    expect(block).toBe("");
  });

  it("renders a markdown block with the N most recent summaries", async () => {
    const kv = makeKV([
      { key: "e1", value: { workItemId: "T1", stageName: "task-execute", verdict: "failed", startedAt: "2026-04-10T10:00:00Z", summary: "first attempt broke tests" } },
      { key: "e2", value: { workItemId: "T1", stageName: "task-execute", verdict: "approved", startedAt: "2026-04-11T10:00:00Z", summary: "fix landed" } },
      { key: "e3", value: { workItemId: "T1", stageName: "task-execute", verdict: "retry", startedAt: "2026-04-12T10:00:00Z", summary: "needs tests" } },
      { key: "e4", value: { workItemId: "T1", stageName: "task-execute", verdict: "approved", startedAt: "2026-04-13T10:00:00Z", summary: "tests added" } },
    ]);
    const block = await buildExecutionHistoryBlock(kv, "T1");
    expect(block).toContain("## Execution History");
    expect(block).toContain("tests added"); // most recent
    expect(block).toContain("needs tests");
    expect(block).toContain("fix landed");
    expect(block).not.toContain("first attempt broke tests"); // past the N limit
    const attemptHeaders = block.match(/^### Attempt /gm);
    expect(attemptHeaders?.length).toBe(EXECUTION_HISTORY_LIMIT);
  });

  it("truncates each summary to the char cap", async () => {
    const longSummary = "x".repeat(EXECUTION_HISTORY_CHAR_CAP + 200);
    const kv = makeKV([
      { key: "e1", value: { workItemId: "T1", stageName: "task", verdict: "approved", summary: longSummary, startedAt: "2026-04-14T10:00:00Z" } },
    ]);
    const block = await buildExecutionHistoryBlock(kv, "T1");
    const lines = block.split("\n");
    const summaryLine = lines.find((l) => l.startsWith("x"));
    expect(summaryLine?.length).toBeLessThanOrEqual(EXECUTION_HISTORY_CHAR_CAP);
  });

  it("sorts by startedAt desc and picks the most recent N", async () => {
    const kv = makeKV([
      { key: "e-old", value: { workItemId: "T1", startedAt: "2026-04-01T00:00:00Z", summary: "old" } },
      { key: "e-new", value: { workItemId: "T1", startedAt: "2026-04-15T00:00:00Z", summary: "new" } },
    ]);
    const block = await buildExecutionHistoryBlock(kv, "T1");
    const firstIdx = block.indexOf("new");
    const secondIdx = block.indexOf("old");
    expect(firstIdx).toBeLessThan(secondIdx);
  });
});
