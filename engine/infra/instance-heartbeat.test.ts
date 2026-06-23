import { describe, it, expect } from "vitest";
import type { OperationContext, KVEntry } from "@operator/core";
import { InstanceHeartbeat, type HeartbeatKV } from "./instance-heartbeat.js";

class FakeKV implements HeartbeatKV {
  readonly rows = new Map<string, KVEntry>();
  async get(category: string, key: string): Promise<KVEntry | null> {
    return this.rows.get(`${category}/${key}`) ?? null;
  }
  async put(category: string, key: string, value: unknown): Promise<void> {
    this.rows.set(`${category}/${key}`, { key, value });
  }
}

function ctx(): OperationContext {
  return {
    traceId: "t",
    repoId: "*",
    action: "boot",
    budget: { spentUsd: 0, add: () => {}, isExceeded: () => false },
    signal: AbortSignal.timeout(30_000),
  };
}

interface ScheduledTimer {
  readonly cb: () => void;
  readonly delay: number;
  cancelled: boolean;
}

function makeTimerStubs(): {
  fire: () => void;
  setIntervalFn: typeof globalThis.setInterval;
  clearIntervalFn: typeof globalThis.clearInterval;
  active: () => boolean;
} {
  let timer: ScheduledTimer | null = null;
  const setIntervalFn = ((cb: () => void, delay: number) => {
    timer = { cb, delay, cancelled: false };
    return timer as unknown as ReturnType<typeof setInterval>;
  }) as unknown as typeof globalThis.setInterval;
  const clearIntervalFn = ((handle: unknown) => {
    if (handle && handle === timer) timer.cancelled = true;
  }) as typeof globalThis.clearInterval;
  return {
    fire: () => {
      if (timer && !timer.cancelled) timer.cb();
    },
    setIntervalFn,
    clearIntervalFn,
    active: () => timer != null && !timer.cancelled,
  };
}

