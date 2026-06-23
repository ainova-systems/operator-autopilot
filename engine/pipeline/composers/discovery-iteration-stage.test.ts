import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  OperationContext, VCSPlatform, StateManager,
  ConventionsConfig, DefaultsConfig, PromptSource,
} from "@operator/core";
import type { AgentRuntime } from "../../agents/runtime.js";
import type { AgentsFile } from "../../config/schemas.js";
import type { PRManager } from "../../delivery/pr-manager.js";
import type { StageDef, StageInput, AgentResult } from "../types.js";
import type { DiscoveryPayload } from "../primitives/discovery-selector.js";
import {
  buildDiscoveryIterationBeforeAgent,
  buildDiscoveryIterationSynthesizeAgentResult,
  buildDiscoveryIterationBuildPR,
  buildDiscoveryIterationAfterAgent,
  type DiscoveryIterationHookDeps,
} from "./discovery-iteration-stage.js";
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

const DEFAULTS: DefaultsConfig = {
  schedules: { prReviewMinutes: 5, taskSelectMinutes: 10, findingSelectMinutes: 10, dailyResearchHour: 8, improverDayOfWeek: 1 },
  limits: { maxReviewAttempts: 5 },
  review: { ignoredBotLogins: [] },
};

function makeCtx(): OperationContext {
  return {
    traceId: `disc-test-${Math.random().toString(36).slice(2)}`,
    repoId: "sample",
    action: "research",
    budget: { spentUsd: 0, add: () => {}, isExceeded: () => false },
    signal: AbortSignal.timeout(5_000),
  };
}

function makeState(): StateManager {
  return {
    upsertWorkItem: vi.fn().mockResolvedValue(undefined),
    getWorkItem: vi.fn().mockResolvedValue(null),
    listWorkItems: vi.fn().mockResolvedValue([]),
    updateWorkItemStatus: vi.fn().mockResolvedValue(undefined),
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

function makeVCS(): VCSPlatform {
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
  };
}

function makePRManager(): PRManager {
  return {
    loadTemplate: vi.fn().mockResolvedValue("PR body template"),
    findOpenPR: vi.fn(), createDraft: vi.fn(),
    markCompleted: vi.fn(), markFailed: vi.fn(), markProcessing: vi.fn(),
    postBotComment: vi.fn(), closeAndClean: vi.fn(),
  } as unknown as PRManager;
}

function makePromptSource(): PromptSource {
  return {
    loadChain: vi.fn().mockResolvedValue(""), load: vi.fn().mockResolvedValue(""),
  } as unknown as PromptSource;
}

function makeAgentsConfig(): AgentsFile {
  return {
    version: "3.0", defaultProvider: "claude",
    providers: { claude: { command: "claude", defaultArgs: [], promptArg: "-p", outputMode: "stdout" } },
    agents: {
      analyst: {
        provider: "claude", description: "",
        instructions: "agents/analyst.md",
        timeout: 120, model: "opus",
        review: false, tools: "", maxBudget: 5, context: ["base"],
      },
      diagnoser: {
        provider: "claude", description: "",
        instructions: "agents/diagnoser.md",
        timeout: 60, model: "sonnet",
        review: false, tools: "", maxBudget: 1, context: [],
      },
    },
  } as unknown as AgentsFile;
}

function makeAgentRuntime(output: string): AgentRuntime {
  return { run: vi.fn().mockResolvedValue({ output, attempts: 1, durationMs: 100 }) } as unknown as AgentRuntime;
}

const FINDING_OUTPUT = [
  "---",
  'title: "Issue found"',
  "priority: 3",
  "---",
  "",
  "**Severity**: medium",
  "**Priority**: 3",
  "",
  "**Pattern**: bad stuff",
].join("\n");

let tmp: string;
let findingsDir: string;
let tasksDir: string;
let templatesDir: string;
let automationDir: string;
let workspacePath: string;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "discovery-stage-"));
  workspacePath = tmp;
  automationDir = join(tmp, ".operator");
  findingsDir = join(automationDir, "data", "findings");
  tasksDir = join(automationDir, "data", "tasks");
  templatesDir = join(tmp, "templates");
  await mkdir(findingsDir, { recursive: true });
  await mkdir(tasksDir, { recursive: true });
  await mkdir(templatesDir, { recursive: true });
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

