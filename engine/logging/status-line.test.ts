import { describe, it, expect, vi } from "vitest";
import {
  createStatusLine,
  noopStatusLine,
  formatStatus,
  type StatusState,
  type TtyStream,
} from "./status-line.js";

const ERASE = "\x1b[2K\r";
const HIDE = "\x1b[?25l";
const SHOW = "\x1b[?25h";

/** Collecting fake TTY stream. */
function fakeStream(columns?: number): TtyStream & { writes: string[]; all: () => string } {
  const writes: string[] = [];
  return {
    columns,
    write(data: string): boolean {
      writes.push(data);
      return true;
    },
    writes,
    all: () => writes.join(""),
  };
}

/** Ticker stub that captures the repaint callback so tests can fire it. */
function manualTicker(): { start: (cb: () => void) => () => void; fire: () => void; stop: ReturnType<typeof vi.fn> } {
  let onTick: (() => void) | null = null;
  const stop = vi.fn();
  return {
    start(cb) {
      onTick = cb;
      return stop;
    },
    fire() {
      onTick?.();
    },
    stop,
  };
}

describe("formatStatus", () => {
  const base: StatusState = { phase: "running" };

  it("renders running repo · operation · elapsed · cycle · hint", () => {
    const out = formatStatus(
      { phase: "running", repo: "sample", operation: "task-execute", startedAt: 0, cycle: 4, hint: "ESC — quit" },
      62_000,
      200,
      0,
    );
    expect(out).toContain("sample · task-execute");
    expect(out).toContain("01:02"); // 62s elapsed
    expect(out).toContain("cycle #4");
    expect(out).toContain("ESC — quit");
  });

  it("shows operation alone when repo is absent", () => {
    const out = formatStatus({ phase: "running", operation: "branch-cleanup" }, 0, 200, 0);
    expect(out).toContain("branch-cleanup");
  });

  it("shows repo alone when operation is absent", () => {
    const out = formatStatus({ phase: "running", repo: "sample" }, 0, 200, 0);
    expect(out).toContain("sample");
  });

  it("renders idle with success mark and countdown", () => {
    const out = formatStatus({ phase: "idle", lastResult: "success", nextCycleAt: 90_000, cycle: 7 }, 0, 200, 0);
    expect(out).toContain("✓ idle");
    expect(out).toContain("next in 01:30");
    expect(out).toContain("cycle #7");
  });

  it("renders idle failure mark", () => {
    const out = formatStatus({ phase: "idle", lastResult: "failure" }, 0, 200, 0);
    expect(out).toContain("✗ idle");
  });

  it("renders neutral idle mark before the first cycle", () => {
    const out = formatStatus({ phase: "idle" }, 0, 200, 0);
    expect(out).toContain("· idle");
  });

  it("shows 'next cycle due' once the countdown elapses", () => {
    const out = formatStatus({ phase: "idle", nextCycleAt: 1_000 }, 5_000, 200, 0);
    expect(out).toContain("next cycle due");
  });

  it("renders starting and stopping phases", () => {
    expect(formatStatus({ phase: "starting" }, 0, 200, 0)).toContain("starting");
    expect(formatStatus({ phase: "stopping" }, 0, 200, 0)).toContain("stopping");
  });

  it("rotates the spinner by frame", () => {
    const a = formatStatus(base, 0, 200, 0);
    const b = formatStatus(base, 0, 200, 1);
    expect(a[0]).not.toBe(b[0]);
  });

  it("truncates to the terminal width with an ellipsis", () => {
    const out = formatStatus(
      { phase: "running", repo: "x".repeat(100), operation: "y".repeat(100) },
      0,
      20,
      0,
    );
    expect([...out].length).toBeLessThanOrEqual(19);
    expect(out.endsWith("…")).toBe(true);
  });
});

describe("createStatusLine", () => {
  it("hides the cursor and paints an initial line on construction", () => {
    const out = fakeStream(80);
    const ticker = manualTicker();
    createStatusLine({ out, now: () => 0, startTicker: ticker.start });
    expect(out.all()).toContain(HIDE);
    expect(out.all()).toContain(ERASE);
  });

  it("repaints on set with merged state", () => {
    const out = fakeStream(80);
    const ticker = manualTicker();
    const line = createStatusLine({ out, now: () => 0, startTicker: ticker.start });
    out.writes.length = 0;
    line.set({ phase: "running", repo: "sample", operation: "research" });
    expect(out.all()).toContain("sample · research");
  });

  it("erases the footer, writes the log chunk, then redraws on writeLog", () => {
    const out = fakeStream(80);
    const ticker = manualTicker();
    const line = createStatusLine({ out, now: () => 0, startTicker: ticker.start });
    line.set({ phase: "running", repo: "sample" });
    out.writes.length = 0;
    line.writeLog("INFO log line\n");
    // First write erases the existing footer, second is the log chunk.
    expect(out.writes[0]).toBe(ERASE);
    expect(out.writes[1]).toBe("INFO log line\n");
    // Footer redrawn after.
    expect(out.writes[out.writes.length - 1]).toContain("sample");
  });

  it("repaints when the ticker fires", () => {
    const out = fakeStream(80);
    const ticker = manualTicker();
    createStatusLine({ out, now: () => 0, startTicker: ticker.start });
    out.writes.length = 0;
    ticker.fire();
    expect(out.writes.some((w) => w.startsWith(ERASE))).toBe(true);
  });

  it("clear erases without stopping the ticker", () => {
    const out = fakeStream(80);
    const ticker = manualTicker();
    const line = createStatusLine({ out, now: () => 0, startTicker: ticker.start });
    out.writes.length = 0;
    line.clear();
    expect(out.writes).toEqual([ERASE]);
    expect(ticker.stop).not.toHaveBeenCalled();
    // A second clear (nothing painted) is a no-op.
    out.writes.length = 0;
    line.clear();
    expect(out.writes).toEqual([]);
  });

  it("stop halts the ticker, erases, and restores the cursor", () => {
    const out = fakeStream(80);
    const ticker = manualTicker();
    const line = createStatusLine({ out, now: () => 0, startTicker: ticker.start });
    out.writes.length = 0;
    line.stop();
    expect(ticker.stop).toHaveBeenCalledOnce();
    expect(out.all()).toContain(ERASE);
    expect(out.all()).toContain(SHOW);
  });

  it("is inert after stop", () => {
    const out = fakeStream(80);
    const ticker = manualTicker();
    const line = createStatusLine({ out, now: () => 0, startTicker: ticker.start });
    line.stop();
    out.writes.length = 0;
    line.stop(); // idempotent
    line.set({ phase: "running" }); // no-op
    expect(out.writes).toEqual([]);
    // writeLog after stop passes the chunk through with no footer ANSI.
    line.writeLog("late line\n");
    expect(out.writes).toEqual(["late line\n"]);
  });

  it("falls back to 80 columns when the stream reports none", () => {
    const out = fakeStream(undefined);
    const ticker = manualTicker();
    expect(() => createStatusLine({ out, now: () => 0, startTicker: ticker.start })).not.toThrow();
  });
});

describe("noopStatusLine", () => {
  it("emits nothing and never throws", () => {
    const line = noopStatusLine();
    expect(() => {
      line.set({ phase: "running" });
      line.clear();
      line.writeLog("x");
      line.stop();
    }).not.toThrow();
  });
});
