import { describe, it, expect, vi } from "vitest";
import type { OperationContext, KVEntry } from "@operator/core";
import {
  ExecutionHistoryWriter,
  newExecutionId,
  appendRecentExecutionId,
  RECENT_EXECUTION_LIMIT,
} from "./execution-history.js";

function makeCtx(): OperationContext {
  return {
    traceId: "trace-1",
    repoId: "sample",
    action: "test",
    budget: { limitUsd: undefined, spentUsd: 0, add: () => {}, isExceeded: () => false },
    signal: AbortSignal.timeout(10_000),
  };
}

function makeFakeKV() {
  const store = new Map<string, unknown>();
  return {
    store,
    get: vi.fn(async (category: string, key: string): Promise<KVEntry | null> => {
      const v = store.get(`${category}/${key}`);
      return v == null ? null : { key, value: v };
    }),
    put: vi.fn(async (category: string, key: string, value: unknown): Promise<void> => {
      store.set(`${category}/${key}`, value);
    }),
  };
}

describe("newExecutionId", () => {
  it("composes stage-trace-timestamp", () => {
    const id = newExecutionId("task-execute", makeCtx());
    expect(id).toMatch(/^task-execute-trace-1-\d+$/);
  });
});

describe("ExecutionHistoryWriter", () => {
  it("start() writes the initial executions row with status=running", async () => {
    const kv = makeFakeKV();
    const id = newExecutionId("init", makeCtx());
    const writer = new ExecutionHistoryWriter(id, kv);

    await writer.start({
      traceId: "t", repoId: "r", stageName: "init",
      agent: "scout", scopeKey: "init",
      startedAt: "2026-04-17T10:00:00Z",
    }, makeCtx());

    expect(kv.put).toHaveBeenCalledWith("executions", id, expect.objectContaining({
      id, status: "running", stageName: "init", agent: "scout",
    }));
  });

  it("event() appends rows with incrementing seq and zero-padded keys", async () => {
    const kv = makeFakeKV();
    const writer = new ExecutionHistoryWriter("e-1", kv);

    await writer.event("stage.started", "hello", { x: 1 });
    await writer.event("agent.spawned", "world");

    const keys = kv.put.mock.calls
      .filter((c) => c[0] === "execution-events")
      .map((c) => c[1]);
    expect(keys).toEqual(["e-1/0000", "e-1/0001"]);
    const firstRow = kv.put.mock.calls.find((c) => c[1] === "e-1/0000")?.[2] as {
      seq: number; type: string; payload: { x: number };
    };
    expect(firstRow.seq).toBe(0);
    expect(firstRow.type).toBe("stage.started");
    expect(firstRow.payload).toEqual({ x: 1 });
  });

  it("finalize() merges with start, updates status/verdict/duration, writes log blob", async () => {
    const kv = makeFakeKV();
    const writer = new ExecutionHistoryWriter("e-42", kv);

    await writer.start({
      traceId: "t", repoId: "r", stageName: "task-execute", agent: "creator",
      scopeKey: "T1", startedAt: "2026-04-17T10:00:00Z",
    }, makeCtx());
    await writer.event("agent.spawned", "creator started");
    writer.appendLog("extra log line");
    await writer.finalize({
      finishedAt: "2026-04-17T10:05:00Z", durationMs: 300_000,
      status: "completed", verdict: "approved", summary: "all green", prNumber: 774,
      attempts: 1,
    }, makeCtx());

    const finalCall = kv.put.mock.calls.find(
      (c) => c[0] === "executions" && c[1] === "e-42" && (c[2] as { status: string }).status === "completed",
    );
    const finalEntry = finalCall?.[2] as {
      stageName: string; agent: string; verdict: string; prNumber: number; durationMs: number;
    };
    expect(finalEntry.stageName).toBe("task-execute");
    expect(finalEntry.agent).toBe("creator");
    expect(finalEntry.verdict).toBe("approved");
    expect(finalEntry.prNumber).toBe(774);
    expect(finalEntry.durationMs).toBe(300_000);

    const logBlob = kv.put.mock.calls.find((c) => c[0] === "execution-logs")?.[2] as {
      body: string; lineCount: number;
    };
    expect(logBlob.body).toContain("execution started");
    expect(logBlob.body).toContain("agent.spawned");
    expect(logBlob.body).toContain("extra log line");
    expect(logBlob.body).toContain("execution finalized");
    expect(logBlob.lineCount).toBeGreaterThan(0);
  });

  it("stamps ctx.instanceId on the running row and preserves it through finalize", async () => {
    const kv = makeFakeKV();
    const writer = new ExecutionHistoryWriter("e-inst", kv);
    const ctxWithInstance: OperationContext = { ...makeCtx(), instanceId: "inst-abc" };

    await writer.start({
      traceId: "t", repoId: "r", stageName: "task-execute",
      startedAt: "2026-04-17T10:00:00Z",
    }, ctxWithInstance);
    const startCall = kv.put.mock.calls.find(
      (c) => c[0] === "executions" && c[1] === "e-inst" && (c[2] as { status: string }).status === "running",
    )?.[2] as { instanceId?: string };
    expect(startCall.instanceId).toBe("inst-abc");

    // finalize with a ctx that has NO instanceId — the prior row's value wins.
    await writer.finalize({
      finishedAt: "2026-04-17T10:01:00Z", durationMs: 60_000, status: "completed",
    }, makeCtx());
    const finalEntry = kv.put.mock.calls.findLast(
      (c) => c[0] === "executions" && c[1] === "e-inst",
    )?.[2] as { instanceId?: string };
    expect(finalEntry.instanceId).toBe("inst-abc");
  });

  it("falls back to ctx.instanceId on finalize when the prior row is missing", async () => {
    const kv = makeFakeKV();
    const writer = new ExecutionHistoryWriter("e-orphan-inst", kv);
    const ctxWithInstance: OperationContext = { ...makeCtx(), instanceId: "inst-fallback" };

    await writer.finalize({
      finishedAt: "2026-04-17T10:00:00Z", durationMs: 1, status: "failed",
    }, ctxWithInstance);

    const entry = kv.put.mock.calls.find(
      (c) => c[0] === "executions" && c[1] === "e-orphan-inst",
    )?.[2] as { instanceId?: string };
    expect(entry.instanceId).toBe("inst-fallback");
  });

  it("finalize() without prior start still writes a valid executions row", async () => {
    const kv = makeFakeKV();
    const writer = new ExecutionHistoryWriter("e-orphan", kv);

    await writer.finalize({
      finishedAt: "2026-04-17T11:00:00Z", durationMs: 1,
      status: "failed", error: "crashed",
    }, makeCtx());

    const entry = kv.put.mock.calls.find(
      (c) => c[0] === "executions" && c[1] === "e-orphan",
    )?.[2] as { status: string; error: string };
    expect(entry.status).toBe("failed");
    expect(entry.error).toBe("crashed");
  });
});

