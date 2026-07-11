import { describe, it, expect, vi } from "vitest";
import type { ProjectConfig } from "@operator/core";
import type { StateManager } from "@operator/core";
import type { VCSPlatform } from "@operator/core";
import type { StageDispatchRegistry, StageDispatchEntry, ScheduleSpec } from "@operator/core";
import { runProject, isScheduleDue } from "./project-runner.js";
import type { ProjectRunnerDeps, ActionResult, ActionName } from "./project-runner.js";
import { buildTestDispatchRegistry } from "../test-helpers/test-dispatch-registry.js";

/**
 * Local mirror of the pre-Phase-B `isFeatureEnabledForTest(project, action)`
 * helper — kept inside the test only so the production module exports
 * stay free of test-only API. Registry-driven feature gating IS the
 * one-liner: lookup entry, ask it. Tests assert that the lookup composes
 * correctly with the entries the test dispatch registry emits.
 */
function isFeatureEnabledForTest(
  project: ProjectConfig,
  action: string,
  registry: ReturnType<typeof buildTestDispatchRegistry>,
): boolean {
  const entry = registry.get(action);
  return entry?.isEnabled(project.features) ?? true;
}

function makeCtx() {
  return {
    traceId: "t", repoId: "test", action: "test",
    budget: { spentUsd: 0, add: vi.fn(), isExceeded: () => false },
    signal: AbortSignal.timeout(30_000),
  };
}

function makeState(): StateManager {
  return {
    upsertWorkItem: vi.fn(), deleteWorkItem: vi.fn(), getWorkItem: vi.fn(),
    listWorkItems: vi.fn().mockResolvedValue([]),
    updateWorkItemStatus: vi.fn(), appendExecution: vi.fn(), listExecutions: vi.fn(),
    saveOutcome: vi.fn(), listOutcomes: vi.fn(),
    isScheduleDue: vi.fn().mockResolvedValue(true),
    markScheduleRun: vi.fn().mockResolvedValue(undefined),
    getCounter: vi.fn().mockResolvedValue(0),
    setCounter: vi.fn().mockResolvedValue(undefined),
    isKnownItem: vi.fn(), markKnownItem: vi.fn(), close: vi.fn(),
  } as unknown as StateManager;
}

function makeProject(overrides?: Partial<ProjectConfig>): ProjectConfig {
  return {
    id: "sample",
    vcs: { platform: "github", repo: "owner/repo", branch: "develop", tokenEnvVar: "GH_TOKEN" },
    features: { prReview: true, taskSelect: true, taskExecute: true, dailyResearch: true, improver: true, findingSelect: true, findingExecute: true },
    ...overrides,
  };
}

function makeDefaults() {
  return {
    schedules: {
      prReviewMinutes: 5, taskSelectMinutes: 15, findingSelectMinutes: 30,
      improverDayOfWeek: 1, prLifecycleMinutes: 30,
    },
    limits: { maxReviewAttempts: 5 },
    review: { ignoredBotLogins: [] },
    lifecycle: {},
  };
}

function makeDeps(overrides?: Partial<ProjectRunnerDeps>): ProjectRunnerDeps {
  const defaults = makeDefaults();
  return {
    state: makeState(),
    vcs: { getCodeReviews: vi.fn().mockResolvedValue([]) } as VCSPlatform,
    defaults,
    conventions: {
      labels: { pending: "ai:pending", processing: "ai:processing", inReview: "ai:in-review", readyToMerge: "ai:ready-to-merge", failed: "ai:failed" },
      branches: { aiPrefix: "ai", init: "ai/init", tasks: "ai/tasks", findings: "ai/findings", research: "ai/research", improver: "ai/improver" },
      prPrefixes: { task: "[AI:Task]", finding: "[AI:Finding]", research: "[AI:Research]", improver: "[AI:Improver]", init: "[AI:Init]" },
      patterns: { taskId: "T{DATE}-{SEQ}", findingPrefix: "F" },
      commentMarker: "<!-- bot:operator -->",
    },
    workspacePath: "/tmp/test-ws",
    dispatchRegistry: buildTestDispatchRegistry(defaults),
    executeAction: vi.fn().mockResolvedValue({ action: "branch-cleanup", status: "completed" }),
    ...overrides,
  };
}