const FINDING_EVENTS: ReadonlyArray<Record<string, unknown>> = [
  { type: "child-item", kind: "finding", title: "Issue found", body: "body", priority: 3, source: "analyzer-x" },
  { type: "verdict", value: "approved", summary: "1 finding" },
];

const NO_FINDINGS_EVENTS: ReadonlyArray<Record<string, unknown>> = [
  { type: "verdict", value: "approved", summary: "NO_NEW_FINDINGS — analyzer-x found nothing" },
];

function makeAgentEventStream(events: ReadonlyArray<Record<string, unknown>> = FINDING_EVENTS): import("@operator/core").AgentEventStream {
  return {
    parse: vi.fn().mockReturnValue({ events, diagnostics: [] }),
  } as unknown as import("@operator/core").AgentEventStream;
}

function makeWorkItemSource(): import("@operator/core").WorkItemSource {
  return {
    create: vi.fn((record) => Promise.resolve(record)),
    read: vi.fn(), updateStatus: vi.fn(), updateBody: vi.fn(), list: vi.fn(),
  } as unknown as import("@operator/core").WorkItemSource;
}

function makeHookDeps(overrides?: Partial<DiscoveryIterationHookDeps>): DiscoveryIterationHookDeps {
  return {
    vcs: makeVCS(),
    state: makeState(),
    prManager: makePRManager(),
    agentRuntime: makeAgentRuntime(FINDING_OUTPUT),
    kindRegistry: makeTestKindRegistry(),
    workItemSource: makeWorkItemSource(),
    agentEventStream: makeAgentEventStream(),
    conventions: CONVENTIONS,
    defaults: DEFAULTS,
    agentsConfig: makeAgentsConfig(),
    promptSource: makePromptSource(),
    automationDir,
    childDataDir: findingsDir,
    siblingsDataDir: tasksDir,
    templatesDir,
    workspacePath,
    agentRole: "analyst",
    verifierTopic: "research",
    childKind: "finding",
    prPrefix: "[AI:Research]",
    prTemplate: "research-pr-body.md",
    prFailedTemplate: "research-pr-failed-body.md",
    displayName: "research",
    siblingsBranchPrefix: "ai/tasks",
    ...overrides,
  };
}

function makeInput(date = "20260407", analyzers: { id: string; body: string; schedule?: string; enabled?: boolean }[] = []): StageInput {
  const payload: DiscoveryPayload = {
    date,
    analyzers: analyzers.map((a) => ({
      id: a.id, body: a.body,
      schedule: a.schedule ?? "daily",
      enabled: a.enabled ?? true,
    })),
  };
  return { scopeKey: date, data: payload, reason: `${analyzers.length}-analyzers` };
}

function makeStageDef(): StageDef {
  return {
    name: "research", agent: "analyst", selector: "discovery",
    merge: "gated", branchScope: "per-item",
    branchPrefix: "ai/research",
    schedule: "0 8 * * *", review: false, enabled: true,
    baseBranch: "develop",
  };
}

function makeWorkspace() {
  return { branch: "ai/research/20260407", baseBranch: "develop", existedRemote: false };
}