describe("InstanceHeartbeat", () => {
  it("writes initial row on start with hostname/pid/version/mode", async () => {
    const kv = new FakeKV();
    const hb = new InstanceHeartbeat(kv);
    await hb.start({
      version: "5.1.0", mode: "daemon",
      hostname: "build-01", pid: 123,
      operatorDir: "/tmp/op",
    }, ctx());

    const stored = kv.rows.get(`instances/${hb.instanceId}`);
    expect(stored).toBeDefined();
    const v = stored!.value as Record<string, unknown>;
    expect(v.id).toBe(hb.instanceId);
    expect(v.hostname).toBe("build-01");
    expect(v.pid).toBe(123);
    expect(v.version).toBe("5.1.0");
    expect(v.mode).toBe("daemon");
    expect(v.operatorDir).toBe("/tmp/op");
    expect(v.startedAt).toBeTruthy();
    expect(v.lastHeartbeatAt).toBe(v.startedAt);
    expect(v.stoppedAt).toBeUndefined();
  });

  it("ticks update lastHeartbeatAt without changing startedAt", async () => {
    const kv = new FakeKV();
    let n = 0;
    const times = [
      "2026-04-29T08:00:00.000Z",
      "2026-04-29T08:00:05.000Z",
      "2026-04-29T08:00:10.000Z",
    ];
    const hb = new InstanceHeartbeat(kv, {
      now: () => new Date(times[n++]!),
      ...makeTimerStubs(),
    });
    await hb.start({ version: "v", mode: "once", hostname: "h", pid: 1 }, ctx());
    await hb.tick();
    await hb.tick();
    const v = kv.rows.get(`instances/${hb.instanceId}`)!.value as Record<string, unknown>;
    expect(v.startedAt).toBe(times[0]);
    expect(v.lastHeartbeatAt).toBe(times[2]);
  });

  it("schedules a periodic tick that updates the stored row", async () => {
    const kv = new FakeKV();
    let n = 0;
    const stubs = makeTimerStubs();
    const times = [
      "2026-04-29T08:00:00.000Z",
      "2026-04-29T08:00:05.000Z",
    ];
    const hb = new InstanceHeartbeat(kv, {
      intervalMs: 5_000,
      now: () => new Date(times[Math.min(n++, times.length - 1)]!),
      setInterval: stubs.setIntervalFn,
      clearInterval: stubs.clearIntervalFn,
    });
    await hb.start({ version: "v", mode: "daemon", hostname: "h", pid: 1 }, ctx());
    expect(stubs.active()).toBe(true);
    stubs.fire();
    // setInterval callback is sync void; let microtasks settle.
    await Promise.resolve();
    await Promise.resolve();
    const v = kv.rows.get(`instances/${hb.instanceId}`)!.value as Record<string, unknown>;
    expect(v.lastHeartbeatAt).toBe(times[1]);
  });

  it("stop writes stoppedAt + stopReason and cancels the tick", async () => {
    const kv = new FakeKV();
    const stubs = makeTimerStubs();
    const hb = new InstanceHeartbeat(kv, {
      setInterval: stubs.setIntervalFn,
      clearInterval: stubs.clearIntervalFn,
    });
    await hb.start({ version: "v", mode: "daemon", hostname: "h", pid: 1 }, ctx());
    expect(stubs.active()).toBe(true);
    await hb.stop("graceful");
    expect(stubs.active()).toBe(false);
    const v = kv.rows.get(`instances/${hb.instanceId}`)!.value as Record<string, unknown>;
    expect(v.stoppedAt).toBeTruthy();
    expect(v.stopReason).toBe("graceful");
  });

  it("recordCycle bumps cycleCount and refreshes timestamps", async () => {
    const kv = new FakeKV();
    const hb = new InstanceHeartbeat(kv, { ...makeTimerStubs() });
    await hb.start({ version: "v", mode: "daemon", hostname: "h", pid: 1 }, ctx());
    await hb.recordCycle();
    await hb.recordCycle();
    const v = kv.rows.get(`instances/${hb.instanceId}`)!.value as Record<string, unknown>;
    expect(v.cycleCount).toBe(2);
    expect(v.lastCycleAt).toBeTruthy();
  });

  it("start is idempotent — second call is a no-op", async () => {
    const kv = new FakeKV();
    const hb = new InstanceHeartbeat(kv, { ...makeTimerStubs() });
    await hb.start({ version: "v", mode: "daemon", hostname: "h", pid: 1 }, ctx());
    const before = kv.rows.get(`instances/${hb.instanceId}`)!.value as Record<string, unknown>;
    await hb.start({ version: "v2", mode: "once", hostname: "x", pid: 2 }, ctx());
    const after = kv.rows.get(`instances/${hb.instanceId}`)!.value as Record<string, unknown>;
    expect(after.version).toBe(before.version);
  });

  it("stop is idempotent and survives never-started instances", async () => {
    const kv = new FakeKV();
    const hb = new InstanceHeartbeat(kv, { ...makeTimerStubs() });
    await hb.stop("error");
    expect(kv.rows.size).toBe(0);
    await hb.start({ version: "v", mode: "daemon", hostname: "h", pid: 1 }, ctx());
    await hb.stop("graceful");
    await hb.stop("error");
    const v = kv.rows.get(`instances/${hb.instanceId}`)!.value as Record<string, unknown>;
    expect(v.stopReason).toBe("graceful");
  });

  it("tick before start is a no-op", async () => {
    const kv = new FakeKV();
    const hb = new InstanceHeartbeat(kv, { ...makeTimerStubs() });
    await hb.tick();
    expect(kv.rows.size).toBe(0);
  });

  it("recordCycle is a no-op before start and after stop", async () => {
    const kv = new FakeKV();
    const hb = new InstanceHeartbeat(kv, { ...makeTimerStubs() });
    await hb.recordCycle();
    expect(kv.rows.size).toBe(0);
    await hb.start({ version: "v", mode: "daemon", hostname: "h", pid: 1 }, ctx());
    await hb.recordCycle();
    await hb.stop("graceful");
    const sizeBefore = kv.rows.size;
    await hb.recordCycle();
    expect(kv.rows.size).toBe(sizeBefore);
  });

  it("calls unref on the scheduled timer when supported", async () => {
    const kv = new FakeKV();
    let unrefCalls = 0;
    const setIntervalFn = ((cb: () => void, _delay: number) => {
      void cb;
      return { unref: () => { unrefCalls++; } } as unknown as ReturnType<typeof setInterval>;
    }) as unknown as typeof globalThis.setInterval;
    const clearIntervalFn = ((_: unknown) => {}) as typeof globalThis.clearInterval;
    const hb = new InstanceHeartbeat(kv, { setInterval: setIntervalFn, clearInterval: clearIntervalFn });
    await hb.start({ version: "v", mode: "daemon", hostname: "h", pid: 1 }, ctx());
    expect(unrefCalls).toBe(1);
  });

  it("falls back to os.hostname() and process.pid when overrides omit them", async () => {
    const kv = new FakeKV();
    const hb = new InstanceHeartbeat(kv, { ...makeTimerStubs() });
    await hb.start({ version: "v", mode: "daemon" }, ctx());
    const v = kv.rows.get(`instances/${hb.instanceId}`)!.value as Record<string, unknown>;
    expect(typeof v.hostname).toBe("string");
    expect((v.hostname as string).length).toBeGreaterThan(0);
    expect(v.pid).toBe(process.pid);
  });
});
