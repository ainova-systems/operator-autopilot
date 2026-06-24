import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  OperationContext, VCSPlatform, StateManager,
  ConventionsConfig, PromptSource,
} from "@operator/core";
import type { AgentsFile } from "../../config/schemas.js";
import type { PRManager } from "../../delivery/pr-manager.js";
import type { StageDef, StageInput, AgentResult } from "../types.js";
import type { SingletonPayload } from "../primitives/singleton-selector.js";
import {
  buildWeeklyMetricsBeforeAgent,
  buildWeeklyMetricsBuildRunInput,
  buildWeeklyMetricsBuildPR,
  buildWeeklyMetricsAfterAgent,
  type WeeklyMetricsHookDeps,
} from "./weekly-metrics-stage.js";
import { createWorkItemFile } from "../../work-items/work-items.js";
import { makeTestKindRegistry } from "../../test-helpers/test-kind-registry.js";

const CONVENTIONS: ConventionsConfig = {
  labels: {
    pending: "ai:pending", processing: "ai:processing",
    inReview: "ai:in-review", readyToMerge: "ai:ready-to-merge", failed: "ai:failed", manual: "ai:manual",
  },
  branches: {
    aiPrefix: "ai", init: "ai/init", tasks: "ai/tasks",
    findings: "ai/findings", research: "ai/research", improver: "ai/improver",
  },
  prPrefixes: {
    task: "[AI:Task]", finding: "[AI:Finding]", research: "[AI:Research]",
    improver: "[AI:Improver]", init: "[AI:Init]",
  },
  patterns: { taskId: "T{DATE}-{SEQ}", findingPrefix: "F" },
  commentMarker: "<!-- bot:operator -->",
};

function makeCtx(): OperationContext {
  return {
    // Unique traceId so module-level scratch does not leak across tests.
    traceId: `retro-test-${Math.random().toString(36).slice(2)}`,
    repoId: "sample",
    action: "retrospective",
    budget: { spentUsd: 0, add: () => {}, isExceeded: () => false },
    signal: AbortSignal.timeout(5_000),
  };
}

function makeVCS(overrides?: Partial<VCSPlatform>): VCSPlatform {
  return {
    id: "github",
    capabilities: { codeReviews: true, labels: true, branches: true, comments: true, workItems: true, issueHierarchy: false },
    getCodeReviews: vi.fn().mockResolvedValue([]),
    getCodeReview: vi.fn(),
    createCodeReview: vi.fn(),
    updateCodeReview: vi.fn(),
    closeCodeReview: vi.fn(),
    getComments: vi.fn().mockResolvedValue([]),
    getReviewComments: vi.fn().mockResolvedValue([]),
    postComment: vi.fn(),
    getLabels: vi.fn().mockResolvedValue([]),
    addLabel: vi.fn(),
    removeLabel: vi.fn(),
    createBranch: vi.fn(),
    deleteBranch: vi.fn(),
    listBranches: vi.fn().mockResolvedValue([]),
    ...overrides,
  };
}

function makeState(): StateManager {
  return {
    upsertWorkItem: vi.fn().mockResolvedValue(undefined),
    getWorkItem: vi.fn().mockResolvedValue(null),
    listWorkItems: vi.fn().mockResolvedValue([]),
    updateWorkItemStatus: vi.fn(),
    appendExecution: vi.fn(),
    listExecutions: vi.fn(),
    saveOutcome: vi.fn(),
    listOutcomes: vi.fn(),
    isScheduleDue: vi.fn(),
    markScheduleRun: vi.fn(),
    isKnownItem: vi.fn().mockResolvedValue(false),
    markKnownItem: vi.fn().mockResolvedValue(undefined),
    close: vi.fn(),
  };
}

function makePRManager(): PRManager {
  return {
    loadTemplate: vi.fn().mockResolvedValue("## Template body"),
    findOpenPR: vi.fn(), createDraft: vi.fn(),
    markCompleted: vi.fn(), markFailed: vi.fn(), markProcessing: vi.fn(),
    postBotComment: vi.fn(), closeAndClean: vi.fn(),
  } as unknown as PRManager;
}

function makePromptSource(): PromptSource {
  return {
    loadChain: vi.fn().mockResolvedValue("verifier criteria"),
    load: vi.fn().mockResolvedValue(""),
  } as unknown as PromptSource;
}

