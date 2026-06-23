import { describe, it, expect, vi } from "vitest";
import type { OperatorConfig, ProjectConfig } from "@operator/core";
import type { StateManager } from "@operator/core";
import type { EventBus } from "@operator/core";
import type { VCSPlatform } from "@operator/core";
import { ENGINE_STARTED, ENGINE_STOPPED, PROJECT_STARTED, PROJECT_COMPLETED } from "../events/types.js";
import { Engine, buildSummary } from "./engine.js";
import type { EngineDeps } from "./engine.js";
import type { ActionResult } from "./project-runner.js";
import { buildTestDispatchRegistry } from "../test-helpers/test-dispatch-registry.js";

function makeCtx() {
  return {
    traceId: "t", repoId: "engine", action: "poll",
    budget: { spentUsd: 0, add: vi.fn(), isExceeded: () => false },
    signal: AbortSignal.timeout(30_000),
  };
}

function makeConfig(repos?: ProjectConfig[]): OperatorConfig {
  return {
    defaults: {
      schedules: { prReviewMinutes: 5, taskSelectMinutes: 15, findingSelectMinutes: 30, dailyResearchHour: 8, improverDayOfWeek: 1 },
      limits: { maxReviewAttempts: 5 },
      review: { ignoredBotLogins: [] },
    },
    conventions: {
      labels: { pending: "ai:pending", processing: "ai:processing", inReview: "ai:in-review", readyToMerge: "ai:ready-to-merge", failed: "ai:failed" },
      branches: { aiPrefix: "ai", init: "ai/init", tasks: "ai/tasks", findings: "ai/findings", research: "ai/research", improver: "ai/improver" },
      prPrefixes: { task: "[AI:Task]", finding: "[AI:Finding]", research: "[AI:Research]", improver: "[AI:Improver]", init: "[AI:Init]" },
      patterns: { taskId: "T{DATE}-{SEQ}", findingPrefix: "F" },
      commentMarker: "<!-- bot:operator -->",
    },
    repos: repos ?? [
      { id: "sample", vcs: { platform: "github", repo: "o/r", branch: "develop", tokenEnvVar: "T" } },
      { id: "other", vcs: { platform: "github", repo: "o/r2", branch: "main", tokenEnvVar: "T2" } },
    ],
  };
}

function makeState(): StateManager {
  return {
    upsertWorkItem: vi.fn(), getWorkItem: vi.fn(), listWorkItems: vi.fn().mockResolvedValue([]),
    updateWorkItemStatus: vi.fn(), appendExecution: vi.fn(), listExecutions: vi.fn(),
    saveOutcome: vi.fn(), listOutcomes: vi.fn(),
    isScheduleDue: vi.fn().mockResolvedValue(true),
    markScheduleRun: vi.fn().mockResolvedValue(undefined),
    isKnownItem: vi.fn(), markKnownItem: vi.fn(), close: vi.fn(),
  };
}

function makeDeps(overrides?: Partial<EngineDeps>): EngineDeps {
  const config = overrides?.config ?? makeConfig();
  return {
    config,
    state: makeState(),
    bus: { emit: vi.fn().mockResolvedValue(undefined), on: vi.fn() },
    createVCS: vi.fn().mockReturnValue({} as VCSPlatform),
    resolveWorkspace: vi.fn().mockReturnValue("/tmp/ws"),
    prepareWorkspace: vi.fn().mockResolvedValue(undefined),
    syncWorkspace: vi.fn().mockResolvedValue(undefined),
    executeAction: vi.fn().mockResolvedValue({ action: "branch-cleanup", status: "completed" } as ActionResult),
    dispatchRegistry: buildTestDispatchRegistry(config.defaults),
    ...overrides,
  };
}

