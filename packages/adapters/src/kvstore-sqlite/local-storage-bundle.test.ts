import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OperationContext } from "@operator/core";
import { LocalStorageBundle } from "./local-storage-bundle.js";

function makeCtx(): OperationContext {
  return {
    traceId: "test-trace",
    repoId: "test",
    action: "test",
    budget: {
      limitUsd: undefined,
      spentUsd: 0,
      add: () => {},
      isExceeded: () => false,
    },
    signal: AbortSignal.timeout(60_000),
  };
}

describe("LocalStorageBundle — KVStore", () => {
  let dir: string;
  let bundle: LocalStorageBundle;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kvstore-"));
    bundle = new LocalStorageBundle({ dbPath: join(dir, "test.db") });
  });

  afterEach(() => {
    bundle.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("round-trips primitive values through put/get", async () => {
    await bundle.put("prompts", "creator", { body: "hello" });
    const entry = await bundle.get("prompts", "creator");
    expect(entry).not.toBeNull();
    expect(entry?.key).toBe("creator");
    expect(entry?.value).toEqual({ body: "hello" });
    expect(entry?.metadata).toBeUndefined();
  });

  it("returns null for missing keys", async () => {
    expect(await bundle.get("prompts", "nonexistent")).toBeNull();
  });

  it("persists and returns metadata", async () => {
    await bundle.put("repos", "sample", { id: "sample" }, {
      metadata: { source: "yaml", readonly: true },
    });
    const entry = await bundle.get("repos", "sample");
    expect(entry?.metadata).toEqual({ source: "yaml", readonly: true });
  });

  it("updates value and metadata on repeat put (upsert)", async () => {
    await bundle.put("repos", "sample", { version: 1 }, {
      metadata: { source: "yaml", readonly: true },
    });
    await bundle.put("repos", "sample", { version: 2 }, {
      metadata: { source: "ui", readonly: false },
    });
    const entry = await bundle.get("repos", "sample");
    expect(entry?.value).toEqual({ version: 2 });
    expect(entry?.metadata).toEqual({ source: "ui", readonly: false });
  });

  it("deletes rows", async () => {
    await bundle.put("prompts", "creator", { body: "x" });
    await bundle.delete("prompts", "creator");
    expect(await bundle.get("prompts", "creator")).toBeNull();
  });

  it("lists rows in the category sorted by key", async () => {
    await bundle.put("prompts", "planner", { body: "p" });
    await bundle.put("prompts", "creator", { body: "c" });
    await bundle.put("prompts", "reviewer", { body: "r" });
    const entries = await bundle.list("prompts");
    expect(entries.map((e) => e.key)).toEqual(["creator", "planner", "reviewer"]);
  });

  it("isolates categories in list", async () => {
    await bundle.put("prompts", "a", { body: "a" });
    await bundle.put("templates", "a", { body: "t" });
    const prompts = await bundle.list("prompts");
    const templates = await bundle.list("templates");
    expect(prompts).toHaveLength(1);
    expect(templates).toHaveLength(1);
    expect(prompts[0]?.value).toEqual({ body: "a" });
    expect(templates[0]?.value).toEqual({ body: "t" });
  });

  it("filters list by keyPrefix", async () => {
    await bundle.put("prompts", "agents/creator", { body: "c" });
    await bundle.put("prompts", "agents/planner", { body: "p" });
    await bundle.put("prompts", "context/base", { body: "b" });
    const agentOnly = await bundle.list("prompts", { keyPrefix: "agents/" });
    expect(agentOnly.map((e) => e.key)).toEqual(["agents/creator", "agents/planner"]);
  });

  it("filters list by where clause on JSON fields", async () => {
    await bundle.put("repos", "a", { id: "a", active: true });
    await bundle.put("repos", "b", { id: "b", active: false });
    await bundle.put("repos", "c", { id: "c", active: true });
    const active = await bundle.list("repos", { where: { active: true } });
    expect(active.map((e) => e.key).sort()).toEqual(["a", "c"]);
  });

  it("honors limit and offset", async () => {
    for (const k of ["a", "b", "c", "d", "e"]) {
      await bundle.put("prompts", k, { body: k });
    }
    const page = await bundle.list("prompts", { limit: 2, offset: 1 });
    expect(page.map((e) => e.key)).toEqual(["b", "c"]);
  });

  it("supports descending order on key", async () => {
    await bundle.put("prompts", "a", {});
    await bundle.put("prompts", "b", {});
    await bundle.put("prompts", "c", {});
    const desc = await bundle.list("prompts", { orderBy: "key", order: "desc" });
    expect(desc.map((e) => e.key)).toEqual(["c", "b", "a"]);
  });

  it("ignores unsafe orderBy columns", async () => {
    await bundle.put("prompts", "a", {});
    await bundle.put("prompts", "b", {});
    const entries = await bundle.list("prompts", {
      orderBy: "value; DROP TABLE kv",
    });
    expect(entries.map((e) => e.key)).toEqual(["a", "b"]);
  });

  it("expires rows with ttlMs", async () => {
    await bundle.put("prompts", "short", { body: "x" }, { ttlMs: -1 });
    expect(await bundle.get("prompts", "short")).toBeNull();
  });

  it("preserves non-expired ttl rows", async () => {
    await bundle.put("prompts", "long", { body: "x" }, { ttlMs: 60_000 });
    const entry = await bundle.get("prompts", "long");
    expect(entry?.value).toEqual({ body: "x" });
  });
});