// ── isFeatureEnabled ─────────────────────────────────────────────────

describe("isFeatureEnabled", () => {
  const registry = buildTestDispatchRegistry(makeDefaults());

  it("returns true when feature enabled", () => {
    const project = makeProject({ features: { prReview: true } });
    expect(isFeatureEnabledForTest(project, "pr-review", registry)).toBe(true);
  });

  it("returns false when feature disabled", () => {
    const project = makeProject({ features: { prReview: false } });
    expect(isFeatureEnabledForTest(project, "pr-review", registry)).toBe(false);
  });

  it("returns true when no features config", () => {
    const project = makeProject({ features: undefined });
    expect(isFeatureEnabledForTest(project, "pr-review", registry)).toBe(true);
  });

  it("branch-cleanup always enabled", () => {
    const project = makeProject({ features: {} });
    expect(isFeatureEnabledForTest(project, "branch-cleanup", registry)).toBe(true);
  });

  it("maps action names to feature flags", () => {
    const project = makeProject({
      features: { taskSelect: false, dailyResearch: false, improver: false },
    });
    // Step 9: task-select flag still maps to the merged task-execute stage.
    expect(isFeatureEnabledForTest(project, "task-execute", registry)).toBe(false);
    expect(isFeatureEnabledForTest(project, "research", registry)).toBe(false);
    expect(isFeatureEnabledForTest(project, "improver", registry)).toBe(false);
  });

  it("returns true for unknown actions (registry pass-through)", () => {
    const project = makeProject({ features: {} });
    expect(isFeatureEnabledForTest(project, "no-such-stage", registry)).toBe(true);
  });
});

// ── runProject — forced action ───────────────────────────────────────