function makeAgentsConfig(): AgentsFile {
  return {
    version: "3.0", defaultProvider: "claude",
    providers: { claude: { command: "claude", defaultArgs: [], promptArg: "-p", outputMode: "stdout" } },
    agents: {
      improver: {
        provider: "claude", description: "",
        instructions: "agents/improver.md",
        timeout: 120, model: "sonnet",
        review: true, tools: "Read,Edit,Write", maxBudget: 3, context: [],
      },
    },
  } as unknown as AgentsFile;
}

let tmp: string;
let automationDir: string;
let findingsDir: string;
let tasksDir: string;
let retrospectivesDir: string;
let templatesDir: string;
let workspacePath: string;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "retro-stage-"));
  workspacePath = tmp;
  automationDir = join(tmp, ".operator");
  // makeTestKindRegistry uses bare `tasks` / `findings` dataDirs, so the
  // per-kind dirs live directly under workspacePath in this test. The
  // aggregator now resolves `join(workspacePath, kindDef.dataDir)` —
  // matching the registry's bare paths keeps this fixture compatible
  // with both pre- and post-2026-05-20 callsite contracts.
  findingsDir = join(workspacePath, "findings");
  tasksDir = join(workspacePath, "tasks");
  retrospectivesDir = join(automationDir, "data", "retrospectives");
  templatesDir = join(tmp, "templates");
  await mkdir(findingsDir, { recursive: true });
  await mkdir(tasksDir, { recursive: true });
  await mkdir(retrospectivesDir, { recursive: true });
  await mkdir(templatesDir, { recursive: true });
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

function makeHookDeps(overrides?: Partial<WeeklyMetricsHookDeps>): WeeklyMetricsHookDeps {
  return {
    vcs: makeVCS(),
    state: makeState(),
    // kv backs the orphan-reconciler's config-driven discovery-kind lookup.
    // Empty workflow-stages → no discovery kinds → reaper no-ops cleanly.
    kv: { list: vi.fn().mockResolvedValue([]) } as unknown as WeeklyMetricsHookDeps["kv"],
    prManager: makePRManager(),
    kindRegistry: makeTestKindRegistry(),
    conventions: CONVENTIONS,
    agentsConfig: makeAgentsConfig(),
    promptSource: makePromptSource(),
    workItemSource: {
      create: vi.fn(),
      read: vi.fn(),
      updateStatus: vi.fn(),
      updateBody: vi.fn(),
      list: vi.fn(),
    } as unknown as WeeklyMetricsHookDeps["workItemSource"],
    agentEventStream: {
      parse: vi.fn().mockReturnValue({ events: [], diagnostics: [] }),
    } as unknown as WeeklyMetricsHookDeps["agentEventStream"],
    automationDir,
    reportsDir: retrospectivesDir,
    templatesDir, workspacePath,
    agentRole: "improver",
    verifierTopic: "improvement",
    scopeVarName: "WEEK",
    prPrefix: "[AI:Improver]",
    prTemplate: "improver-pr-body.md",
    prFailedTemplate: "improver-pr-failed-body.md",
    displayName: "Weekly optimization",
    agentDisplayName: "Improver",
    ...overrides,
  };
}

function makeInput(week = "2026W16"): StageInput {
  const payload: SingletonPayload = { scopeKind: "week", scopeKey: week };
  return { scopeKey: week, data: payload, reason: `week=${week}` };
}

function makeStageDef(): StageDef {
  return {
    name: "retrospective", agent: "improver", selector: "singleton",
    merge: "gated", branchScope: "per-item",
    branchPrefix: "ai/retrospective",
    schedule: "0 9 * * 1", review: true, enabled: true,
    baseBranch: "develop",
  };
}

function makeWorkspace() {
  return { branch: "ai/retrospective/2026W16", baseBranch: "develop", existedRemote: false };
}

// ── beforeAgent: metrics aggregation ───────────────────────────────────

