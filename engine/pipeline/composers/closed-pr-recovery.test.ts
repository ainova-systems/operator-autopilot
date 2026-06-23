import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  OperationContext, VCSPlatform, TrackerPlatform, StateManager,
  ConventionsConfig, PromptSource,
} from "@operator/core";
import type { AgentRuntime } from "../../agents/runtime.js";
import type { AgentsFile } from "../../config/schemas.js";
import {
  runRejectionHandler, type RejectionHandlerDeps,
} from "./closed-pr-recovery.js";
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
    traceId: "rej-test",
    repoId: "sample",
    action: "research",
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

function makeTracker(): TrackerPlatform {
  return {
    id: "github",
    capabilities: { codeReviews: false, labels: false, branches: false, comments: false, workItems: true, issueHierarchy: false },
    getWorkItems: vi.fn().mockResolvedValue([]),
    getWorkItem: vi.fn().mockResolvedValue(null),
    updateWorkItem: vi.fn().mockResolvedValue(undefined),
    postWorkItemComment: vi.fn().mockResolvedValue({ id: "1", author: "bot", body: "", createdAt: "" }),
    createWorkItem: vi.fn().mockResolvedValue({ id: "1", kind: "request", title: "", body: "", status: "pending", priority: 5, createdAt: "", updatedAt: "" }),
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

function makeAgentsConfig(): AgentsFile {
  return {
    version: "3.0", defaultProvider: "claude",
    providers: {
      claude: { command: "claude", defaultArgs: [], promptArg: "-p", outputMode: "stdout" },
    },
    agents: {
      diagnoser: {
        provider: "claude", description: "",
        instructions: "agents/diagnoser.md", timeout: 60, model: "sonnet",
        review: false, tools: "", maxBudget: 1, context: [],
      },
    },
  } as unknown as AgentsFile;
}

function makePromptSource(): PromptSource {
  return {
    loadChain: vi.fn().mockResolvedValue(""),
    load: vi.fn().mockResolvedValue(""),
  } as unknown as PromptSource;
}

function makeAgentRuntime(output = "recommendation: poor-implementation"): AgentRuntime {
  return { run: vi.fn().mockResolvedValue({ output, attempts: 1, durationMs: 100 }) } as unknown as AgentRuntime;
}

let tmp: string;
let findingsDir: string;
let tasksDir: string;
let templatesDir: string;
let automationDir: string;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "rejection-handler-"));
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

function makeDeps(overrides?: Partial<RejectionHandlerDeps>): RejectionHandlerDeps {
  return {
    vcs: makeVCS(),
    tracker: makeTracker(),
    state: makeState(),
    agentRuntime: makeAgentRuntime(),
    kindRegistry: makeTestKindRegistry(),
    conventions: CONVENTIONS,
    agentsConfig: makeAgentsConfig(),
    promptSource: makePromptSource(),
    automationDir, findingsDir, tasksDir, templatesDir,
    workspacePath: tmp,
    ...overrides,
  };
}

