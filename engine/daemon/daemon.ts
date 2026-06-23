import type { Engine } from "../engine/engine.js";
import type { OperationContext } from "@operator/core";
import { IntervalScheduler } from "./scheduler.js";
import { HealthMonitor } from "./health.js";
import type { HealthStatus } from "./health.js";
import type { StatusLine } from "../logging/status-line.js";

/** The slice of the status line the daemon drives — phase + cycle telemetry. */
type StatusSink = Pick<StatusLine, "set">;

/**
 * Daemon configuration.
 */
export interface DaemonConfig {
  /** Engine cycle interval in milliseconds (default: 5 minutes). */
  readonly cycleIntervalMs: number;
  /** Run only one cycle then exit (for CI/workflow use). */
  readonly once: boolean;
  /** Filter to a single repo. */
  readonly repoFilter?: string;
  /** Force a specific action. */
  readonly forceAction?: string;
  /** Dry run — log actions without executing. */
  readonly dryRun?: boolean;
  /** Engine version string. */
  readonly version: string;
}

/**
 * Operator daemon — standalone process that runs engine cycles on schedule.
 *
 * Modes:
 * - `--once`: Run single cycle, exit (for GitHub Actions / manual testing)
 * - Default: Run on interval with graceful shutdown (for VM/Docker/K8s)
 */
export class Daemon {
  private readonly scheduler = new IntervalScheduler();
  private readonly health: HealthMonitor;
  private abortController: AbortController | null = null;
  private running = false;
  private started = false;
  private cycleInFlight = false;
  private shutdownScheduled = false;
  private cycleCount = 0;
  private onShutdown: (() => void) | null = null;

  constructor(
    private readonly engine: Engine,
    private readonly config: DaemonConfig,
    private readonly createCtx: () => OperationContext,
    private readonly log?: { info: (msg: string) => void },
    private readonly statusLine?: StatusSink,
  ) {
    this.health = new HealthMonitor(config.version, () => this.scheduler.activeJobs());
  }

  /**
   * Start the daemon.
   * In `--once` mode: run one cycle and return.
   * Otherwise: schedule recurring cycles and block until shutdown.
   */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.running = true;
    this.abortController = new AbortController();

    if (this.config.once) {
      await this.runCycle();
      this.running = false;
      return;
    }

    // Schedule recurring engine cycle
    this.scheduler.schedule({
      id: "engine-cycle",
      intervalMs: this.config.cycleIntervalMs,
      callback: () => this.runCycle(),
    });

    // Run first cycle immediately
    await this.runCycle();

    // Block until shutdown signal
    await this.waitForShutdown();
  }

  /**
   * Graceful shutdown — cancel scheduler, abort running operations.
   */
  async shutdown(): Promise<void> {
    if (!this.running) return;
    this.scheduler.cancelAll();
    this.abortController?.abort();
    this.running = false;
  }

  /**
   * User-initiated soft shutdown (ESC key, operator CLI `stop` command, etc.).
   *
   * - Idle (no cycle running) → immediate graceful shutdown via {@link shutdown}.
   * - Cycle in flight → schedule shutdown for the next idle window. Logs so
   *   the operator knows the request landed. A second call while already
   *   scheduled is a no-op (re-logged so they see the state).
   *
   * Does NOT abort agent runs mid-flight — that is intentional to avoid
   * leaving PRs stuck mid-label-transition (see 2026-04-20 incidents).
   * Operators who want an immediate kill can still send SIGINT/SIGTERM.
   */
  async requestShutdown(): Promise<void> {
    if (!this.running) return;
    if (this.cycleInFlight) {
      if (this.shutdownScheduled) {
        this.log?.info("Shutdown already scheduled — will exit after the current cycle completes.");
        return;
      }
      this.shutdownScheduled = true;
      this.statusLine?.set({ phase: "stopping" });
      this.log?.info("Shutdown scheduled — will exit after the current cycle completes. Press Ctrl+C for immediate abort.");
      return;
    }
    this.log?.info("Shutdown requested while idle — exiting now.");
    await this.shutdown();
    this.onShutdown?.();
  }

  /** Registered by the composition root so the daemon can finalize the
   * host process (close SQLite, exit) after a scheduled soft shutdown
   * fires between cycles. */
  onSoftShutdown(callback: () => void): void {
    this.onShutdown = callback;
  }

  /**
   * Get current health status.
   */
  getHealth(): HealthStatus {
    return this.health.getStatus();
  }

  /**
   * Check if daemon is running.
   */
  isRunning(): boolean {
    return this.running;
  }

  private async runCycle(): Promise<void> {
    this.cycleInFlight = true;
    this.cycleCount += 1;
    this.statusLine?.set({
      phase: "running",
      cycle: this.cycleCount,
      startedAt: Date.now(),
      operation: undefined,
      repo: undefined,
      lastResult: undefined,
    });
    const ctx = this.createCtx();
    try {
      const result = await this.engine.runOnce(ctx, {
        repoFilter: this.config.repoFilter,
        forceAction: this.config.forceAction,
        dryRun: this.config.dryRun,
      });
      // A cycle is only "success" if every action on every project succeeded.
      // project-runner.safeExecute swallows agent/stage errors and returns
      // {status:"failed"}, so we must inspect the results to detect failures.
      const hasFailures = result.projects.some((p) =>
        p.actions.some((a) => a.status === "failed"),
      );
      this.health.recordCycle(!hasFailures);
      this.statusLine?.set({ lastResult: hasFailures ? "failure" : "success" });
    } catch {
      this.health.recordCycle(false);
      this.statusLine?.set({ lastResult: "failure" });
    } finally {
      this.cycleInFlight = false;
      // Between cycles the footer shows an idle countdown to the next run.
      if (this.running && !this.config.once && !this.shutdownScheduled) {
        this.statusLine?.set({
          phase: "idle",
          nextCycleAt: Date.now() + this.config.cycleIntervalMs,
        });
      }
      // Honor a scheduled soft shutdown now that the cycle is idle.
      if (this.shutdownScheduled && this.running) {
        this.log?.info("Cycle finished — executing scheduled shutdown.");
        await this.shutdown();
        this.onShutdown?.();
      }
    }
  }

  private waitForShutdown(): Promise<void> {
    return new Promise((resolve) => {
      const check = setInterval(() => {
        if (!this.running) {
          clearInterval(check);
          resolve();
        }
      }, 500);
    });
  }
}