describe("appendRecentExecutionId", () => {
  it("prepends new execution id to the ring buffer", async () => {
    const kv = makeFakeKV();
    kv.store.set("work-items/T1", { id: "T1", recentExecutionIds: ["e-old-1", "e-old-2"] });

    await appendRecentExecutionId(kv, "T1", "e-new");

    const updated = kv.put.mock.calls.find((c) => c[0] === "work-items")?.[2] as {
      recentExecutionIds: string[];
    };
    expect(updated.recentExecutionIds).toEqual(["e-new", "e-old-1", "e-old-2"]);
  });

  it("deduplicates when the same id is appended twice", async () => {
    const kv = makeFakeKV();
    kv.store.set("work-items/T1", { id: "T1", recentExecutionIds: ["e-a"] });

    await appendRecentExecutionId(kv, "T1", "e-a");

    const updated = kv.put.mock.calls.find((c) => c[0] === "work-items")?.[2] as {
      recentExecutionIds: string[];
    };
    expect(updated.recentExecutionIds).toEqual(["e-a"]);
  });

  it(`caps the buffer at ${RECENT_EXECUTION_LIMIT} entries`, async () => {
    const kv = makeFakeKV();
    const existing = Array.from({ length: RECENT_EXECUTION_LIMIT }, (_, i) => `e-${i}`);
    kv.store.set("work-items/T1", { id: "T1", recentExecutionIds: existing });

    await appendRecentExecutionId(kv, "T1", "e-new");

    const updated = kv.put.mock.calls.find((c) => c[0] === "work-items")?.[2] as {
      recentExecutionIds: string[];
    };
    expect(updated.recentExecutionIds.length).toBe(RECENT_EXECUTION_LIMIT);
    expect(updated.recentExecutionIds[0]).toBe("e-new");
  });

  it("no-ops when the work item row does not exist", async () => {
    const kv = makeFakeKV();
    await appendRecentExecutionId(kv, "T-missing", "e-x");
    expect(kv.put).not.toHaveBeenCalled();
  });
});