describe("runRejectionHandler", () => {
  it("returns zero counts when no files exist", async () => {
    const res = await runRejectionHandler(makeDeps(), makeCtx());
    expect(res).toEqual({ processed: 0, reopened: 0, rejected: 0, duplicated: 0 });
  });

  it("marks /duplicate tasks as duplicate", async () => {
    await createWorkItemFile(tasksDir, {
      id: "T20260322-000101", kind: "task", title: "T1", body: "",
      status: "pending", priority: 5, createdAt: "",
    });
    const deps = makeDeps({
      vcs: makeVCS({
        getCodeReviews: vi.fn().mockResolvedValue([
          { id: 99, branch: "ai/tasks/T20260322-000101", closed: true, merged: false },
        ]),
        getComments: vi.fn().mockResolvedValue([
          { id: "1", author: "user", body: "/duplicate", createdAt: "" },
        ]),
      }),
    });
    const res = await runRejectionHandler(deps, makeCtx());
    expect(res.duplicated).toBe(1);
    const content = await readFile(join(tasksDir, "T20260322-000101.md"), "utf-8");
    expect(content).toContain("status: duplicate");
  });

  it("marks /cancel findings as rejected", async () => {
    await createWorkItemFile(findingsDir, {
      id: "F20260322-0001", kind: "finding", title: "F1", body: "",
      status: "pending", priority: 3, createdAt: "",
    });
    const deps = makeDeps({
      vcs: makeVCS({
        getCodeReviews: vi.fn().mockResolvedValue([
          { id: 55, branch: "ai/findings/F20260322-0001", closed: true, merged: false },
        ]),
        getComments: vi.fn().mockResolvedValue([
          { id: "1", author: "user", body: "/cancel please", createdAt: "" },
        ]),
      }),
    });
    const res = await runRejectionHandler(deps, makeCtx());
    expect(res.rejected).toBe(1);
  });

  it("reopens a task when diagnoser recommends poor-implementation under MAX_REOPENS", async () => {
    await createWorkItemFile(tasksDir, {
      id: "T20260322-000101", kind: "task", title: "T1", body: "",
      status: "pending", priority: 5, createdAt: "",
    });
    const deps = makeDeps({
      vcs: makeVCS({
        getCodeReviews: vi.fn().mockResolvedValue([
          { id: 50, branch: "ai/tasks/T20260322-000101", closed: true, merged: false },
        ]),
        getComments: vi.fn().mockResolvedValue([
          { id: "1", author: "user", body: "please fix import", createdAt: "" },
        ]),
      }),
    });
    const res = await runRejectionHandler(deps, makeCtx());
    expect(res.reopened).toBe(1);
    const content = await readFile(join(tasksDir, "T20260322-000101.md"), "utf-8");
    expect(content).toContain("status: reopened");
    expect(content).toContain("previous_prs: 50");
  });

  it("rejects (creates manual issue) when max reopens reached with no comments", async () => {
    await writeFile(join(templatesDir, "rejected-issue-body.md"), "{ITEM_ID} {RECOMMENDATION}");
    await createWorkItemFile(tasksDir, {
      id: "T20260322-000101", kind: "task", title: "T1", body: "",
      status: "pending", priority: 5, createdAt: "", previousPrs: "10,20",
    });
    const tracker = makeTracker();
    const deps = makeDeps({
      tracker,
      vcs: makeVCS({
        getCodeReviews: vi.fn().mockResolvedValue([
          { id: 50, branch: "ai/tasks/T20260322-000101", closed: true, merged: false },
        ]),
      }),
    });
    const res = await runRejectionHandler(deps, makeCtx());
    expect(res.rejected).toBe(1);
    expect(tracker.createWorkItem).toHaveBeenCalledOnce();
  });

  it("auto-retries when no comments and under MAX_REOPENS", async () => {
    await createWorkItemFile(tasksDir, {
      id: "T20260322-000101", kind: "task", title: "T1", body: "",
      status: "pending", priority: 5, createdAt: "",
    });
    const deps = makeDeps({
      vcs: makeVCS({
        getCodeReviews: vi.fn().mockResolvedValue([
          { id: 50, branch: "ai/tasks/T20260322-000101", closed: true, merged: false },
        ]),
      }),
    });
    const res = await runRejectionHandler(deps, makeCtx());
    expect(res.reopened).toBe(1);
  });

  it("skips items with no rejected PR", async () => {
    await createWorkItemFile(tasksDir, {
      id: "T20260322-000101", kind: "task", title: "T1", body: "",
      status: "pending", priority: 5, createdAt: "",
    });
    const res = await runRejectionHandler(makeDeps(), makeCtx());
    expect(res.processed).toBe(0);
  });

  it("skips terminal items", async () => {
    await createWorkItemFile(tasksDir, {
      id: "T20260322-000101", kind: "task", title: "T1", body: "",
      status: "completed", priority: 5, createdAt: "",
    });
    const deps = makeDeps({
      vcs: makeVCS({
        getCodeReviews: vi.fn().mockResolvedValue([
          { id: 99, branch: "ai/tasks/T20260322-000101", closed: true, merged: false },
        ]),
      }),
    });
    const res = await runRejectionHandler(deps, makeCtx());
    expect(res.processed).toBe(0);
  });

  it("falls back to poor-implementation recommendation when diagnoser agent throws", async () => {
    await createWorkItemFile(tasksDir, {
      id: "T20260322-000101", kind: "task", title: "T1", body: "",
      status: "pending", priority: 5, createdAt: "",
    });
    const runtime = makeAgentRuntime();
    (runtime.run as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("agent timeout"));
    const deps = makeDeps({
      agentRuntime: runtime,
      vcs: makeVCS({
        getCodeReviews: vi.fn().mockResolvedValue([
          { id: 50, branch: "ai/tasks/T20260322-000101", closed: true, merged: false },
        ]),
        getComments: vi.fn().mockResolvedValue([
          { id: "1", author: "user", body: "This broke the build", createdAt: "" },
        ]),
      }),
    });
    const res = await runRejectionHandler(deps, makeCtx());
    // Fallback → poor-implementation → reopen
    expect(res.reopened).toBe(1);
  });

  it("rejects when diagnoser returns non-reopen recommendation", async () => {
    await writeFile(join(templatesDir, "rejected-issue-body.md"), "{ITEM_ID}");
    await createWorkItemFile(tasksDir, {
      id: "T20260322-000101", kind: "task", title: "T1", body: "",
      status: "pending", priority: 5, createdAt: "",
    });
    const deps = makeDeps({
      agentRuntime: makeAgentRuntime("recommendation: out-of-scope"),
      vcs: makeVCS({
        getCodeReviews: vi.fn().mockResolvedValue([
          { id: 50, branch: "ai/tasks/T20260322-000101", closed: true, merged: false },
        ]),
        getComments: vi.fn().mockResolvedValue([
          { id: "1", author: "user", body: "This is out of scope", createdAt: "" },
        ]),
      }),
    });
    const res = await runRejectionHandler(deps, makeCtx());
    expect(res.rejected).toBe(1);
  });

  it("continues when tracker.createWorkItem fails", async () => {
    await writeFile(join(templatesDir, "rejected-issue-body.md"), "{ITEM_ID}");
    await createWorkItemFile(tasksDir, {
      id: "T20260322-000101", kind: "task", title: "T1", body: "",
      status: "pending", priority: 5, createdAt: "", previousPrs: "10,20",
    });
    const tracker = makeTracker();
    (tracker.createWorkItem as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("boom"));
    const deps = makeDeps({
      tracker,
      vcs: makeVCS({
        getCodeReviews: vi.fn().mockResolvedValue([
          { id: 50, branch: "ai/tasks/T20260322-000101", closed: true, merged: false },
        ]),
      }),
    });
    const res = await runRejectionHandler(deps, makeCtx());
    expect(res.rejected).toBe(1); // Still marks rejected even on tracker failure
  });

  it("proceeds without tracker when none is supplied", async () => {
    await writeFile(join(templatesDir, "rejected-issue-body.md"), "{ITEM_ID}");
    await createWorkItemFile(tasksDir, {
      id: "T20260322-000101", kind: "task", title: "T1", body: "",
      status: "pending", priority: 5, createdAt: "", previousPrs: "10,20",
    });
    const deps = makeDeps({
      tracker: undefined,
      vcs: makeVCS({
        getCodeReviews: vi.fn().mockResolvedValue([
          { id: 50, branch: "ai/tasks/T20260322-000101", closed: true, merged: false },
        ]),
      }),
    });
    const res = await runRejectionHandler(deps, makeCtx());
    expect(res.rejected).toBe(1);
  });

  it("skips unreadable task files with a warning", async () => {
    await writeFile(join(tasksDir, "T-bad.md"), "not a valid work item");
    const warn = vi.fn();
    const log = { info: vi.fn(), debug: vi.fn(), warn, error: vi.fn(), child: vi.fn() } as unknown as RejectionHandlerDeps["log"];
    const res = await runRejectionHandler(makeDeps({ log }), makeCtx());
    expect(res.processed).toBe(0);
    expect(warn).toHaveBeenCalled();
  });

  it("ignores files that do not match the task/finding prefix", async () => {
    await writeFile(join(tasksDir, "README.md"), "# docs");
    await writeFile(join(findingsDir, "NOTES.md"), "# docs");
    const res = await runRejectionHandler(makeDeps(), makeCtx());
    expect(res.processed).toBe(0);
  });

  it("ignores non-markdown files in work-item directories", async () => {
    await writeFile(join(tasksDir, "T20260322-000101.txt"), "ignored");
    const res = await runRejectionHandler(makeDeps(), makeCtx());
    expect(res.processed).toBe(0);
  });

  it("processes reopened items (not just pending)", async () => {
    await createWorkItemFile(tasksDir, {
      id: "T20260322-000101", kind: "task", title: "T1", body: "",
      status: "reopened", priority: 5, createdAt: "",
    });
    const deps = makeDeps({
      vcs: makeVCS({
        getCodeReviews: vi.fn().mockResolvedValue([
          { id: 50, branch: "ai/tasks/T20260322-000101", closed: true, merged: false },
        ]),
      }),
    });
    const res = await runRejectionHandler(deps, makeCtx());
    expect(res.reopened).toBe(1);
  });

  it("processes pending findings as well as tasks", async () => {
    await createWorkItemFile(findingsDir, {
      id: "F20260322-0001", kind: "finding", title: "F1", body: "",
      status: "pending", priority: 3, createdAt: "",
    });
    const deps = makeDeps({
      vcs: makeVCS({
        getCodeReviews: vi.fn().mockResolvedValue([
          { id: 42, branch: "ai/findings/F20260322-0001", closed: true, merged: false },
        ]),
      }),
    });
    const res = await runRejectionHandler(deps, makeCtx());
    expect(res.reopened).toBe(1);
  });

  it("skips tasks/findings with 'in-progress' status (not pending or reopened)", async () => {
    await createWorkItemFile(tasksDir, {
      id: "T20260322-000101", kind: "task", title: "T1", body: "",
      status: "in-progress", priority: 5, createdAt: "",
    });
    const deps = makeDeps({
      vcs: makeVCS({
        getCodeReviews: vi.fn().mockResolvedValue([
          { id: 50, branch: "ai/tasks/T20260322-000101", closed: true, merged: false },
        ]),
      }),
    });
    const res = await runRejectionHandler(deps, makeCtx());
    expect(res.processed).toBe(0);
  });

  it("supports a new kind added to the registry without code changes", async () => {
    // Wire a 4th kind "plan" into the registry — same shape as finding/task,
    // different idPrefix + dataDir. The file-scan loop should pick it up
    // automatically because it now iterates registry.all by idPrefix.
    const planEntries: Parameters<typeof makeTestKindRegistry>[0] = [
      {
        name: "finding", label: "Finding", idPrefix: "F", dataDir: "findings",
        branchPrefix: "ai/findings", prPrefix: "[AI:Finding]",
        terminalStatuses: ["completed", "failed", "rejected", "duplicate"],
      },
      {
        name: "task", label: "Task", idPrefix: "T", dataDir: "tasks",
        branchPrefix: "ai/tasks", prPrefix: "[AI:Task]",
        terminalStatuses: ["completed", "failed", "rejected", "duplicate", "cancelled"],
      },
      {
        name: "plan", label: "Plan", idPrefix: "P", dataDir: "plans",
        branchPrefix: "ai/plans", prPrefix: "[AI:Plan]",
        terminalStatuses: ["completed", "rejected"],
      },
    ];
    const plansDir = join(automationDir, "data", "plans");
    await mkdir(plansDir, { recursive: true });
    await createWorkItemFile(plansDir, {
      id: "P20260322-0001", kind: "plan", title: "Plan 1", body: "",
      status: "pending", priority: 5, createdAt: "",
    });

    const deps = makeDeps({
      kindRegistry: makeTestKindRegistry(planEntries),
      vcs: makeVCS({
        getCodeReviews: vi.fn().mockResolvedValue([
          { id: 77, branch: "ai/plans/P20260322-0001", closed: true, merged: false },
        ]),
      }),
    });
    const res = await runRejectionHandler(deps, makeCtx());
    // Auto-retry path (no comments, under MAX_REOPENS) marks the plan reopened.
    expect(res.reopened).toBe(1);
    const content = await readFile(join(plansDir, "P20260322-0001.md"), "utf-8");
    expect(content).toContain("status: reopened");
    expect(content).toContain("previous_prs: 77");
  });
});
