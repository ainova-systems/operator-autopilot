import { describe, it, expect, vi } from "vitest";
import type { Engine } from "../engine/engine.js";
import type { OperationContext } from "@operator/core";
import { Daemon } from "./daemon.js";
import type { DaemonConfig } from "./daemon.js";
import type { StatusState } from "../logging/status-line.js";

function makeCtx(): OperationContext {
  return {
    traceId: "t", repoId: "daemon", action: "cycle",
    budget: { spentUsd: 0, add: vi.fn(), isExceeded: () => false },
    signal: AbortSignal.timeout(30_000),
  };
}

function makeEngine(runOnce?: typeof vi.fn): Engine {
  return {
    runOnce: runOnce ?? vi.fn().mockResolvedValue({ projects: [], durationMs: 100 }),
  } as unknown as Engine;
}

function makeConfig(overrides?: Partial<DaemonConfig>): DaemonConfig {
  return {
    cycleIntervalMs: 60_000,
    once: true,
    version: "3.0.0-test",
    ...overrides,
  };
}

describe("Daemon", () => {
  it("runs single cycle in --once mode", async () => {
    const runOnce = vi.fn().mockResolvedValue({ projects: [], durationMs: 50 });
    const engine = makeEngine(runOnce);
    const daemon = new Daemon(engine, makeConfig({ once: true }), makeCtx);

    await daemon.start();

    expect(runOnce).toHaveBeenCalledTimes(1);
    expect(daemon.isRunning()).toBe(false);
  });

  it("passes repoFilter and forceAction to engine", async () => {
    const runOnce = vi.fn().mockResolvedValue({ projects: [], durationMs: 50 });
    const engine = makeEngine(runOnce);
    const daemon = new Daemon(engine, makeConfig({
      once: true,
      repoFilter: "sample",
      forceAction: "research",
    }), makeCtx);

    await daemon.start();

    expect(runOnce).toHaveBeenCalledWith(expect.anything(), {
      repoFilter: "sample",
      forceAction: "research",
    });
  });

  it("reports healthy status after successful cycle", async () => {
    const engine = makeEngine(vi.fn().mockResolvedValue({ projects: [], durationMs: 50 }));
    const daemon = new Daemon(engine, makeConfig({ once: true }), makeCtx);

    await daemon.start();

    const health = daemon.getHealth();
    expect(health.status).toBe("healthy");
    expect(health.lastCycleResult).toBe("success");
    expect(health.version).toBe("3.0.0-test");
  });

  it("reports degraded after engine failure", async () => {
    const engine = makeEngine(vi.fn().mockRejectedValue(new Error("crash")));
    const daemon = new Daemon(engine, makeConfig({ once: true }), makeCtx);

    await daemon.start();

    const health = daemon.getHealth();
    expect(health.status).toBe("degraded");
    expect(health.lastCycleResult).toBe("failure");
  });

  it("reports failure when a project action has failed status", async () => {
    // Engine completes without throwing but returns a failed action.
    // Daemon must still treat the cycle as a failure so GitHub Actions can
    // surface the problem via a non-zero exit code.
    const engine = makeEngine(vi.fn().mockResolvedValue({
      projects: [{
        projectId: "sample",
        actions: [
          { action: "pr-review", status: "completed" },
          { action: "finding-execute", status: "failed" },
        ],
      }],
      durationMs: 50,
    }));
    const daemon = new Daemon(engine, makeConfig({ once: true }), makeCtx);

    await daemon.start();

    const health = daemon.getHealth();
    expect(health.lastCycleResult).toBe("failure");
    expect(health.status).toBe("degraded");
  });

  it("reports success when all actions completed or skipped", async () => {
    const engine = makeEngine(vi.fn().mockResolvedValue({
      projects: [{
        projectId: "sample",
        actions: [
          { action: "pr-review", status: "completed" },
          { action: "research", status: "skipped" },
        ],
      }],
      durationMs: 50,
    }));
    const daemon = new Daemon(engine, makeConfig({ once: true }), makeCtx);

    await daemon.start();

    expect(daemon.getHealth().lastCycleResult).toBe("success");
  });

  it("shutdown stops daemon", async () => {
    const engine = makeEngine();
    const daemon = new Daemon(engine, makeConfig({ once: true }), makeCtx);

    await daemon.start();
    await daemon.shutdown();

    expect(daemon.isRunning()).toBe(false);
  });

  it("double start is no-op", async () => {
    const runOnce = vi.fn().mockResolvedValue({ projects: [], durationMs: 50 });
    const engine = makeEngine(runOnce);
    const daemon = new Daemon(engine, makeConfig({ once: true }), makeCtx);

    await daemon.start();
    await daemon.start(); // Should not run again

    expect(runOnce).toHaveBeenCalledTimes(1);
  });

  it("double shutdown is safe", async () => {
    const engine = makeEngine();
    const daemon = new Daemon(engine, makeConfig({ once: true }), makeCtx);

    await daemon.start();
    await daemon.shutdown();
    await daemon.shutdown(); // No-op

    expect(daemon.isRunning()).toBe(false);
  });

  it("shutdown before start is no-op", async () => {
    const engine = makeEngine();
    const daemon = new Daemon(engine, makeConfig({ once: true }), makeCtx);

    await daemon.shutdown(); // running is false — early return
    expect(daemon.isRunning()).toBe(false);
  });

  it("schedules recurring cycles in non-once mode", async () => {
    const runOnce = vi.fn().mockResolvedValue({ projects: [], durationMs: 50 });
    const engine = makeEngine(runOnce);
    const daemon = new Daemon(engine, makeConfig({ once: false, cycleIntervalMs: 60_000 }), makeCtx);

    // Start returns a promise that blocks on waitForShutdown, so trigger shutdown shortly after
    const startPromise = daemon.start();

    // Wait a tick for the first cycle to complete, then shutdown
    await vi.waitFor(() => expect(runOnce).toHaveBeenCalledTimes(1));
    await daemon.shutdown();
    await startPromise;

    expect(daemon.isRunning()).toBe(false);
    expect(runOnce).toHaveBeenCalledTimes(1);
  });

  it("drops interval ticks that fire while the bootstrap cycle is still running", async () => {
    // 2026-07-09: `start()` registers the interval and then awaits the
    // bootstrap cycle directly, so IntervalScheduler's own `running` flag
    // never saw it. The 5-minute tick launched a second cycle alongside a
    // bootstrap cycle that was still running an agent, both cycles shared one
    // git clone per repo, and a task's commit landed on a research branch.
    const logMessages: string[] = [];
    const log = { info: (m: string) => logMessages.push(m) };
    let finishBootstrapCycle!: () => void;
    const bootstrapBlocked = new Promise<void>((resolve) => { finishBootstrapCycle = resolve; });

    const runOnce = vi.fn()
      .mockImplementationOnce(async () => {
        await bootstrapBlocked;
        return { projects: [], durationMs: 1 };
      })
      .mockResolvedValue({ projects: [], durationMs: 1 });
    const daemon = new Daemon(makeEngine(runOnce), makeConfig({ once: false, cycleIntervalMs: 10 }), makeCtx, log);

    const startPromise = daemon.start();
    await vi.waitFor(() => expect(runOnce).toHaveBeenCalledTimes(1));

    // Let several interval ticks fire while the bootstrap cycle is in flight.
    await new Promise((resolve) => setTimeout(resolve, 80));

    expect(runOnce).toHaveBeenCalledTimes(1);
    expect(logMessages.some((m) => m.includes("still in flight"))).toBe(true);

    finishBootstrapCycle();
    await daemon.shutdown();
    await startPromise;
  });

  // ── ESC / soft shutdown (2026-04-20 UX request) ─────────────────────

  it("requestShutdown while idle exits immediately and invokes onSoftShutdown", async () => {
    const logMessages: string[] = [];
    const log = { info: (m: string) => logMessages.push(m) };
    const runOnce = vi.fn().mockResolvedValue({ projects: [], durationMs: 10 });
    const engine = makeEngine(runOnce);
    const daemon = new Daemon(engine, makeConfig({ once: false, cycleIntervalMs: 60_000 }), makeCtx, log);

    const finalize = vi.fn();
    daemon.onSoftShutdown(finalize);

    const startPromise = daemon.start();
    // Wait for first cycle to finish — now daemon is idle between cycles.
    await vi.waitFor(() => expect(runOnce).toHaveBeenCalledTimes(1));

    await daemon.requestShutdown();

    await startPromise;
    expect(daemon.isRunning()).toBe(false);
    expect(finalize).toHaveBeenCalledOnce();
    expect(logMessages.some((m) => m.includes("exiting now"))).toBe(true);
  });

  it("requestShutdown while cycle in-flight defers until cycle completes", async () => {
    const logMessages: string[] = [];
    const log = { info: (m: string) => logMessages.push(m) };
    let resolveCycle: (() => void) | null = null;
    const slowRunOnce = vi.fn().mockImplementation(() => new Promise<{ projects: []; durationMs: number }>((resolve) => {
      resolveCycle = () => resolve({ projects: [], durationMs: 10 });
    }));
    const engine = makeEngine(slowRunOnce);
    const daemon = new Daemon(engine, makeConfig({ once: false, cycleIntervalMs: 60_000 }), makeCtx, log);
    const finalize = vi.fn();
    daemon.onSoftShutdown(finalize);

    const startPromise = daemon.start();
    await vi.waitFor(() => expect(slowRunOnce).toHaveBeenCalledTimes(1));

    // While cycle is still running, request soft shutdown — should be deferred.
    await daemon.requestShutdown();
    expect(daemon.isRunning()).toBe(true);
    expect(finalize).not.toHaveBeenCalled();
    expect(logMessages.some((m) => m.includes("Shutdown scheduled"))).toBe(true);

    // Finish the cycle; scheduled shutdown fires in finally.
    resolveCycle!();
    await vi.waitFor(() => expect(daemon.isRunning()).toBe(false));
    expect(finalize).toHaveBeenCalledOnce();
    expect(logMessages.some((m) => m.includes("executing scheduled shutdown"))).toBe(true);

    await startPromise;
  });

  it("second requestShutdown while scheduled logs re-notice but stays scheduled", async () => {
    const logMessages: string[] = [];
    const log = { info: (m: string) => logMessages.push(m) };
    let resolveCycle: (() => void) | null = null;
    const slowRunOnce = vi.fn().mockImplementation(() => new Promise<{ projects: []; durationMs: number }>((resolve) => {
      resolveCycle = () => resolve({ projects: [], durationMs: 10 });
    }));
    const engine = makeEngine(slowRunOnce);
    const daemon = new Daemon(engine, makeConfig({ once: false, cycleIntervalMs: 60_000 }), makeCtx, log);
    daemon.onSoftShutdown(() => { /* noop */ });

    const startPromise = daemon.start();
    await vi.waitFor(() => expect(slowRunOnce).toHaveBeenCalledTimes(1));

    await daemon.requestShutdown();
    await daemon.requestShutdown(); // second press — no double-scheduling

    const scheduledCount = logMessages.filter((m) => m.includes("Shutdown scheduled")).length;
    const repeatedCount = logMessages.filter((m) => m.includes("already scheduled")).length;
    expect(scheduledCount).toBe(1);
    expect(repeatedCount).toBe(1);

    resolveCycle!();
    await vi.waitFor(() => expect(daemon.isRunning()).toBe(false));
    await startPromise;
  });

  // ── Status footer wiring ────────────────────────────────────────────

  it("drives the status line through running → idle with cycle telemetry", async () => {
    const patches: Partial<StatusState>[] = [];
    const statusLine = { set: (p: Partial<StatusState>) => patches.push(p) };
    const runOnce = vi.fn().mockResolvedValue({ projects: [], durationMs: 10 });
    const engine = makeEngine(runOnce);
    const daemon = new Daemon(
      engine,
      makeConfig({ once: false, cycleIntervalMs: 60_000 }),
      makeCtx,
      undefined,
      statusLine,
    );

    const startPromise = daemon.start();
    await vi.waitFor(() => expect(runOnce).toHaveBeenCalledTimes(1));
    await daemon.shutdown();
    await startPromise;

    expect(patches.some((p) => p.phase === "running" && p.cycle === 1)).toBe(true);
    expect(patches.some((p) => p.lastResult === "success")).toBe(true);
    expect(patches.some((p) => p.phase === "idle" && typeof p.nextCycleAt === "number")).toBe(true);
  });

  it("marks the footer stopping when soft shutdown is deferred mid-cycle", async () => {
    const patches: Partial<StatusState>[] = [];
    const statusLine = { set: (p: Partial<StatusState>) => patches.push(p) };
    let resolveCycle: (() => void) | null = null;
    const slowRunOnce = vi.fn().mockImplementation(() => new Promise<{ projects: []; durationMs: number }>((resolve) => {
      resolveCycle = () => resolve({ projects: [], durationMs: 10 });
    }));
    const engine = makeEngine(slowRunOnce);
    const daemon = new Daemon(
      engine,
      makeConfig({ once: false, cycleIntervalMs: 60_000 }),
      makeCtx,
      undefined,
      statusLine,
    );
    daemon.onSoftShutdown(() => { /* noop */ });

    const startPromise = daemon.start();
    await vi.waitFor(() => expect(slowRunOnce).toHaveBeenCalledTimes(1));
    await daemon.requestShutdown();
    expect(patches.some((p) => p.phase === "stopping")).toBe(true);

    resolveCycle!();
    await vi.waitFor(() => expect(daemon.isRunning()).toBe(false));
    await startPromise;
  });
});