describe("buildWeeklyMetricsBeforeAgent", () => {
  it("aggregates task stats + pending findings + PR feedback into scratch", async () => {
    await createWorkItemFile(tasksDir, {
      id: "T20260415-000101", kind: "task", title: "Completed task",
      body: "", status: "completed", priority: 3,
      createdAt: "2026-04-15T10:00:00Z", completedAt: "2026-04-16T10:00:00Z",
    });
    await createWorkItemFile(tasksDir, {
      id: "T20260416-000101", kind: "task", title: "Pending task",
      body: "", status: "pending", priority: 2,
      createdAt: "2026-04-16T08:00:00Z",
    });
    await createWorkItemFile(findingsDir, {
      id: "F20260416-0001", kind: "finding", title: "Open finding",
      body: "", status: "pending", priority: 3, source: "scanner",
      createdAt: "2026-04-16T09:00:00Z",
    });

    const deps = makeHookDeps();
    const input = makeInput("2026W16");
    const ctx = makeCtx();
    await buildWeeklyMetricsBeforeAgent(deps)(makeStageDef(), input, makeWorkspace(), ctx);

    // Verify the scratch (through buildRunInput which reads it).
    const runInput = await buildWeeklyMetricsBuildRunInput(deps)(makeStageDef(), input, ctx);
    expect(runInput.taskContent).toContain("## Task Statistics");
    expect(runInput.taskContent).toContain("Completed: 1");
    expect(runInput.taskContent).toContain("Pending: 1");
    expect(runInput.taskContent).toContain("## Recently Completed Tasks");
    expect(runInput.taskContent).toContain("**T20260415-000101**: Completed task");
    expect(runInput.taskContent).toContain("## Pending Findings");
    expect(runInput.taskContent).toContain("**F20260416-0001**");
    expect(runInput.taskContent).toContain("## Current Task Queue");
    expect(runInput.taskContent).toContain("**T20260416-000101** (P2)");
    expect(runInput.taskContent).toContain("## Merged PR Feedback");
    expect(runInput.taskContent).toContain("## Rejected PR Feedback");
  });

  it("handles empty directories without crashing", async () => {
    const deps = makeHookDeps();
    const input = makeInput();
    const ctx = makeCtx();
    await buildWeeklyMetricsBeforeAgent(deps)(makeStageDef(), input, makeWorkspace(), ctx);

    const runInput = await buildWeeklyMetricsBuildRunInput(deps)(makeStageDef(), input, ctx);
    expect(runInput.taskContent).toContain("Completed: 0");
    expect(runInput.taskContent).toContain("(none)");
  });

  it("throws when input.data is not a SingletonPayload", async () => {
    const deps = makeHookDeps();
    const badInput: StageInput = { scopeKey: "x" };
    await expect(
      buildWeeklyMetricsBeforeAgent(deps)(makeStageDef(), badInput, makeWorkspace(), makeCtx()),
    ).rejects.toThrow(/missing SingletonPayload/);
  });
});

// ── buildRunInput ──────────────────────────────────────────────────────

describe("buildWeeklyMetricsBuildRunInput", () => {
  it("builds improver AgentRunInput with week variable and review criteria", async () => {
    const deps = makeHookDeps();
    const input = makeInput("2026W16");
    const ctx = makeCtx();
    await buildWeeklyMetricsBeforeAgent(deps)(makeStageDef(), input, makeWorkspace(), ctx);

    const runInput = await buildWeeklyMetricsBuildRunInput(deps)(makeStageDef(), input, ctx);
    expect(runInput.agentName).toBe("improver");
    expect(runInput.providerId).toBe("claude");
    expect(runInput.promptContext.vars).toMatchObject({ WEEK: "2026W16" });
    expect(runInput.reviewEnabled).toBe(true);
    expect(runInput.reviewCriteria).toBe("verifier criteria");
    expect(runInput.cwd).toBe(automationDir);
    expect(runInput.model).toBe("sonnet");
  });

  it("omits reviewCriteria when the role does not require review", async () => {
    const agentsConfig = makeAgentsConfig();
    agentsConfig.agents.improver = { ...agentsConfig.agents.improver, review: false } as typeof agentsConfig.agents.improver;
    const deps = makeHookDeps({ agentsConfig });
    const input = makeInput("2026W16");
    const ctx = makeCtx();
    await buildWeeklyMetricsBeforeAgent(deps)(makeStageDef(), input, makeWorkspace(), ctx);

    const runInput = await buildWeeklyMetricsBuildRunInput(deps)(makeStageDef(), input, ctx);
    expect(runInput.reviewEnabled).toBe(false);
    expect(runInput.reviewCriteria).toBeUndefined();
  });

  it("throws when beforeAgent did not run", async () => {
    const deps = makeHookDeps();
    const input = makeInput("2026W16");
    await expect(
      buildWeeklyMetricsBuildRunInput(deps)(makeStageDef(), input, makeCtx()),
    ).rejects.toThrow(/missing scratch/);
  });
});

