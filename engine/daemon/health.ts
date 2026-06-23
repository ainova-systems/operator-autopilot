/**
 * Health check — reports daemon status.
 * Lightweight, no HTTP server (just data). Can be exposed via CLI or HTTP later.
 */

export interface HealthStatus {
  readonly status: "healthy" | "degraded" | "unhealthy";
  readonly uptime: number;
  readonly lastCycleAt?: string;
  readonly lastCycleResult?: "success" | "failure";
  readonly activeJobs: string[];
  readonly version: string;
}

export class HealthMonitor {
  private readonly startedAt = Date.now();
  private lastCycleAt?: string;
  private lastCycleResult?: "success" | "failure";

  constructor(
    private readonly version: string,
    private readonly getActiveJobs: () => string[],
  ) {}

  recordCycle(success: boolean): void {
    this.lastCycleAt = new Date().toISOString();
    this.lastCycleResult = success ? "success" : "failure";
  }

  getStatus(): HealthStatus {
    const activeJobs = this.getActiveJobs();
    const status = !this.lastCycleAt ? "healthy" // No cycle yet
      : this.lastCycleResult === "failure" ? "degraded"
      : "healthy";

    return {
      status,
      uptime: Date.now() - this.startedAt,
      lastCycleAt: this.lastCycleAt,
      lastCycleResult: this.lastCycleResult,
      activeJobs,
      version: this.version,
    };
  }
}
