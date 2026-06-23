import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir, platform } from "node:os";
import { join } from "node:path";
import type { OperationContext, KVStore, KVEntry, WorkspaceInitEntry } from "@operator/core";
import { ensureWorkspaceInit } from "./workspace-init.js";

class FakeKV implements KVStore {
  private readonly rows = new Map<string, { value: unknown }>();
  async get(category: string, key: string): Promise<KVEntry | null> {
    const v = this.rows.get(`${category}/${key}`);
    return v ? { key, value: v.value } : null;
  }
  async put(category: string, key: string, value: unknown): Promise<void> {
    this.rows.set(`${category}/${key}`, { value });
  }
  async list(): Promise<KVEntry[]> { return []; }
  async delete(category: string, key: string): Promise<void> {
    this.rows.delete(`${category}/${key}`);
  }
  close(): void { /* no-op */ }
}

function makeCtx(timeoutMs = 30_000): OperationContext {
  return {
    traceId: "t", repoId: "r", action: "test",
    budget: { spentUsd: 0, add: () => {}, isExceeded: () => false },
    signal: AbortSignal.timeout(timeoutMs),
  };
}

const log = {
  debug: () => {}, info: () => {}, warn: () => {}, error: () => {},
  child: () => log,
};

describe("ensureWorkspaceInit", () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "ws-init-")); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it("no-ops when initCommand is empty/undefined", async () => {
    const kv = new FakeKV();
    const r1 = await ensureWorkspaceInit({
      repoId: "sample", workspacePath: dir, initCommand: undefined,
      kv, ctx: makeCtx(), log,
    });
    expect(r1).toEqual({ ran: false, cached: false, reason: "no-init-script" });
    const r2 = await ensureWorkspaceInit({
      repoId: "sample", workspacePath: dir, initCommand: "  ",
      kv, ctx: makeCtx(), log,
    });
    expect(r2.ran).toBe(false);
  });

  it("runs init on first invocation and caches the hash", async () => {
    const kv = new FakeKV();
    await writeFile(join(dir, "package-lock.json"), '{"lockfileVersion":3}');
    const result = await ensureWorkspaceInit({
      repoId: "sample", workspacePath: dir,
      initCommand: platform() === "win32" ? "cmd /c exit 0" : "true",
      kv, ctx: makeCtx(), log,
    });
    expect(result.ran).toBe(true);
    expect(result.reason).toBe("first-run");
    const cached = await kv.get("workspace-init", "sample");
    expect(cached).not.toBeNull();
    const entry = cached!.value as WorkspaceInitEntry;
    expect(entry.repoId).toBe("sample");
    expect(entry.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(entry.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("skips re-running when lock files and command match the cached hash", async () => {
    const kv = new FakeKV();
    await writeFile(join(dir, "package-lock.json"), '{"lockfileVersion":3}');
    const cmd = platform() === "win32" ? "cmd /c exit 0" : "true";
    await ensureWorkspaceInit({
      repoId: "sample", workspacePath: dir, initCommand: cmd,
      kv, ctx: makeCtx(), log,
    });
    const second = await ensureWorkspaceInit({
      repoId: "sample", workspacePath: dir, initCommand: cmd,
      kv, ctx: makeCtx(), log,
    });
    expect(second).toEqual({ ran: false, cached: true, reason: "hash-match" });
  });

  it("re-runs when a lock file changes content", async () => {
    const kv = new FakeKV();
    const lockPath = join(dir, "package-lock.json");
    const cmd = platform() === "win32" ? "cmd /c exit 0" : "true";
    await writeFile(lockPath, '{"lockfileVersion":3,"name":"v1"}');
    await ensureWorkspaceInit({
      repoId: "sample", workspacePath: dir, initCommand: cmd,
      kv, ctx: makeCtx(), log,
    });
    await writeFile(lockPath, '{"lockfileVersion":3,"name":"v2"}');
    const second = await ensureWorkspaceInit({
      repoId: "sample", workspacePath: dir, initCommand: cmd,
      kv, ctx: makeCtx(), log,
    });
    expect(second.ran).toBe(true);
    expect(second.reason).toBe("hash-changed");
  });

  it("re-runs when initCommand changes even if lock files are identical", async () => {
    const kv = new FakeKV();
    await writeFile(join(dir, "package-lock.json"), "{}");
    const cmd1 = platform() === "win32" ? "cmd /c exit 0" : "true";
    const cmd2 = platform() === "win32" ? "cmd /c rem noop" : ": noop";
    await ensureWorkspaceInit({
      repoId: "sample", workspacePath: dir, initCommand: cmd1,
      kv, ctx: makeCtx(), log,
    });
    const second = await ensureWorkspaceInit({
      repoId: "sample", workspacePath: dir, initCommand: cmd2,
      kv, ctx: makeCtx(), log,
    });
    expect(second.ran).toBe(true);
  });

  it("includes nested lock files (Source/Frontend/package-lock.json) in the hash", async () => {
    const kv = new FakeKV();
    await mkdir(join(dir, "Source", "Frontend"), { recursive: true });
    await writeFile(join(dir, "Source", "Frontend", "package-lock.json"), '{"v":1}');
    const cmd = platform() === "win32" ? "cmd /c exit 0" : "true";
    await ensureWorkspaceInit({
      repoId: "sample", workspacePath: dir, initCommand: cmd,
      kv, ctx: makeCtx(), log,
    });
    await writeFile(join(dir, "Source", "Frontend", "package-lock.json"), '{"v":2}');
    const second = await ensureWorkspaceInit({
      repoId: "sample", workspacePath: dir, initCommand: cmd,
      kv, ctx: makeCtx(), log,
    });
    expect(second.ran).toBe(true);
    expect(second.reason).toBe("hash-changed");
  });

  it("throws WS_INIT_FAILED on non-zero exit and does NOT update the cache", async () => {
    const kv = new FakeKV();
    await writeFile(join(dir, "package-lock.json"), "{}");
    const cmd = platform() === "win32" ? "cmd /c exit 1" : "exit 1";
    await expect(ensureWorkspaceInit({
      repoId: "sample", workspacePath: dir, initCommand: cmd,
      kv, ctx: makeCtx(), log,
    })).rejects.toThrow(/WS_INIT_FAILED|exited 1/);
    // Cache must remain empty so the next cycle retries.
    expect(await kv.get("workspace-init", "sample")).toBeNull();
  });

  it("scrubs and splits multi-line stdout into one DEBUG entry per line (no ANSI, no \\r, no embedded \\n)", async () => {
    // Reproduces the intelligence-sync staircase observed in the wild: scripts.init emits
    // many `skill: NAME` lines in a single stdout chunk (separated by \n)
    // sometimes interleaved with ANSI clear-line / carriage returns. Each
    // line must surface as its own clean DEBUG entry so pino-pretty does
    // not interleave continuation text with structured bindings.
    const kv = new FakeKV();
    await writeFile(join(dir, "package-lock.json"), "{}");
    const captured: string[] = [];
    const captureLog = {
      debug: (msg: string) => { captured.push(msg); },
      info: () => {}, warn: () => {}, error: () => {},
      child: () => captureLog,
    };
    // node -e emits identical text on Windows + POSIX so the test is
    // platform-neutral. The chunk contains:
    //   - 3 skill lines separated by \n inside a single write
    //   - ANSI escape "\x1B[2K" (clear-line) noise
    //   - a stray \r progress char
    //   - a trailing line WITHOUT \n to exercise the close-flush
    const script = "process.stdout.write('skill: a\\nskill: b\\n\\x1B[2Kskill: c\\r\\nfinal-line');";
    const cmd = platform() === "win32" ? `node -e "${script}"` : `node -e "${script}"`;
    await ensureWorkspaceInit({
      repoId: "sample", workspacePath: dir, initCommand: cmd,
      kv, ctx: makeCtx(), log: captureLog,
    });
    const stdoutLines = captured.filter((m) => m.startsWith("init stdout:"));
    expect(stdoutLines).toContain("init stdout: skill: a");
    expect(stdoutLines).toContain("init stdout: skill: b");
    expect(stdoutLines).toContain("init stdout: skill: c");
    expect(stdoutLines).toContain("init stdout: final-line");
    // No entry may carry an embedded newline or raw ANSI escape — those
    // are the symptoms of the staircase bug.
    for (const line of stdoutLines) {
      expect(line).not.toContain("\n");
      expect(line).not.toContain("\x1B");
      expect(line).not.toContain("\r");
    }
  });

  it("scans packages/* one level deep for monorepo lock files", async () => {
    const kv = new FakeKV();
    await mkdir(join(dir, "packages", "core"), { recursive: true });
    await writeFile(join(dir, "packages", "core", "package-lock.json"), '{"v":"a"}');
    const cmd = platform() === "win32" ? "cmd /c exit 0" : "true";
    await ensureWorkspaceInit({
      repoId: "sample", workspacePath: dir, initCommand: cmd,
      kv, ctx: makeCtx(), log,
    });
    await writeFile(join(dir, "packages", "core", "package-lock.json"), '{"v":"b"}');
    const second = await ensureWorkspaceInit({
      repoId: "sample", workspacePath: dir, initCommand: cmd,
      kv, ctx: makeCtx(), log,
    });
    expect(second.ran).toBe(true);
  });
});