// ── afterAgent ─────────────────────────────────────────────────────────

describe("buildWeeklyMetricsAfterAgent", () => {
  it("writes sanitized retrospective markdown on approved verdict", async () => {
    const deps = makeHookDeps();
    const input = makeInput("2026W16");
    const ctx = makeCtx();
    await buildWeeklyMetricsBeforeAgent(deps)(makeStageDef(), input, makeWorkspace(), ctx);

    const raw = [
      "Here is the report:",
      "",
      "---",
      'title: "Weekly retro 2026W16"',
      "---",
      "",
      "## Optimization 2026W16",
      "",
      "Nothing to change.",
    ].join("\n");
    const agentResult: AgentResult = { verdict: "approved", output: raw, attempts: 1, summary: "ok" };

    const res = await buildWeeklyMetricsAfterAgent(deps)(makeStageDef(), input, agentResult, makeWorkspace(), ctx);
    expect(res?.summaryOverride).toContain("2026W16 generated");

    const content = await readFile(join(retrospectivesDir, "2026W16.md"), "utf-8");
    expect(content).toContain("Weekly retro 2026W16");
    expect(content).not.toContain("Here is the report:");
  });

  it("falls back to cleaned output when parseAgentOutput throws", async () => {
    const deps = makeHookDeps();
    const input = makeInput("2026W16");
    const ctx = makeCtx();
    await buildWeeklyMetricsBeforeAgent(deps)(makeStageDef(), input, makeWorkspace(), ctx);

    // No frontmatter — parseAgentOutput should throw, fallback writes cleaned body.
    const raw = "## Optimization 2026W16\n\nNo frontmatter.\n";
    const agentResult: AgentResult = { verdict: "approved", output: raw, attempts: 1, summary: "ok" };

    await buildWeeklyMetricsAfterAgent(deps)(makeStageDef(), input, agentResult, makeWorkspace(), ctx);
    const content = await readFile(join(retrospectivesDir, "2026W16.md"), "utf-8");
    expect(content).toContain("Optimization 2026W16");
  });

  it("writes a failure marker on non-approved verdict", async () => {
    const deps = makeHookDeps();
    const input = makeInput("2026W16");
    const ctx = makeCtx();
    await buildWeeklyMetricsBeforeAgent(deps)(makeStageDef(), input, makeWorkspace(), ctx);

    const agentResult: AgentResult = { verdict: "failed", output: "", attempts: 1, summary: "agent timeout" };
    const res = await buildWeeklyMetricsAfterAgent(deps)(makeStageDef(), input, agentResult, makeWorkspace(), ctx);
    expect(res?.summaryOverride).toContain("agent timeout");

    const failedMarker = await readFile(join(retrospectivesDir, "2026W16.failed"), "utf-8");
    expect(failedMarker).toContain("agent timeout");
  });

  it("uses a default reason when agent summary is empty", async () => {
    const deps = makeHookDeps();
    const input = makeInput("2026W16");
    const ctx = makeCtx();
    await buildWeeklyMetricsBeforeAgent(deps)(makeStageDef(), input, makeWorkspace(), ctx);

    const agentResult: AgentResult = { verdict: "failed", output: "", attempts: 1, summary: "" };
    await buildWeeklyMetricsAfterAgent(deps)(makeStageDef(), input, agentResult, makeWorkspace(), ctx);

    const failedMarker = await readFile(join(retrospectivesDir, "2026W16.failed"), "utf-8");
    expect(failedMarker).toContain("Improver agent failed");
  });

  it("still returns a summary when failure-marker write throws", async () => {
    const deps = makeHookDeps({ reportsDir: "\0/invalid" });
    const input = makeInput("2026W16");
    const ctx = makeCtx();
    await buildWeeklyMetricsBeforeAgent(deps)(makeStageDef(), input, makeWorkspace(), ctx);

    const agentResult: AgentResult = { verdict: "failed", output: "", attempts: 1, summary: "nope" };
    const res = await buildWeeklyMetricsAfterAgent(deps)(makeStageDef(), input, agentResult, makeWorkspace(), ctx);
    expect(res?.summaryOverride).toContain("nope");
  });

  it("throws when scratch is missing (beforeAgent did not run)", async () => {
    const deps = makeHookDeps();
    const input = makeInput("2026W16");
    const agentResult: AgentResult = { verdict: "approved", output: "", attempts: 1, summary: "" };
    await expect(
      buildWeeklyMetricsAfterAgent(deps)(makeStageDef(), input, agentResult, makeWorkspace(), makeCtx()),
    ).rejects.toThrow(/missing scratch/);
  });
});

