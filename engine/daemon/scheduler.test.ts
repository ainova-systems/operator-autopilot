import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { IntervalScheduler } from "./scheduler.js";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("IntervalScheduler", () => {
  it("schedules a recurring job", async () => {
    const scheduler = new IntervalScheduler();
    const callback = vi.fn().mockResolvedValue(undefined);

    scheduler.schedule({ id: "test", intervalMs: 1000, callback });
    expect(scheduler.isScheduled("test")).toBe(true);
    expect(scheduler.activeJobs()).toEqual(["test"]);

    await vi.advanceTimersByTimeAsync(1000);
    expect(callback).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1000);
    expect(callback).toHaveBeenCalledTimes(2);

    scheduler.cancelAll();
  });

  it("cancels a specific job", async () => {
    const scheduler = new IntervalScheduler();
    const callback = vi.fn().mockResolvedValue(undefined);

    scheduler.schedule({ id: "test", intervalMs: 500, callback });
    scheduler.cancel("test");

    await vi.advanceTimersByTimeAsync(1000);
    expect(callback).not.toHaveBeenCalled();
    expect(scheduler.isScheduled("test")).toBe(false);
  });

  it("cancels all jobs", () => {
    const scheduler = new IntervalScheduler();
    scheduler.schedule({ id: "a", intervalMs: 1000, callback: vi.fn().mockResolvedValue(undefined) });
    scheduler.schedule({ id: "b", intervalMs: 1000, callback: vi.fn().mockResolvedValue(undefined) });

    expect(scheduler.activeJobs()).toHaveLength(2);
    scheduler.cancelAll();
    expect(scheduler.activeJobs()).toHaveLength(0);
  });

  it("throws on duplicate job ID", () => {
    const scheduler = new IntervalScheduler();
    scheduler.schedule({ id: "dup", intervalMs: 1000, callback: vi.fn().mockResolvedValue(undefined) });

    expect(() => scheduler.schedule({ id: "dup", intervalMs: 1000, callback: vi.fn().mockResolvedValue(undefined) }))
      .toThrow("already scheduled");

    scheduler.cancelAll();
  });

  it("skips tick when previous run still in progress", async () => {
    const scheduler = new IntervalScheduler();
    let resolve: () => void;
    const slowCallback = vi.fn().mockImplementation(() =>
      new Promise<void>((r) => { resolve = r; }),
    );

    scheduler.schedule({ id: "slow", intervalMs: 100, callback: slowCallback });

    // First tick starts
    await vi.advanceTimersByTimeAsync(100);
    expect(slowCallback).toHaveBeenCalledTimes(1);

    // Second tick — should skip because first is still running
    await vi.advanceTimersByTimeAsync(100);
    expect(slowCallback).toHaveBeenCalledTimes(1); // Still 1

    // Complete first run
    resolve!();
    await vi.advanceTimersByTimeAsync(0); // flush microtasks

    // Third tick — should run now
    await vi.advanceTimersByTimeAsync(100);
    expect(slowCallback).toHaveBeenCalledTimes(2);

    scheduler.cancelAll();
  });

  it("catches callback errors without crashing", async () => {
    const scheduler = new IntervalScheduler();
    const callback = vi.fn().mockRejectedValue(new Error("boom"));

    scheduler.schedule({ id: "failing", intervalMs: 100, callback });

    await vi.advanceTimersByTimeAsync(100);
    expect(callback).toHaveBeenCalledTimes(1);

    // Should still fire next time
    await vi.advanceTimersByTimeAsync(100);
    expect(callback).toHaveBeenCalledTimes(2);

    scheduler.cancelAll();
  });

  it("returns handle with stop method", async () => {
    const scheduler = new IntervalScheduler();
    const callback = vi.fn().mockResolvedValue(undefined);

    const handle = scheduler.schedule({ id: "h", intervalMs: 100, callback });
    expect(handle.id).toBe("h");

    handle.stop();
    await vi.advanceTimersByTimeAsync(200);
    expect(callback).not.toHaveBeenCalled();
  });

  it("cancel is no-op for non-existent job", () => {
    const scheduler = new IntervalScheduler();
    expect(() => scheduler.cancel("nonexistent")).not.toThrow();
  });
});
