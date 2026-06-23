import { describe, it, expect } from "vitest";
import { HealthMonitor } from "./health.js";

describe("HealthMonitor", () => {
  it("reports healthy on fresh start", () => {
    const monitor = new HealthMonitor("3.0.0", () => []);
    const status = monitor.getStatus();

    expect(status.status).toBe("healthy");
    expect(status.version).toBe("3.0.0");
    expect(status.uptime).toBeGreaterThanOrEqual(0);
    expect(status.lastCycleAt).toBeUndefined();
  });

  it("reports healthy after successful cycle", () => {
    const monitor = new HealthMonitor("3.0.0", () => ["engine-cycle"]);
    monitor.recordCycle(true);
    const status = monitor.getStatus();

    expect(status.status).toBe("healthy");
    expect(status.lastCycleResult).toBe("success");
    expect(status.lastCycleAt).toBeDefined();
    expect(status.activeJobs).toEqual(["engine-cycle"]);
  });

  it("reports degraded after failed cycle", () => {
    const monitor = new HealthMonitor("3.0.0", () => []);
    monitor.recordCycle(false);
    const status = monitor.getStatus();

    expect(status.status).toBe("degraded");
    expect(status.lastCycleResult).toBe("failure");
  });

  it("recovers to healthy after successful cycle following failure", () => {
    const monitor = new HealthMonitor("3.0.0", () => []);
    monitor.recordCycle(false);
    expect(monitor.getStatus().status).toBe("degraded");

    monitor.recordCycle(true);
    expect(monitor.getStatus().status).toBe("healthy");
  });

  it("tracks uptime", () => {
    const monitor = new HealthMonitor("3.0.0", () => []);
    const status = monitor.getStatus();
    expect(status.uptime).toBeGreaterThanOrEqual(0);
    expect(status.uptime).toBeLessThan(1000); // Should be near-zero in test
  });
});