describe("runProject — forced action", () => {
  it("runs only the forced action", async () => {
    const execute = vi.fn().mockResolvedValue({ action: "research", status: "completed" });
    const deps = makeDeps({ executeAction: execute });

    const result = await runProject(makeProject(), deps, makeCtx(), "research");

    expect(result.actions).toHaveLength(1);
    expect(result.actions[0].action).toBe("research");
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("Step 9: --force task-execute runs single runStage call (no more select+execute split)", async () => {
    const callOrder: string[] = [];
    const execute = vi.fn().mockImplementation(async (action: ActionName) => {
      callOrder.push(action);
      return { action, status: "completed" };
    });
    const deps = makeDeps({ executeAction: execute });

    const result = await runProject(makeProject(), deps, makeCtx(), "task-execute");

    expect(result.actions).toHaveLength(1);
    expect(callOrder).toEqual(["task-execute"]);
  });

  it("Step 9: --force finding-plan runs single runStage call (replaces finding-select+finding-execute)", async () => {
    const execute = vi.fn().mockResolvedValue({ action: "finding-plan", status: "completed" });
    const deps = makeDeps({ executeAction: execute });

    const result = await runProject(makeProject(), deps, makeCtx(), "finding-plan");
    expect(result.actions).toHaveLength(1);
    expect(result.actions[0].action).toBe("finding-plan");
  });

  it("returns error for unknown force action", async () => {
    const deps = makeDeps();
    const result = await runProject(makeProject(), deps, makeCtx(), "invalid");
    expect(result.actions[0].status).toBe("failed");
    expect(result.actions[0].message).toMatch(/Unknown action/);
  });
});

// ── runProject — normal execution ────────────────────────────────────

describe("runProject — normal execution", () => {
  it("runs all actions in registry order", async () => {
    const actions: string[] = [];
    const execute = vi.fn().mockImplementation(async (action: ActionName) => {
      actions.push(action);
      return { action, status: "completed" };
    });
    const deps = makeDeps({ executeAction: execute });

    await runProject(makeProject(), deps, makeCtx());

    // Step 9 + Phase B Part 1: registry-driven order, no hardcoded names
    // in the runner. Demo-config-specific names (finding-plan,
    // task-execute) come from the DefaultDispatchRegistry.
    expect(actions).toContain("branch-cleanup");
    expect(actions).toContain("pr-review");
    expect(actions).toContain("finding-plan");
    expect(actions).toContain("task-execute");
    // research/improver may or may not run depending on current UTC time.
    expect(actions).not.toContain("finding-select" as ActionName);
    expect(actions).not.toContain("finding-execute" as ActionName);
    expect(actions).not.toContain("task-select" as ActionName);
  });

  it("skips disabled features", async () => {
    const actions: string[] = [];
    const execute = vi.fn().mockImplementation(async (action: ActionName) => {
      actions.push(action);
      return { action, status: "completed" };
    });
    const deps = makeDeps({ executeAction: execute });
    const project = makeProject({ features: { prReview: false, dailyResearch: false } });

    await runProject(project, deps, makeCtx());

    expect(actions).not.toContain("pr-review");
    expect(actions).not.toContain("research");
  });

  it("skips state-scheduled actions when schedule not due; init still fires (self-skips inside)", async () => {
    const state = makeState();
    vi.mocked(state.isScheduleDue).mockResolvedValue(false);
    const execute = vi.fn().mockImplementation(async (action: ActionName) =>
      ({ action, status: "skipped" } as ActionResult),
    );
    const deps = makeDeps({ state, executeAction: execute });

    await runProject(makeProject(), deps, makeCtx());

    const calls = execute.mock.calls.map((c) => c[0]);
    expect(calls).toEqual(["init"]);
  });

  it("continues after action failure", async () => {
    let callCount = 0;
    const execute = vi.fn().mockImplementation(async (action: ActionName) => {
      callCount++;
      if (action === "pr-review") throw new Error("API error");
      return { action, status: "completed" };
    });
    const deps = makeDeps({ executeAction: execute });

    const result = await runProject(makeProject(), deps, makeCtx());

    expect(callCount).toBeGreaterThan(1); // Didn't stop at pr-review
    const failed = result.actions.find((a) => a.action === "pr-review");
    expect(failed?.status).toBe("failed");
  });

  it("marks schedule run on success", async () => {
    const state = makeState();
    const execute = vi.fn().mockResolvedValue({ action: "pr-review", status: "completed" });
    const deps = makeDeps({ state, executeAction: execute });

    await runProject(makeProject(), deps, makeCtx());

    expect(state.markScheduleRun).toHaveBeenCalled();
  });

  it("does NOT mark schedule run for `always` schedule (init)", async () => {
    // init runs every cycle by design — calling markScheduleRun would
    // pollute the state-table with a key that has no schedule cap to
    // compare against. The schedule kind: "always" path short-circuits.
    const state = makeState();
    const execute = vi.fn().mockImplementation(async (action: ActionName) =>
      ({ action, status: "completed" } as ActionResult),
    );
    const deps = makeDeps({ state, executeAction: execute });

    await runProject(makeProject(), deps, makeCtx());

    const calls = vi.mocked(state.markScheduleRun).mock.calls;
    const keys = calls.map((c) => c[2]); // (ctx, repoId, key)
    expect(keys).not.toContain("init");
  });

  it("includes init at the front of normalOrder so it self-skips inside executeAction", async () => {
    const callOrder: string[] = [];
    const execute = vi.fn().mockImplementation(async (action: ActionName) => {
      callOrder.push(action);
      return { action, status: action === "init" ? "skipped" : "completed" };
    });
    const deps = makeDeps({ executeAction: execute });

    await runProject(makeProject(), deps, makeCtx());

    expect(callOrder[0]).toBe("init");
    expect(callOrder).toContain("pr-review");
    expect(callOrder).toContain("finding-plan");
  });

  it("skipScheduleCheck bypasses schedule check (dry-run mode)", async () => {
    const state = makeState();
    vi.mocked(state.isScheduleDue).mockResolvedValue(false);
    const actions: string[] = [];
    const execute = vi.fn().mockImplementation(async (action: ActionName) => {
      actions.push(action);
      return { action, status: "completed" };
    });
    const deps = makeDeps({ state, executeAction: execute });

    await runProject(makeProject(), deps, makeCtx(), undefined, { skipScheduleCheck: true });

    expect(actions).toContain("branch-cleanup");
    expect(actions).toContain("pr-review");
    expect(actions).toContain("task-execute");
  });

  it("does not skip schedule for forced action even when not due", async () => {
    const state = makeState();
    vi.mocked(state.isScheduleDue).mockResolvedValue(false);
    const execute = vi.fn().mockResolvedValue({ action: "research", status: "completed" });
    const deps = makeDeps({ state, executeAction: execute });

    const result = await runProject(makeProject(), deps, makeCtx(), "research");
    expect(execute).toHaveBeenCalledWith("research", expect.anything());
    expect(result.actions[0].status).toBe("completed");
  });
});

// ── isScheduleDue (entry-driven) ─────────────────────────────────────

describe("isScheduleDue", () => {
  it("returns true for `always` schedule (init pattern)", async () => {
    const deps = makeDeps();
    const entry: StageDispatchEntry = {
      action: "always-stage",
      order: 0,
      schedule: { kind: "always" } satisfies ScheduleSpec,
      isEnabled: () => true,
    };
    const result = await isScheduleDue(entry, "repo", deps, makeCtx());
    expect(result).toBe(true);
  });

  it("respects daily-schedule hourUtc gate", async () => {
    // Build an entry whose `hourUtc` definitely does NOT match now — runner
    // must skip on the hour check, never reach state.isScheduleDue.
    const state = makeState();
    vi.mocked(state.isScheduleDue).mockResolvedValue(true); // would say yes if asked
    const deps = makeDeps({ state });

    const now = new Date().getUTCHours();
    const wrongHour = (now + 12) % 24;
    const entry: StageDispatchEntry = {
      action: "research-test",
      order: 0,
      schedule: { kind: "daily", hourUtc: wrongHour, guardMinutes: 60, stateKey: "research-test" },
      isEnabled: () => true,
    };
    const result = await isScheduleDue(entry, "repo", deps, makeCtx());
    expect(result).toBe(false);
    expect(state.isScheduleDue).not.toHaveBeenCalled();
  });

  it("respects weekly-schedule dayOfWeek gate", async () => {
    const state = makeState();
    vi.mocked(state.isScheduleDue).mockResolvedValue(true);
    const deps = makeDeps({ state });

    const now = new Date().getUTCDay() || 7;
    const wrongDow = ((now + 3) % 7) + 1; // 1..7, definitely != now
    const entry: StageDispatchEntry = {
      action: "improver-test",
      order: 0,
      schedule: { kind: "weekly", dayOfWeek: wrongDow, guardMinutes: 60, stateKey: "improver-test" },
      isEnabled: () => true,
    };
    const result = await isScheduleDue(entry, "repo", deps, makeCtx());
    expect(result).toBe(false);
  });
});

// ── isScheduleDue — queue-fill ───────────────────────────────────────

function qfEntry(overrides?: Partial<Extract<ScheduleSpec, { kind: "queue-fill" }>>): StageDispatchEntry {
  return {
    action: "research", order: 70,
    schedule: {
      kind: "queue-fill", targetKind: "finding", countStatuses: ["pending", "reopened"],
      target: 5, inFlightBranchPrefix: "ai/research",
      baseIntervalMinutes: 120, maxBackoffMinutes: 10080,
      stateKey: "research", backoffStateKey: "research-empty",
      ...overrides,
    },
    isEnabled: () => true,
  };
}

function makeItems(n: number): unknown[] {
  return Array.from({ length: n }, (_, i) => ({ id: `F${i}`, kind: "finding", status: "pending" }));
}

function vcsWithReviews(reviews: unknown[]): VCSPlatform {
  return { getCodeReviews: vi.fn().mockResolvedValue(reviews) } as unknown as VCSPlatform;
}

describe("isScheduleDue — queue-fill", () => {
  it("is due when backlog is below target, no in-flight PR, throttle elapsed", async () => {
    const state = makeState();
    vi.mocked(state.listWorkItems).mockResolvedValue(makeItems(2) as never);
    vi.mocked(state.isScheduleDue).mockResolvedValue(true);
    vi.mocked(state.getCounter).mockResolvedValue(0);
    const deps = makeDeps({ state, vcs: vcsWithReviews([]) });

    expect(await isScheduleDue(qfEntry(), "repo", deps, makeCtx())).toBe(true);
  });

  it("is NOT due when backlog has reached target", async () => {
    const state = makeState();
    vi.mocked(state.listWorkItems).mockResolvedValue(makeItems(5) as never);
    const deps = makeDeps({ state, vcs: vcsWithReviews([]) });

    expect(await isScheduleDue(qfEntry(), "repo", deps, makeCtx())).toBe(false);
  });

  it("is NOT due (and skips the backlog query) while an in-flight research PR awaits merge", async () => {
    const state = makeState();
    const deps = makeDeps({
      state,
      vcs: vcsWithReviews([{ branch: "ai/research/20260101", closed: false }]),
    });

    expect(await isScheduleDue(qfEntry(), "repo", deps, makeCtx())).toBe(false);
    expect(state.listWorkItems).not.toHaveBeenCalled();
  });

  it("applies exponential backoff: effective interval = base * 2^emptyRuns", async () => {
    const state = makeState();
    vi.mocked(state.getCounter).mockResolvedValue(3); // 120 * 2^3 = 960
    vi.mocked(state.isScheduleDue).mockResolvedValue(false); // not elapsed
    vi.mocked(state.listWorkItems).mockResolvedValue(makeItems(0) as never);
    const deps = makeDeps({ state, vcs: vcsWithReviews([]) });

    const due = await isScheduleDue(qfEntry(), "repo", deps, makeCtx());
    expect(due).toBe(false);
    expect(state.isScheduleDue).toHaveBeenCalledWith(
      expect.anything(), "repo", "research", 960,
    );
  });

  it("caps the backoff interval at maxBackoffMinutes", async () => {
    const state = makeState();
    vi.mocked(state.getCounter).mockResolvedValue(20); // base * 2^20 >> cap
    vi.mocked(state.isScheduleDue).mockResolvedValue(true);
    vi.mocked(state.listWorkItems).mockResolvedValue(makeItems(0) as never);
    const deps = makeDeps({ state, vcs: vcsWithReviews([]) });

    await isScheduleDue(qfEntry(), "repo", deps, makeCtx());
    expect(state.isScheduleDue).toHaveBeenCalledWith(
      expect.anything(), "repo", "research", 10080,
    );
  });
});

// ── runProject — queue-fill backoff counter ──────────────────────────

describe("runProject — queue-fill backoff", () => {
  function qfRegistry(): StageDispatchRegistry {
    const reg: StageDispatchRegistry = {
      normalOrder: [qfEntry()],
      get: (a) => reg.normalOrder.find((e) => e.action === a),
      forceChain: (a) => reg.normalOrder.some((e) => e.action === a) ? [a] : undefined,
    };
    return reg;
  }

  it("resets the empty-run counter when research produced an in-flight PR", async () => {
    const state = makeState();
    vi.mocked(state.listWorkItems).mockResolvedValue(makeItems(0) as never);
    // Eval sees no in-flight PR (due); after the run a research PR exists.
    const vcs = vcsWithReviews([]);
    vi.mocked(vcs.getCodeReviews)
      .mockResolvedValueOnce([]) // eval: no in-flight → due
      .mockResolvedValueOnce([{ branch: "ai/research/x", closed: false }] as never); // post-run: produced
    const execute = vi.fn().mockResolvedValue({ action: "research", status: "completed" });
    const deps = makeDeps({ state, vcs, executeAction: execute, dispatchRegistry: qfRegistry() });

    await runProject(makeProject(), deps, makeCtx());

    expect(state.setCounter).toHaveBeenCalledWith(expect.anything(), "sample", "research-empty", 0);
  });

  it("bumps the empty-run counter when research produced nothing", async () => {
    const state = makeState();
    vi.mocked(state.listWorkItems).mockResolvedValue(makeItems(0) as never);
    vi.mocked(state.getCounter).mockResolvedValue(2);
    const vcs = vcsWithReviews([]); // no research PR before or after
    const execute = vi.fn().mockResolvedValue({ action: "research", status: "completed" });
    const deps = makeDeps({ state, vcs, executeAction: execute, dispatchRegistry: qfRegistry() });

    await runProject(makeProject(), deps, makeCtx());

    expect(state.setCounter).toHaveBeenCalledWith(expect.anything(), "sample", "research-empty", 3);
  });

  it("ignores a locked skip (concurrent run owns the work) — no throttle mark, no backoff change", async () => {
    const state = makeState();
    vi.mocked(state.listWorkItems).mockResolvedValue(makeItems(0) as never);
    const vcs = vcsWithReviews([]);
    const execute = vi.fn().mockResolvedValue({ action: "research", status: "skipped", message: "locked" });
    const deps = makeDeps({ state, vcs, executeAction: execute, dispatchRegistry: qfRegistry() });

    await runProject(makeProject(), deps, makeCtx());

    expect(state.markScheduleRun).not.toHaveBeenCalled();
    expect(state.setCounter).not.toHaveBeenCalled();
  });

  it("advances the throttle on a no-eligible skip without touching the backoff", async () => {
    const state = makeState();
    vi.mocked(state.listWorkItems).mockResolvedValue(makeItems(0) as never);
    const vcs = vcsWithReviews([]);
    const execute = vi.fn().mockResolvedValue({ action: "research", status: "skipped", message: "no-input" });
    const deps = makeDeps({ state, vcs, executeAction: execute, dispatchRegistry: qfRegistry() });

    await runProject(makeProject(), deps, makeCtx());

    expect(state.markScheduleRun).toHaveBeenCalledWith(expect.anything(), "sample", "research");
    expect(state.setCounter).not.toHaveBeenCalled();
  });

  it("a failed queue-fill run advances the throttle and backoff so it does not re-fire every cycle", async () => {
    const state = makeState();
    vi.mocked(state.listWorkItems).mockResolvedValue(makeItems(0) as never);
    vi.mocked(state.getCounter).mockResolvedValue(0);
    const vcs = vcsWithReviews([]);
    const execute = vi.fn().mockResolvedValue({ action: "research", status: "failed" });
    const deps = makeDeps({ state, vcs, executeAction: execute, dispatchRegistry: qfRegistry() });

    await runProject(makeProject(), deps, makeCtx());

    expect(state.markScheduleRun).toHaveBeenCalledWith(expect.anything(), "sample", "research");
    expect(state.setCounter).toHaveBeenCalledWith(expect.anything(), "sample", "research-empty", 1);
  });
});

// ── runProject — custom registry ─────────────────────────────────────

describe("runProject — custom registry (genericisation check)", () => {
  it("dispatches stages it has never heard of when the registry declares them", async () => {
    // Phase B Part 1 acceptance: project-runner does not care about stage
    // names. Wire a fake registry with two synthetic stages and confirm
    // both run in order.
    const calls: string[] = [];
    const execute = vi.fn().mockImplementation(async (action: ActionName) => {
      calls.push(action);
      return { action, status: "completed" };
    });
    const fakeRegistry: StageDispatchRegistry = {
      normalOrder: [
        { action: "alpha", order: 1, schedule: { kind: "always" }, isEnabled: () => true },
        { action: "beta", order: 2, schedule: { kind: "always" }, isEnabled: () => true },
      ],
      get: (a) => fakeRegistry.normalOrder.find((e) => e.action === a),
      forceChain: (a) => fakeRegistry.normalOrder.some((e) => e.action === a) ? [a] : undefined,
    };
    const deps = makeDeps({ executeAction: execute, dispatchRegistry: fakeRegistry });

    await runProject(makeProject(), deps, makeCtx());

    expect(calls).toEqual(["alpha", "beta"]);
  });
});