describe("Engine", () => {
  it("processes all repos", async () => {
    const deps = makeDeps();
    const engine = new Engine(deps);

    const result = await engine.runOnce(makeCtx());

    expect(result.projects).toHaveLength(2);
    expect(result.projects[0].projectId).toBe("sample");
    expect(result.projects[1].projectId).toBe("other");
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("filters by repo ID", async () => {
    const deps = makeDeps();
    const engine = new Engine(deps);

    const result = await engine.runOnce(makeCtx(), { repoFilter: "sample" });

    expect(result.projects).toHaveLength(1);
    expect(result.projects[0].projectId).toBe("sample");
  });

  it("skips non-matching repos when filtered", async () => {
    const deps = makeDeps();
    const engine = new Engine(deps);

    const result = await engine.runOnce(makeCtx(), { repoFilter: "nonexistent" });
    expect(result.projects).toHaveLength(0);
  });

  it("emits engine.started and engine.stopped events", async () => {
    const bus: EventBus = { emit: vi.fn().mockResolvedValue(undefined), on: vi.fn() };
    const deps = makeDeps({ bus });
    const engine = new Engine(deps);

    await engine.runOnce(makeCtx());

    expect(bus.emit).toHaveBeenCalledWith(ENGINE_STARTED, expect.anything());
    expect(bus.emit).toHaveBeenCalledWith(ENGINE_STOPPED, expect.objectContaining({
      data: expect.objectContaining({ projectCount: 2 }),
    }));
  });

  it("emits project.started and project.completed per repo", async () => {
    const bus: EventBus = { emit: vi.fn().mockResolvedValue(undefined), on: vi.fn() };
    const deps = makeDeps({ bus, config: makeConfig([
      { id: "one", vcs: { platform: "github", repo: "o/r", branch: "d", tokenEnvVar: "T" } },
    ]) });
    const engine = new Engine(deps);

    await engine.runOnce(makeCtx());

    expect(bus.emit).toHaveBeenCalledWith(PROJECT_STARTED, expect.objectContaining({ projectId: "one" }));
    expect(bus.emit).toHaveBeenCalledWith(PROJECT_COMPLETED, expect.objectContaining({ projectId: "one" }));
  });

  it("passes forceAction to project runner", async () => {
    const execute = vi.fn().mockResolvedValue({ action: "research", status: "completed" });
    const deps = makeDeps({
      executeAction: execute,
      config: makeConfig([
        { id: "sample", vcs: { platform: "github", repo: "o/r", branch: "d", tokenEnvVar: "T" } },
      ]),
    });
    const engine = new Engine(deps);

    await engine.runOnce(makeCtx(), { forceAction: "research" });

    expect(execute).toHaveBeenCalledWith("research", expect.anything(), expect.anything(), expect.anything(), expect.anything());
  });

  it("stops on abort signal", async () => {
    const controller = new AbortController();
    controller.abort();
    const deps = makeDeps();
    const engine = new Engine(deps);

    const result = await engine.runOnce({
      ...makeCtx(),
      signal: controller.signal,
    });

    expect(result.projects).toHaveLength(0);
  });

  it("passes dryRun option to skip schedule checks", async () => {
    const state = makeState();
    vi.mocked(state.isScheduleDue).mockResolvedValue(false); // Would skip in normal mode
    const execute = vi.fn().mockResolvedValue({ action: "branch-cleanup", status: "completed" });
    const deps = makeDeps({
      state,
      executeAction: execute,
      config: makeConfig([
        { id: "sample", vcs: { platform: "github", repo: "o/r", branch: "d", tokenEnvVar: "T" } },
      ]),
    });
    const engine = new Engine(deps);

    await engine.runOnce(makeCtx(), { dryRun: true });

    // Actions should run because dryRun skips schedule checks
    expect(execute).toHaveBeenCalled();
  });

  it("creates VCS per project", async () => {
    const createVCS = vi.fn().mockReturnValue({} as VCSPlatform);
    const deps = makeDeps({ createVCS });
    const engine = new Engine(deps);

    await engine.runOnce(makeCtx());

    expect(createVCS).toHaveBeenCalledTimes(2);
  });
});

describe("buildSummary", () => {
  it("formats engine results as markdown", () => {
    const summary = buildSummary({
      projects: [
        { projectId: "sample", actions: [{ action: "research", status: "completed" }] },
        { projectId: "other", actions: [{ action: "pr-review", status: "failed", message: "err" }] },
      ],
      durationMs: 5000,
    });

    expect(summary).toContain("**sample**: OK");
    expect(summary).toContain("**other**: FAILED");
    expect(summary).toContain("5.0s");
  });

  it("includes action details for non-skipped", () => {
    const summary = buildSummary({
      projects: [{ projectId: "p1", actions: [
        { action: "research", status: "completed" },
        { action: "pr-review", status: "skipped" },
      ] }],
      durationMs: 1000,
    });

    expect(summary).toContain("research:completed");
    expect(summary).not.toContain("pr-review:skipped");
  });
});

describe("Engine — cycle-level workspace prep (Step 8a hoist)", () => {
  it("calls prepareWorkspace then syncWorkspace exactly once per project per cycle, before executeAction", async () => {
    const callOrder: string[] = [];
    const prepareWorkspace = vi.fn().mockImplementation(async () => {
      callOrder.push("prepareWorkspace");
    });
    const syncWorkspace = vi.fn().mockImplementation(async () => {
      callOrder.push("syncWorkspace");
    });
    const executeAction = vi.fn().mockImplementation(async () => {
      callOrder.push("executeAction");
      return { action: "branch-cleanup", status: "completed" } as ActionResult;
    });
    const deps = makeDeps({
      prepareWorkspace,
      syncWorkspace,
      executeAction,
      config: makeConfig([
        { id: "sample", vcs: { platform: "github", repo: "o/r", branch: "d", tokenEnvVar: "T" } },
      ]),
    });
    const engine = new Engine(deps);

    await engine.runOnce(makeCtx());

    expect(prepareWorkspace).toHaveBeenCalledTimes(1);
    expect(syncWorkspace).toHaveBeenCalledTimes(1);
    // Per-cycle ordering: prepareWorkspace → syncWorkspace → executeAction (9 actions call the mock).
    expect(callOrder[0]).toBe("prepareWorkspace");
    expect(callOrder[1]).toBe("syncWorkspace");
    expect(callOrder.slice(2).every((c) => c === "executeAction")).toBe(true);
  });

  it("records a synthetic failure ProjectRunResult when prepareWorkspace throws", async () => {
    const prepareWorkspace = vi.fn().mockRejectedValue(new Error("clone failed"));
    const syncWorkspace = vi.fn();
    const executeAction = vi.fn();
    const deps = makeDeps({
      prepareWorkspace,
      syncWorkspace,
      executeAction,
      config: makeConfig([
        { id: "sample", vcs: { platform: "github", repo: "o/r", branch: "d", tokenEnvVar: "T" } },
      ]),
    });
    const engine = new Engine(deps);

    const result = await engine.runOnce(makeCtx());

    expect(result.projects).toHaveLength(1);
    expect(result.projects[0].actions[0].status).toBe("failed");
    expect(result.projects[0].actions[0].message).toContain("Workspace prep failed");
    expect(result.projects[0].actions[0].message).toContain("clone failed");
    // Neither syncWorkspace nor executeAction may fire on a project whose prep failed.
    expect(syncWorkspace).not.toHaveBeenCalled();
    expect(executeAction).not.toHaveBeenCalled();
  });

  it("treats syncWorkspace failure the same as prepareWorkspace failure", async () => {
    const syncWorkspace = vi.fn().mockRejectedValue(new Error("file read error"));
    const executeAction = vi.fn();
    const deps = makeDeps({
      syncWorkspace,
      executeAction,
      config: makeConfig([
        { id: "sample", vcs: { platform: "github", repo: "o/r", branch: "d", tokenEnvVar: "T" } },
      ]),
    });
    const engine = new Engine(deps);

    const result = await engine.runOnce(makeCtx());

    expect(result.projects[0].actions[0].status).toBe("failed");
    expect(result.projects[0].actions[0].message).toContain("Workspace prep failed");
    expect(result.projects[0].actions[0].message).toContain("file read error");
    expect(executeAction).not.toHaveBeenCalled();
  });

  it("still emits PROJECT_COMPLETED when prepareWorkspace fails", async () => {
    const bus: EventBus = { emit: vi.fn().mockResolvedValue(undefined), on: vi.fn() };
    const prepareWorkspace = vi.fn().mockRejectedValue(new Error("network down"));
    const deps = makeDeps({
      bus,
      prepareWorkspace,
      config: makeConfig([
        { id: "sample", vcs: { platform: "github", repo: "o/r", branch: "d", tokenEnvVar: "T" } },
      ]),
    });
    const engine = new Engine(deps);

    await engine.runOnce(makeCtx());

    expect(bus.emit).toHaveBeenCalledWith(PROJECT_COMPLETED, expect.objectContaining({
      projectId: "sample",
      data: expect.objectContaining({ workspaceFailed: true, failed: 1 }),
    }));
  });
});