// ── buildPR ────────────────────────────────────────────────────────────

describe("buildWeeklyMetricsBuildPR", () => {
  it("returns success PR body with onSuccess=in-review on approved path", async () => {
    const deps = makeHookDeps();
    const input = makeInput("2026W16");
    const ctx = makeCtx();
    await buildWeeklyMetricsBeforeAgent(deps)(makeStageDef(), input, makeWorkspace(), ctx);
    const agentResult: AgentResult = {
      verdict: "approved",
      output: "---\ntitle: \"t\"\n---\n\nBody\n",
      attempts: 1, summary: "ok",
    };
    await buildWeeklyMetricsAfterAgent(deps)(makeStageDef(), input, agentResult, makeWorkspace(), ctx);

    const pr = await buildWeeklyMetricsBuildPR(deps)(makeStageDef(), input, ctx);
    expect(pr.title).toContain("[AI:Improver]");
    expect(pr.title).toContain("2026W16");
    expect(pr.onSuccess).toBe("in-review");
    expect(pr.commitMessage).toContain("2026W16");
  });

  it("returns failed PR body with no onSuccess on failed path", async () => {
    const deps = makeHookDeps();
    const input = makeInput("2026W16");
    const ctx = makeCtx();
    await buildWeeklyMetricsBeforeAgent(deps)(makeStageDef(), input, makeWorkspace(), ctx);
    const agentResult: AgentResult = { verdict: "failed", output: "", attempts: 1, summary: "blew up" };
    await buildWeeklyMetricsAfterAgent(deps)(makeStageDef(), input, agentResult, makeWorkspace(), ctx);

    const pr = await buildWeeklyMetricsBuildPR(deps)(makeStageDef(), input, ctx);
    expect(pr.title).toContain("failed");
    expect(pr.onSuccess).toBeUndefined();
    expect(pr.commitMessage).toContain("failed");
  });

  it("falls back to an inline PR body when loadTemplate throws", async () => {
    const prManager = makePRManager();
    (prManager.loadTemplate as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("missing"));
    const deps = makeHookDeps({ prManager });
    const input = makeInput("2026W16");
    const ctx = makeCtx();
    await buildWeeklyMetricsBeforeAgent(deps)(makeStageDef(), input, makeWorkspace(), ctx);
    const agentResult: AgentResult = {
      verdict: "approved",
      output: "---\ntitle: \"t\"\n---\n\nbody\n",
      attempts: 1, summary: "ok",
    };
    await buildWeeklyMetricsAfterAgent(deps)(makeStageDef(), input, agentResult, makeWorkspace(), ctx);

    const pr = await buildWeeklyMetricsBuildPR(deps)(makeStageDef(), input, ctx);
    expect(pr.body).toContain("2026W16");
  });

  it("falls back to an inline failure body when failed-template loadTemplate throws", async () => {
    const prManager = makePRManager();
    (prManager.loadTemplate as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("missing"));
    const deps = makeHookDeps({ prManager });
    const input = makeInput("2026W16");
    const ctx = makeCtx();
    await buildWeeklyMetricsBeforeAgent(deps)(makeStageDef(), input, makeWorkspace(), ctx);
    const agentResult: AgentResult = { verdict: "failed", output: "", attempts: 1, summary: "x" };
    await buildWeeklyMetricsAfterAgent(deps)(makeStageDef(), input, agentResult, makeWorkspace(), ctx);

    const pr = await buildWeeklyMetricsBuildPR(deps)(makeStageDef(), input, ctx);
    expect(pr.body).toContain("2026W16");
    expect(pr.body).toContain("failed");
  });

  it("throws when scratch is missing (beforeAgent did not run)", async () => {
    const deps = makeHookDeps();
    const input = makeInput("2026W16");
    await expect(
      buildWeeklyMetricsBuildPR(deps)(makeStageDef(), input, makeCtx()),
    ).rejects.toThrow(/missing scratch/);
  });
});