describe("buildDiscoveryIterationBeforeAgent", () => {
  it("runs one analyzer, creates child item, marks known", async () => {
    const deps = makeHookDeps();
    const input = makeInput("20260407", [{ id: "security", body: "Scan for issues" }]);
    const before = buildDiscoveryIterationBeforeAgent(deps);
    await before(makeStageDef(), input, makeWorkspace(), makeCtx());
    expect(deps.agentRuntime.run).toHaveBeenCalledOnce();
    expect(deps.state.markKnownItem).toHaveBeenCalledWith(expect.anything(), "sample", "security#20260407");
    expect(deps.state.upsertWorkItem).toHaveBeenCalled();
  });

  it("runs multiple analyzers in the order the payload specified", async () => {
    const deps = makeHookDeps();
    const input = makeInput("20260407", [
      { id: "a1", body: "body1" },
      { id: "a2", body: "body2" },
    ]);
    await buildDiscoveryIterationBeforeAgent(deps)(makeStageDef(), input, makeWorkspace(), makeCtx());
    expect(deps.agentRuntime.run).toHaveBeenCalledTimes(2);
    const calls = (deps.agentRuntime.run as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[0][0].taskContent).toBe("body1");
    expect(calls[1][0].taskContent).toBe("body2");
  });

  it("skips analyzer when state.isKnownItem returns true", async () => {
    const state = makeState();
    (state.isKnownItem as ReturnType<typeof vi.fn>).mockResolvedValueOnce(true);
    const deps = makeHookDeps({ state });
    const input = makeInput("20260407", [{ id: "skip-me", body: "x" }]);
    await buildDiscoveryIterationBeforeAgent(deps)(makeStageDef(), input, makeWorkspace(), makeCtx());
    expect(deps.agentRuntime.run).not.toHaveBeenCalled();
  });

  it("handles NO_NEW_FINDINGS sentinel — no child file, still marks known", async () => {
    const runtime = makeAgentRuntime("verdict only, no child-item");
    const deps = makeHookDeps({
      agentRuntime: runtime,
      agentEventStream: makeAgentEventStream(NO_FINDINGS_EVENTS),
    });
    const input = makeInput("20260407", [{ id: "a", body: "body" }]);
    await buildDiscoveryIterationBeforeAgent(deps)(makeStageDef(), input, makeWorkspace(), makeCtx());
    expect(deps.state.markKnownItem).toHaveBeenCalled();
    expect(deps.state.upsertWorkItem).not.toHaveBeenCalled();
    expect(deps.workItemSource.create).not.toHaveBeenCalled();
  });

  it("catches per-analyzer failure and keeps going", async () => {
    const runtime = makeAgentRuntime(FINDING_OUTPUT);
    (runtime.run as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce({ output: FINDING_OUTPUT, attempts: 1, durationMs: 100 });
    const deps = makeHookDeps({ agentRuntime: runtime });
    const input = makeInput("20260407", [
      { id: "a1", body: "body1" },
      { id: "a2", body: "body2" },
    ]);
    await buildDiscoveryIterationBeforeAgent(deps)(makeStageDef(), input, makeWorkspace(), makeCtx());
    expect(runtime.run).toHaveBeenCalledTimes(2);
    expect(deps.state.upsertWorkItem).toHaveBeenCalled();
  });

  it("writes a failure sentinel when every analyzer throws", async () => {
    const runtime = makeAgentRuntime("");
    (runtime.run as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("fail"));
    const deps = makeHookDeps({ agentRuntime: runtime });
    const input = makeInput("20260407", [
      { id: "a1", body: "body1" },
      { id: "a2", body: "body2" },
    ]);
    await buildDiscoveryIterationBeforeAgent(deps)(makeStageDef(), input, makeWorkspace(), makeCtx());

    const sentinelPath = join(automationDir, "data", ".failed-20260407");
    const { readFile, stat } = await import("node:fs/promises");
    const info = await stat(sentinelPath);
    expect(info.isFile()).toBe(true);
    expect(await readFile(sentinelPath, "utf-8")).toContain("research failed on 20260407");
  });

  it("throws when input.data is not a DiscoveryPayload", async () => {
    const deps = makeHookDeps();
    const badInput: StageInput = { scopeKey: "x" };
    await expect(buildDiscoveryIterationBeforeAgent(deps)(makeStageDef(), badInput, makeWorkspace(), makeCtx()))
      .rejects.toThrow(/missing DiscoveryPayload/);
  });
});

describe("buildDiscoveryIterationSynthesizeAgentResult", () => {
  it("synthesizes approved verdict with findings count on success", async () => {
    const deps = makeHookDeps();
    const ctx = makeCtx();
    const input = makeInput("20260407", [{ id: "a1", body: "body" }]);
    await buildDiscoveryIterationBeforeAgent(deps)(makeStageDef(), input, makeWorkspace(), ctx);
    const result = await buildDiscoveryIterationSynthesizeAgentResult(deps)(makeStageDef(), input, makeWorkspace(), ctx);
    expect(result.verdict).toBe("approved");
    expect(result.summary).toContain("finding");
  });

  it("synthesizes failed verdict when every analyzer threw", async () => {
    const runtime = makeAgentRuntime("");
    (runtime.run as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("fail"));
    const deps = makeHookDeps({ agentRuntime: runtime });
    const ctx = makeCtx();
    const input = makeInput("20260407", [{ id: "a1", body: "b" }, { id: "a2", body: "b" }]);
    await buildDiscoveryIterationBeforeAgent(deps)(makeStageDef(), input, makeWorkspace(), ctx);
    const result = await buildDiscoveryIterationSynthesizeAgentResult(deps)(makeStageDef(), input, makeWorkspace(), ctx);
    expect(result.verdict).toBe("failed");
    expect(result.summary).toContain("failed");
  });

  it("throws when beforeAgent did not run first", async () => {
    const deps = makeHookDeps();
    const input = makeInput("20260407", []);
    await expect(
      buildDiscoveryIterationSynthesizeAgentResult(deps)(makeStageDef(), input, makeWorkspace(), makeCtx()),
    ).rejects.toThrow(/missing scratch/);
  });
});

describe("buildDiscoveryIterationBuildPR", () => {
  it("returns a success PR body + onSuccess=in-review when findings were produced", async () => {
    const deps = makeHookDeps();
    const ctx = makeCtx();
    const input = makeInput("20260407", [{ id: "a1", body: "b" }]);
    await buildDiscoveryIterationBeforeAgent(deps)(makeStageDef(), input, makeWorkspace(), ctx);
    const pr = await buildDiscoveryIterationBuildPR(deps)(makeStageDef(), input, ctx);
    expect(pr.onSuccess).toBe("in-review");
    expect(pr.title).toContain("[AI:Research]");
    expect(pr.title).toContain("20260407");
    expect(pr.commitMessage).toContain("20260407");
  });

  it("returns a failed PR body + no onSuccess when every analyzer threw", async () => {
    const runtime = makeAgentRuntime("");
    (runtime.run as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("fail"));
    const deps = makeHookDeps({ agentRuntime: runtime });
    const ctx = makeCtx();
    const input = makeInput("20260407", [{ id: "a1", body: "b" }]);
    await buildDiscoveryIterationBeforeAgent(deps)(makeStageDef(), input, makeWorkspace(), ctx);
    const pr = await buildDiscoveryIterationBuildPR(deps)(makeStageDef(), input, ctx);
    expect(pr.onSuccess).toBeUndefined();
    expect(pr.title).toContain("failed");
    expect(pr.commitMessage).toContain("all analyzers failed");
  });

  it("falls back to an inline PR body when loadTemplate throws", async () => {
    const prManager = makePRManager();
    (prManager.loadTemplate as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("missing template"));
    const deps = makeHookDeps({ prManager });
    const ctx = makeCtx();
    const input = makeInput("20260407", [{ id: "a1", body: "b" }]);
    await buildDiscoveryIterationBeforeAgent(deps)(makeStageDef(), input, makeWorkspace(), ctx);
    const pr = await buildDiscoveryIterationBuildPR(deps)(makeStageDef(), input, ctx);
    expect(pr.body).toContain("20260407");
  });

  it("throws when scratch is missing (beforeAgent did not run)", async () => {
    const deps = makeHookDeps();
    const input = makeInput("20260407", []);
    await expect(buildDiscoveryIterationBuildPR(deps)(makeStageDef(), input, makeCtx()))
      .rejects.toThrow(/missing scratch/);
  });

  it("uses failureBody from scratch when present instead of re-loading", async () => {
    const runtime = makeAgentRuntime("");
    (runtime.run as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("fail"));
    const prManager = makePRManager();
    (prManager.loadTemplate as ReturnType<typeof vi.fn>).mockResolvedValue("TEMPLATE:FAIL");
    const deps = makeHookDeps({ agentRuntime: runtime, prManager });
    const ctx = makeCtx();
    const input = makeInput("20260407", [{ id: "a1", body: "b" }]);
    await buildDiscoveryIterationBeforeAgent(deps)(makeStageDef(), input, makeWorkspace(), ctx);
    const pr = await buildDiscoveryIterationBuildPR(deps)(makeStageDef(), input, ctx);
    expect(pr.body).toBe("TEMPLATE:FAIL");
  });
});

describe("buildDiscoveryIterationAfterAgent", () => {
  it("is a no-op (no verdict override, no summary override)", async () => {
    const deps = makeHookDeps();
    const input = makeInput("20260407", []);
    const agentResult: AgentResult = { verdict: "approved", output: "", attempts: 1, summary: "ok" };
    const res = await buildDiscoveryIterationAfterAgent(deps)(makeStageDef(), input, agentResult, makeWorkspace(), makeCtx());
    expect(res).toBeUndefined();
  });
});
