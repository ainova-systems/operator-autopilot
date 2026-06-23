import { describe, it, expect } from "vitest";
import type { OperationContext } from "@operator/core";
import { createScratchStore } from "./scratch.js";

function makeCtx(traceId = "trace-1"): OperationContext {
  return {
    traceId,
    repoId: "repo",
    action: "test",
    budget: { spentUsd: 0, add: () => {}, isExceeded: () => false },
    signal: AbortSignal.timeout(1_000),
  };
}

describe("createScratchStore", () => {
  it("returns undefined before set is called", () => {
    const store = createScratchStore<{ n: number }>();
    expect(store.get(makeCtx(), "key")).toBeUndefined();
  });

  it("round-trips a value through set/get", () => {
    const store = createScratchStore<{ n: number }>();
    const ctx = makeCtx();
    store.set(ctx, "key", { n: 42 });
    expect(store.get(ctx, "key")).toEqual({ n: 42 });
  });

  it("scopes entries by traceId so concurrent cycles do not collide", () => {
    const store = createScratchStore<string>();
    const ctxA = makeCtx("trace-A");
    const ctxB = makeCtx("trace-B");
    store.set(ctxA, "shared-key", "A");
    store.set(ctxB, "shared-key", "B");
    expect(store.get(ctxA, "shared-key")).toBe("A");
    expect(store.get(ctxB, "shared-key")).toBe("B");
  });

  it("clear removes the entry for the given cycle", () => {
    const store = createScratchStore<number>();
    const ctx = makeCtx();
    store.set(ctx, "k", 1);
    expect(store.size).toBe(1);
    store.clear(ctx, "k");
    expect(store.size).toBe(0);
    expect(store.get(ctx, "k")).toBeUndefined();
  });

  it("clear is idempotent when called without a prior set (finally-block safety)", () => {
    const store = createScratchStore<number>();
    const ctx = makeCtx();
    expect(() => store.clear(ctx, "never-set")).not.toThrow();
    expect(store.size).toBe(0);
  });

  it("set replaces an existing entry for the same traceId+key", () => {
    const store = createScratchStore<string>();
    const ctx = makeCtx();
    store.set(ctx, "k", "first");
    store.set(ctx, "k", "second");
    expect(store.get(ctx, "k")).toBe("second");
    expect(store.size).toBe(1);
  });

  it("clear only removes the matching cycle entry, leaving other cycles intact", () => {
    const store = createScratchStore<string>();
    const ctxA = makeCtx("trace-A");
    const ctxB = makeCtx("trace-B");
    store.set(ctxA, "k", "A");
    store.set(ctxB, "k", "B");
    store.clear(ctxA, "k");
    expect(store.get(ctxA, "k")).toBeUndefined();
    expect(store.get(ctxB, "k")).toBe("B");
    expect(store.size).toBe(1);
  });
});
