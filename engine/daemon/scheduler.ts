/**
 * Daemon scheduler — wraps node-cron or simple interval-based scheduling.
 * Manages recurring jobs with named IDs for start/stop/status.
 */

export interface ScheduledJob {
  readonly id: string;
  readonly intervalMs: number;
  readonly callback: () => Promise<void>;
}

export interface SchedulerHandle {
  readonly id: string;
  stop(): void;
}

/**
 * Simple interval-based scheduler.
 * Uses setInterval for recurring execution. No external dependencies (node-cron optional).
 */
export class IntervalScheduler {
  private readonly handles = new Map<string, { timer: ReturnType<typeof setInterval>; running: boolean }>();

  /**
   * Schedule a recurring job.
   * The callback is NOT called concurrently — if previous run is still in progress, the tick is skipped.
   */
  schedule(job: ScheduledJob): SchedulerHandle {
    if (this.handles.has(job.id)) {
      throw new Error(`Job "${job.id}" already scheduled`);
    }

    const state = { timer: null as unknown as ReturnType<typeof setInterval>, running: false };

    state.timer = setInterval(async () => {
      if (state.running) return; // Skip if previous run in progress
      state.running = true;
      try {
        await job.callback();
      } catch {
        // Job failures are silently caught — daemon should not crash from a job error
      } finally {
        state.running = false;
      }
    }, job.intervalMs);

    this.handles.set(job.id, state);

    return {
      id: job.id,
      stop: () => this.cancel(job.id),
    };
  }

  /**
   * Cancel a scheduled job.
   */
  cancel(id: string): void {
    const handle = this.handles.get(id);
    if (handle) {
      clearInterval(handle.timer);
      this.handles.delete(id);
    }
  }

  /**
   * Cancel all scheduled jobs.
   */
  cancelAll(): void {
    for (const [id] of this.handles) {
      this.cancel(id);
    }
  }

  /**
   * Get list of active job IDs.
   */
  activeJobs(): string[] {
    return [...this.handles.keys()];
  }

  /**
   * Check if a specific job is scheduled.
   */
  isScheduled(id: string): boolean {
    return this.handles.has(id);
  }
}
