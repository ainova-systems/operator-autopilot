/**
 * Interactive status footer — a single fixed line pinned to the bottom of
 * the terminal that shows what the daemon is doing right now: current repo +
 * stage, an elapsed-time / spinner for liveness, the cycle counter, the idle
 * countdown to the next cycle, and the ESC-to-exit hint.
 *
 * It coexists with the scrolling log stream by erasing itself before every
 * log line and redrawing afterwards (see {@link StatusLine.writeLog}). The
 * log stream therefore funnels through this controller, so the footer is the
 * single owner of the output device.
 *
 * STRICTLY interactive-only. The composition root builds a real status line
 * only when stdout is a TTY and the daemon runs long-lived. Every
 * non-interactive path (CI, systemd, Docker, piped stdout, `--once`, silent
 * level) gets {@link noopStatusLine}, which emits nothing — log output stays
 * byte-for-byte identical to a run without this feature.
 */

const ERASE_LINE = "\x1b[2K\r"; // clear the whole line, return to column 0
const HIDE_CURSOR = "\x1b[?25l";
const SHOW_CURSOR = "\x1b[?25h";
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const FALLBACK_COLUMNS = 80;

type StatusPhase = "starting" | "running" | "idle" | "stopping";

export interface StatusState {
  phase: StatusPhase;
  /** Current stage / action name, e.g. "task-execute". */
  operation?: string;
  /** Repo id the current operation runs against. */
  repo?: string;
  /** Monotonic cycle counter. */
  cycle?: number;
  /** Epoch ms the current operation began — drives the elapsed timer. */
  startedAt?: number;
  /** Epoch ms the next cycle is expected — drives the idle countdown. */
  nextCycleAt?: number;
  /** Result of the last completed cycle — shown as a mark while idle. */
  lastResult?: "success" | "failure";
  /** Trailing hint, e.g. "ESC — quit". */
  hint?: string;
}

export interface StatusLine {
  /** Merge a patch into the current state and redraw. */
  set(patch: Partial<StatusState>): void;
  /** Erase the footer but keep the repaint ticker armed. */
  clear(): void;
  /** Stop the ticker, erase the footer, restore the cursor. Idempotent. */
  stop(): void;
  /**
   * Hand a formatted log chunk to the terminal, erasing the footer first and
   * redrawing it after. Wired as the destination of the log stream so logs
   * never clobber the footer (and vice versa).
   */
  writeLog(chunk: string): void;
}

/** Minimal writable surface this controller needs from a TTY stream. */
export interface TtyStream {
  write(data: string): boolean;
  readonly columns?: number;
}

export interface StatusLineDeps {
  readonly out: TtyStream;
  /** Clock source — injectable for deterministic tests. */
  readonly now?: () => number;
  /**
   * Arms a repaint ticker (so the spinner / timers advance between log
   * lines) and returns a stop function. Injectable for tests; the default
   * uses an unref'd `setInterval` so it never keeps the process alive.
   */
  readonly startTicker?: (onTick: () => void) => () => void;
}

/** mm:ss for a non-negative duration in milliseconds. */
function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

/** Truncate to the terminal width, leaving one cell so the cursor never wraps. */
function truncate(text: string, columns: number): string {
  const max = Math.max(1, columns - 1);
  const chars = [...text];
  if (chars.length <= max) return text;
  return chars.slice(0, Math.max(1, max - 1)).join("") + "…";
}

/**
 * Pure renderer — builds the footer text for a given state. Exported so the
 * formatting is unit-testable without a terminal.
 */
export function formatStatus(
  state: StatusState,
  now: number,
  columns: number,
  frame: number,
): string {
  const spin = SPINNER[frame % SPINNER.length];
  const parts: string[] = [];

  if (state.phase === "starting") {
    parts.push(`${spin} starting…`);
  } else if (state.phase === "stopping") {
    parts.push(`${spin} stopping — finishing current cycle…`);
  } else if (state.phase === "running") {
    parts.push(spin);
    const where = state.operation && state.repo
      ? `${state.repo} · ${state.operation}`
      : state.operation ?? state.repo;
    if (where) parts.push(where);
    if (state.startedAt !== undefined) parts.push(formatElapsed(now - state.startedAt));
  } else {
    const mark = state.lastResult === "failure" ? "✗"
      : state.lastResult === "success" ? "✓"
      : "·";
    parts.push(`${mark} idle`);
    if (state.nextCycleAt !== undefined) {
      const remaining = state.nextCycleAt - now;
      parts.push(remaining > 0 ? `next in ${formatElapsed(remaining)}` : "next cycle due");
    }
  }

  if (state.cycle !== undefined && (state.phase === "running" || state.phase === "idle")) {
    parts.push(`cycle #${state.cycle}`);
  }
  if (state.hint) parts.push(state.hint);

  return truncate(parts.join(" · "), columns);
}

function defaultTicker(onTick: () => void): () => void {
  const handle = setInterval(onTick, 500);
  handle.unref?.();
  return () => clearInterval(handle);
}

class TerminalStatusLine implements StatusLine {
  private readonly out: TtyStream;
  private readonly now: () => number;
  private readonly stopTicker: () => void;
  private state: StatusState = { phase: "starting" };
  private frame = 0;
  private painted = false;
  private stopped = false;

  constructor(deps: StatusLineDeps) {
    this.out = deps.out;
    this.now = deps.now ?? Date.now;
    this.out.write(HIDE_CURSOR);
    const startTicker = deps.startTicker ?? defaultTicker;
    this.stopTicker = startTicker(() => this.render());
    this.render();
  }

  set(patch: Partial<StatusState>): void {
    if (this.stopped) return;
    this.state = { ...this.state, ...patch };
    this.render();
  }

  clear(): void {
    if (!this.painted) return;
    this.out.write(ERASE_LINE);
    this.painted = false;
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.stopTicker();
    this.clear();
    this.out.write(SHOW_CURSOR);
  }

  writeLog(chunk: string): void {
    if (this.stopped) {
      this.out.write(chunk);
      return;
    }
    if (this.painted) this.out.write(ERASE_LINE);
    this.out.write(chunk);
    this.painted = false;
    this.render();
  }

  private render(): void {
    if (this.stopped) return;
    const columns = this.out.columns ?? FALLBACK_COLUMNS;
    this.out.write(ERASE_LINE + formatStatus(this.state, this.now(), columns, this.frame++));
    this.painted = true;
  }
}

/** Build a live, terminal-backed status line. */
export function createStatusLine(deps: StatusLineDeps): StatusLine {
  return new TerminalStatusLine(deps);
}

/** No-op status line for every non-interactive run. Emits nothing. */
export function noopStatusLine(): StatusLine {
  return {
    set() {},
    clear() {},
    stop() {},
    writeLog() {},
  };
}