describe("LocalStorageBundle — IdempotencyGuard", () => {
  let dir: string;
  let bundle: LocalStorageBundle;
  const ctx = makeCtx();

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "guard-"));
    bundle = new LocalStorageBundle({ dbPath: join(dir, "test.db") });
  });

  afterEach(() => {
    bundle.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("acquire returns a handle for an unused key", async () => {
    const handle = await bundle.acquire("k1", 5_000, ctx);
    expect(handle).not.toBeNull();
    expect(handle?.key).toBe("k1");
    expect(handle?.lockId).toBeTypeOf("string");
  });

  it("second acquire on same active key returns null", async () => {
    await bundle.acquire("k1", 5_000, ctx);
    const second = await bundle.acquire("k1", 5_000, ctx);
    expect(second).toBeNull();
  });

  it("release allows re-acquire", async () => {
    const h1 = await bundle.acquire("k1", 5_000, ctx);
    expect(h1).not.toBeNull();
    await bundle.release(h1!, ctx);
    const h2 = await bundle.acquire("k1", 5_000, ctx);
    expect(h2).not.toBeNull();
  });

  it("complete blocks re-acquire within dedup window", async () => {
    const h1 = await bundle.acquire("k1", 5_000, ctx);
    expect(h1).not.toBeNull();
    await bundle.complete(h1!, ctx);
    const h2 = await bundle.acquire("k1", 5_000, ctx);
    expect(h2).toBeNull();
  });

  it("expired active lock can be re-acquired", async () => {
    const h1 = await bundle.acquire("k1", 1, ctx);
    expect(h1).not.toBeNull();
    await new Promise((r) => setTimeout(r, 10));
    const h2 = await bundle.acquire("k1", 5_000, ctx);
    expect(h2).not.toBeNull();
  });
});

describe("LocalStorageBundle — RateLimiter", () => {
  let dir: string;
  let bundle: LocalStorageBundle;
  const ctx = makeCtx();

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "rate-"));
    bundle = new LocalStorageBundle({ dbPath: join(dir, "test.db") });
  });

  afterEach(() => {
    bundle.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("allows requests within the default quota", async () => {
    const r = await bundle.allow("bucket", 1, ctx);
    expect(r.allowed).toBe(true);
    expect(r.retryAfterMs).toBeUndefined();
  });

  it("rejects when cost exceeds remaining tokens", async () => {
    const r1 = await bundle.allow("bucket", 60, ctx);
    expect(r1.allowed).toBe(true);
    const r2 = await bundle.allow("bucket", 60, ctx);
    expect(r2.allowed).toBe(false);
    expect(r2.retryAfterMs).toBeGreaterThan(0);
  });

  it("reset restores quota", async () => {
    await bundle.allow("bucket", 60, ctx);
    await bundle.reset("bucket");
    const r = await bundle.allow("bucket", 60, ctx);
    expect(r.allowed).toBe(true);
  });

  it("refills tokens over time", async () => {
    await bundle.allow("bucket", 60, ctx);
    await new Promise((r) => setTimeout(r, 1100));
    const r = await bundle.allow("bucket", 1, ctx);
    expect(r.allowed).toBe(true);
  });
});
