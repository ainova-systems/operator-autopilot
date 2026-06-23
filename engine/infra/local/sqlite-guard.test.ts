import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OperationContext } from "@operator/core";
import { LocalIdempotencyGuard } from "./sqlite-guard.js";

let tempDir: string;
let guard: LocalIdempotencyGuard;

function makeCtx(): OperationContext {
  return {
    traceId: "test-trace",
    repoId: "test-repo",
    action: "test",
    budget: { spentUsd: 0, add: vi.fn(), isExceeded: () => false },
    signal: AbortSignal.timeout(30_000),
  };
}

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "guard-test-"));
  guard = new LocalIdempotencyGuard(join(tempDir, "guard.db"));
});

afterEach(() => {
  guard.close();
});

describe("LocalIdempotencyGuard", () => {
  it("acquires a new lock", async () => {
    const handle = await guard.acquire("test-key", 60_000, makeCtx());
    expect(handle).not.toBeNull();
    expect(handle?.key).toBe("test-key");
    expect(handle?.lockId).toBeDefined();
    expect(handle?.acquiredAt).toBeDefined();
  });

  it("returns null for already-acquired lock", async () => {
    await guard.acquire("test-key", 60_000, makeCtx());
    const second = await guard.acquire("test-key", 60_000, makeCtx());
    expect(second).toBeNull();
  });

  it("returns null for completed lock (dedup)", async () => {
    const handle = await guard.acquire("test-key", 60_000, makeCtx());
    expect(handle).not.toBeNull();
    await guard.complete(handle!, makeCtx());

    const retry = await guard.acquire("test-key", 60_000, makeCtx());
    expect(retry).toBeNull();
  });

  it("allows re-acquire after release", async () => {
    const handle = await guard.acquire("test-key", 60_000, makeCtx());
    expect(handle).not.toBeNull();
    await guard.release(handle!, makeCtx());

    const second = await guard.acquire("test-key", 60_000, makeCtx());
    expect(second).not.toBeNull();
  });

  it("allows re-acquire after TTL expiry", async () => {
    const handle = await guard.acquire("test-key", 1, makeCtx()); // 1ms TTL
    expect(handle).not.toBeNull();

    // Wait for expiry
    await new Promise((r) => setTimeout(r, 10));

    const second = await guard.acquire("test-key", 60_000, makeCtx());
    expect(second).not.toBeNull();
  });

  it("acquires different keys independently", async () => {
    const h1 = await guard.acquire("key-a", 60_000, makeCtx());
    const h2 = await guard.acquire("key-b", 60_000, makeCtx());
    expect(h1).not.toBeNull();
    expect(h2).not.toBeNull();
  });

  it("complete extends expiry for dedup window", async () => {
    const handle = await guard.acquire("test-key", 1, makeCtx()); // 1ms TTL
    await guard.complete(handle!, makeCtx());

    // Even after original TTL, completed lock blocks re-acquire
    await new Promise((r) => setTimeout(r, 10));
    const retry = await guard.acquire("test-key", 60_000, makeCtx());
    expect(retry).toBeNull();
  });

  it("release only removes matching lockId", async () => {
    const handle = await guard.acquire("test-key", 60_000, makeCtx());
    // Release with wrong lockId — should not remove
    await guard.release({ key: "test-key", lockId: "wrong-id", acquiredAt: "" }, makeCtx());

    // Original lock still held
    const second = await guard.acquire("test-key", 60_000, makeCtx());
    expect(second).toBeNull();

    // Release with correct lockId
    await guard.release(handle!, makeCtx());
    const third = await guard.acquire("test-key", 60_000, makeCtx());
    expect(third).not.toBeNull();
  });

  it("persists across close and reopen", async () => {
    const dbPath = join(tempDir, "persist.db");
    const g1 = new LocalIdempotencyGuard(dbPath);
    const handle = await g1.acquire("test-key", 60_000, makeCtx());
    await g1.complete(handle!, makeCtx());
    g1.close();

    const g2 = new LocalIdempotencyGuard(dbPath);
    const retry = await g2.acquire("test-key", 60_000, makeCtx());
    expect(retry).toBeNull(); // Still completed
    g2.close();
  });
});
