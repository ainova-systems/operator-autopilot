import { describe, expect, it } from "vitest";
import {
  SETUP_STEPS,
  deriveSetupProgress,
  type SetupSnapshot,
  type SetupStepId,
} from "./setup-state.js";

function snapshot(overrides: Partial<SetupSnapshot> = {}): SetupSnapshot {
  return {
    hasActiveConnection: false,
    repoCount: 0,
    instanceCount: 0,
    ...overrides,
  };
}

function statusOf(progress: ReturnType<typeof deriveSetupProgress>, id: SetupStepId) {
  return progress.steps.find((s) => s.id === id)?.status;
}

describe("deriveSetupProgress", () => {
  it("opens on the connection step for a brand-new install", () => {
    const progress = deriveSetupProgress(snapshot());
    expect(progress.currentStep).toBe("connect");
    expect(progress.complete).toBe(false);
    expect(progress.steps.map((s) => s.id)).toEqual([...SETUP_STEPS]);
  });

  it("moves to the preflight once a connection is active", () => {
    const progress = deriveSetupProgress(snapshot({ hasActiveConnection: true }));
    expect(statusOf(progress, "connect")).toBe("done");
    expect(progress.currentStep).toBe("preflight");
  });

  it("moves to the repository step once the preflight has passed", () => {
    const progress = deriveSetupProgress(
      snapshot({ hasActiveConnection: true, preflightPassed: true }),
    );
    expect(progress.currentStep).toBe("repo");
  });

  it("moves to the first-cycle step once a repository is registered", () => {
    const progress = deriveSetupProgress(
      snapshot({ hasActiveConnection: true, preflightPassed: true, repoCount: 1 }),
    );
    expect(progress.currentStep).toBe("run");
    expect(progress.complete).toBe(false);
  });

  it("is complete once the engine has run against this database", () => {
    const progress = deriveSetupProgress(
      snapshot({
        hasActiveConnection: true,
        preflightPassed: true,
        repoCount: 1,
        instanceCount: 1,
      }),
    );
    expect(progress.complete).toBe(true);
    expect(progress.currentStep).toBe("run");
    expect(progress.steps.every((s) => s.status === "done")).toBe(true);
  });

  it("treats an unrun preflight as outstanding even when later steps are done", () => {
    const progress = deriveSetupProgress(
      snapshot({ hasActiveConnection: true, repoCount: 1, instanceCount: 1 }),
    );
    expect(statusOf(progress, "preflight")).toBe("todo");
    expect(statusOf(progress, "repo")).toBe("done");
    expect(progress.currentStep).toBe("preflight");
    expect(progress.complete).toBe(false);
  });

  it("treats a failed preflight as outstanding", () => {
    const progress = deriveSetupProgress(
      snapshot({ hasActiveConnection: true, preflightPassed: false }),
    );
    expect(progress.currentStep).toBe("preflight");
  });

  it("gives every step a title and a summary for the stepper", () => {
    const progress = deriveSetupProgress(snapshot());
    for (const step of progress.steps) {
      expect(step.title.length).toBeGreaterThan(0);
      expect(step.summary.length).toBeGreaterThan(0);
    }
  });
});
