import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OperationContext, StateManager } from "@operator/core";
import {
  buildVerifierDrivenCreatorBeforeAgent,
  buildVerifierDrivenCreatorBuildRunInput,
  buildVerifierDrivenCreatorBuildPR,
  buildVerifierDrivenCreatorAfterAgent,
  type VerifierDrivenCreatorHookDeps,
} from "./verifier-driven-creator-stage.js";
import type { StageDef, StageInput, AgentResult } from "../types.js";
import type { AgentsFile } from "../../config/schemas.js";

function makeCtx(): OperationContext {
  return {
    traceId: "t",
    repoId: "sample",
    action: "test",
    budget: { limitUsd: undefined, spentUsd: 0, add: () => {}, isExceeded: () => false },
    signal: AbortSignal.timeout(10_000),
  };
}

function makeStageDef(): StageDef {
  return {
    name: "task-execute", agent: "creator", selector: "per-item",
    merge: "gated", branchScope: "per-item", branchPrefix: "ai/tasks",
    schedule: "*/5 * * * *", enabled: true, baseBranch: "develop",
  };
}

function makeWorkspace() {
  return { branch: "ai/tasks/T-1", baseBranch: "develop", existedRemote: false };
}

function makeStageInput(id = "T-1"): StageInput {
  return { scopeKey: id };
}

interface HookMocks {
  state: StateManager;
  prManager: {
    markProcessing: ReturnType<typeof vi.fn>;
    postBotComment: ReturnType<typeof vi.fn>;
    loadTemplate: ReturnType<typeof vi.fn>;
  };
  git: { headSha: ReturnType<typeof vi.fn> };
  vcs: { getCodeReviews: ReturnType<typeof vi.fn> };
  log: {
    info: ReturnType<typeof vi.fn>;
    debug: ReturnType<typeof vi.fn>;
    warn: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
    child: ReturnType<typeof vi.fn>;
  };
}

function makeHookDeps(
  overrides?: Partial<VerifierDrivenCreatorHookDeps>,
): { deps: VerifierDrivenCreatorHookDeps; mocks: HookMocks } {
  const state = {
    listWorkItems: vi.fn().mockResolvedValue([]),
    upsertWorkItem: vi.fn(), getWorkItem: vi.fn(), updateWorkItemStatus: vi.fn(),
    appendExecution: vi.fn(), listExecutions: vi.fn(),
    saveOutcome: vi.fn(), listOutcomes: vi.fn(),
    isScheduleDue: vi.fn(), markScheduleRun: vi.fn(),
    isKnownItem: vi.fn(), markKnownItem: vi.fn(), close: vi.fn(),
  } as unknown as StateManager;
  const prManager = {
    markProcessing: vi.fn().mockResolvedValue(undefined),
    postBotComment: vi.fn().mockResolvedValue(undefined),
    loadTemplate: vi.fn().mockResolvedValue("body"),
  };
  const git = { headSha: vi.fn().mockResolvedValue("abc123") };
  const vcs = { getCodeReviews: vi.fn().mockResolvedValue([]) };
  const log = {
    info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(),
    child: vi.fn(() => log),
  };
  const deps: VerifierDrivenCreatorHookDeps = {
    state,
    vcs: vcs as unknown as VerifierDrivenCreatorHookDeps["vcs"],
    prManager: prManager as unknown as VerifierDrivenCreatorHookDeps["prManager"],
    git: git as unknown as VerifierDrivenCreatorHookDeps["git"],
    dataDir: "/tmp/tasks",
    automationDir: "/tmp/.operator",
    workspacePath: "/tmp/ws",
    templatesDir: "/tmp/templates",
    agentsConfig: { defaultProvider: "claude", providers: { claude: { command: "claude" } }, agents: { creator: { instructions: "agents/creator.md", timeout: 600 } } } as unknown as AgentsFile,
    promptSource: { loadChain: vi.fn().mockResolvedValue("") } as unknown as VerifierDrivenCreatorHookDeps["promptSource"],
    log,
    kind: "task",
    agentRole: "creator",
    verifierTopic: "task",
    branchPrefix: "ai/tasks",
    prPrefix: "[AI:Task]",
    prTemplate: "task-pr-inprogress-body.md",
    displayName: "Task",
    ...overrides,
  };
  return { deps, mocks: { state, prManager, git, vcs, log } };
}

describe("buildVerifierDrivenCreatorAfterAgent", () => {
  let dataDir: string;
  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "op-afteragent-"));
  });
  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  async function writeTask(id: string, status: string): Promise<void> {
    const content = `---\nid: ${id}\ntype: task\ntitle: "${id}"\nstatus: ${status}\npriority: 3\ncreated_at: "2026-04-16"\n---\n\n${id} body.`;
    await writeFile(join(dataDir, `${id}.md`), content, "utf-8");
  }

  it("on approved verdict updates status to completed and posts comment", async () => {
    await writeTask("T-OK", "in-progress");
    const { deps, mocks } = makeHookDeps({ dataDir });
    const ctx = makeCtx();
    await buildVerifierDrivenCreatorBeforeAgent(deps)(makeStageDef(), makeStageInput("T-OK"), makeWorkspace(), ctx);
    const agentResult: AgentResult = { verdict: "approved", output: "", attempts: 1, summary: "ok" };
    const result = await buildVerifierDrivenCreatorAfterAgent(deps)(
      makeStageDef(), makeStageInput("T-OK"), agentResult, makeWorkspace(), ctx,
    );
    expect(result).toBeUndefined();
    expect(mocks.prManager.postBotComment).not.toHaveBeenCalled();
  });

  it("on failed verdict writes failure_reason and posts terminal comment", async () => {
    await writeTask("T-FAIL", "in-progress");
    const { deps } = makeHookDeps({ dataDir });
    const ctx = makeCtx();
    await buildVerifierDrivenCreatorBeforeAgent(deps)(makeStageDef(), makeStageInput("T-FAIL"), makeWorkspace(), ctx);
    const agentResult: AgentResult = { verdict: "failed", output: "", attempts: 2, summary: "build broke" };
    await buildVerifierDrivenCreatorAfterAgent(deps)(
      makeStageDef(), makeStageInput("T-FAIL"), agentResult, makeWorkspace(), ctx,
    );
    const { readFile } = await import("node:fs/promises");
    const content = await readFile(join(dataDir, "T-FAIL.md"), "utf-8");
    expect(content).toMatch(/failure_reason:\s*"build broke"/);
  });

  it("on cancelled verdict writes status=cancelled", async () => {
    await writeTask("T-CANCEL", "in-progress");
    const { deps } = makeHookDeps({ dataDir });
    const ctx = makeCtx();
    await buildVerifierDrivenCreatorBeforeAgent(deps)(makeStageDef(), makeStageInput("T-CANCEL"), makeWorkspace(), ctx);
    const agentResult: AgentResult = { verdict: "cancelled", output: "", attempts: 1, summary: "superseded" };
    await buildVerifierDrivenCreatorAfterAgent(deps)(
      makeStageDef(), makeStageInput("T-CANCEL"), agentResult, makeWorkspace(), ctx,
    );
    const { readFile } = await import("node:fs/promises");
    const content = await readFile(join(dataDir, "T-CANCEL.md"), "utf-8");
    expect(content).toMatch(/status:\s*cancelled/);
  });

  it("on approved verdict with PR present: posts success comment", async () => {
    await writeTask("T-WITH-PR", "in-progress");
    const { deps, mocks } = makeHookDeps({ dataDir });
    mocks.vcs.getCodeReviews.mockResolvedValue([
      { id: 555, title: "", url: "", branch: "ai/tasks/T-WITH-PR", baseBranch: "develop", labels: [], comments: [], draft: true, merged: false, closed: false },
    ]);
    const ctx = makeCtx();
    await buildVerifierDrivenCreatorBeforeAgent(deps)(makeStageDef(), makeStageInput("T-WITH-PR"), makeWorkspace(), ctx);
    expect(mocks.prManager.markProcessing).toHaveBeenCalledWith(555);
    const agentResult: AgentResult = { verdict: "approved", output: "", attempts: 1, summary: "ok" };
    await buildVerifierDrivenCreatorAfterAgent(deps)(
      makeStageDef(), makeStageInput("T-WITH-PR"), agentResult, makeWorkspace(), ctx,
    );
    expect(mocks.prManager.postBotComment).toHaveBeenCalledWith(555, expect.stringContaining("completed successfully"));
  });

  it("on failed verdict with PR present: posts terminal failed comment", async () => {
    await writeTask("T-FAIL-PR", "in-progress");
    const { deps, mocks } = makeHookDeps({ dataDir });
    mocks.vcs.getCodeReviews.mockResolvedValue([
      { id: 600, title: "", url: "", branch: "ai/tasks/T-FAIL-PR", baseBranch: "develop", labels: [], comments: [], draft: true, merged: false, closed: false },
    ]);
    const ctx = makeCtx();
    await buildVerifierDrivenCreatorBeforeAgent(deps)(makeStageDef(), makeStageInput("T-FAIL-PR"), makeWorkspace(), ctx);
    const agentResult: AgentResult = { verdict: "failed", output: "", attempts: 2, summary: "reason" };
    await buildVerifierDrivenCreatorAfterAgent(deps)(
      makeStageDef(), makeStageInput("T-FAIL-PR"), agentResult, makeWorkspace(), ctx,
    );
    expect(mocks.prManager.postBotComment).toHaveBeenCalledWith(600, expect.stringContaining("failed"));
  });

  it("on rejected verdict: posts rejected comment with scope-regeneration message", async () => {
    await writeTask("T-REJ", "in-progress");
    const { deps, mocks } = makeHookDeps({ dataDir });
    mocks.vcs.getCodeReviews.mockResolvedValue([
      { id: 700, title: "", url: "", branch: "ai/tasks/T-REJ", baseBranch: "develop", labels: [], comments: [], draft: true, merged: false, closed: false },
    ]);
    const ctx = makeCtx();
    await buildVerifierDrivenCreatorBeforeAgent(deps)(makeStageDef(), makeStageInput("T-REJ"), makeWorkspace(), ctx);
    const agentResult: AgentResult = { verdict: "rejected", output: "", attempts: 1, summary: "scope wrong" };
    await buildVerifierDrivenCreatorAfterAgent(deps)(
      makeStageDef(), makeStageInput("T-REJ"), agentResult, makeWorkspace(), ctx,
    );
    expect(mocks.prManager.postBotComment).toHaveBeenCalledWith(700, expect.stringContaining("rejected"));
  });

  it("on cancelled verdict: posts cancelled comment", async () => {
    await writeTask("T-CANCEL-PR", "in-progress");
    const { deps, mocks } = makeHookDeps({ dataDir });
    mocks.vcs.getCodeReviews.mockResolvedValue([
      { id: 800, title: "", url: "", branch: "ai/tasks/T-CANCEL-PR", baseBranch: "develop", labels: [], comments: [], draft: true, merged: false, closed: false },
    ]);
    const ctx = makeCtx();
    await buildVerifierDrivenCreatorBeforeAgent(deps)(makeStageDef(), makeStageInput("T-CANCEL-PR"), makeWorkspace(), ctx);
    const agentResult: AgentResult = { verdict: "cancelled", output: "", attempts: 1, summary: "superseded" };
    await buildVerifierDrivenCreatorAfterAgent(deps)(
      makeStageDef(), makeStageInput("T-CANCEL-PR"), agentResult, makeWorkspace(), ctx,
    );
    expect(mocks.prManager.postBotComment).toHaveBeenCalledWith(800, expect.stringContaining("cancelled"));
  });

  it("throws when beforeAgent scratch is missing", async () => {
    await writeTask("T-NO-SCRATCH", "pending");
    const { deps } = makeHookDeps({ dataDir });
    const ctx = makeCtx();
    const agentResult: AgentResult = { verdict: "approved", output: "", attempts: 1, summary: "" };
    await expect(
      buildVerifierDrivenCreatorAfterAgent(deps)(
        makeStageDef(), makeStageInput("T-NO-SCRATCH"), agentResult, makeWorkspace(), ctx,
      ),
    ).rejects.toThrow(/missing scratch/);
  });
});

describe("buildVerifierDrivenCreatorBeforeAgent", () => {
  let dataDir: string;
  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "op-beforeagent-"));
  });
  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  async function writeTask(id: string, status: string, extra = ""): Promise<void> {
    const content = `---\nid: ${id}\ntype: task\ntitle: "${id}"\nstatus: ${status}\npriority: 3\ncreated_at: "2026-04-16"\n${extra}---\n\n${id} body.`;
    await writeFile(join(dataDir, `${id}.md`), content, "utf-8");
  }

  it("resets failed work-item to pending, clears failure fields", async () => {
    await writeTask("T-FAILED", "failed", "failed_at: \"2026-04-15\"\nfailure_reason: \"old\"\nexecution_attempts: 2\n");
    const { deps } = makeHookDeps({ dataDir });
    await buildVerifierDrivenCreatorBeforeAgent(deps)(makeStageDef(), makeStageInput("T-FAILED"), makeWorkspace(), makeCtx());
    const { readFile } = await import("node:fs/promises");
    const content = await readFile(join(dataDir, "T-FAILED.md"), "utf-8");
    expect(content).toMatch(/status:\s*pending/);
    expect(content).not.toMatch(/failed_at:/);
    expect(content).not.toMatch(/failure_reason:/);
    expect(content).not.toMatch(/execution_attempts:/);
  });
});

describe("buildVerifierDrivenCreatorBuildPR", () => {
  let dataDir: string;
  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "op-buildpr-"));
  });
  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it("returns title/body/commitMessage with onSuccess=in-review", async () => {
    await writeFile(
      join(dataDir, "T-BUILD.md"),
      `---\nid: T-BUILD\ntype: task\ntitle: "Build thing"\nstatus: pending\npriority: 3\ncreated_at: "2026-04-16"\n---\n\nbody`,
      "utf-8",
    );
    const { deps } = makeHookDeps({ dataDir });
    const pr = await buildVerifierDrivenCreatorBuildPR(deps)(makeStageDef(), makeStageInput("T-BUILD"), makeCtx());
    expect(pr.title).toContain("T-BUILD");
    expect(pr.title).toContain("Build thing");
    expect(pr.commitMessage).toContain("T-BUILD");
    expect(pr.onSuccess).toBe("in-review");
  });

  it("passes title/priority/parent/summary to the PR template so reviewers see the task inline (no file pointer required)", async () => {
    // Regression: the v3-era task PR template carried only `{TASK_ID}` plus
    // a "see .operator/data/tasks/{TASK_ID}.md for task details" pointer,
    // forcing the human reviewer to open the file to know what was being
    // done. The composer now reads the task and threads the title, priority,
    // parent linkage, and a truncated body summary through `loadTemplate`.
    await writeFile(
      join(dataDir, "T-INLINE.md"),
      `---\nid: T-INLINE\ntype: task\ntitle: "Refactor selectors"\nstatus: pending\npriority: 2\nparent_id: "F-ROOT"\ncreated_at: "2026-04-16"\n---\n\nRework name-sort fallback to share the case-insensitive comparator already living in the base class.`,
      "utf-8",
    );
    const { deps, mocks } = makeHookDeps({ dataDir });
    await buildVerifierDrivenCreatorBuildPR(deps)(makeStageDef(), makeStageInput("T-INLINE"), makeCtx());
    expect(mocks.prManager.loadTemplate).toHaveBeenCalledWith(
      expect.any(String),
      "task-pr-inprogress-body.md",
      expect.objectContaining({
        TASK_ID: "T-INLINE",
        ITEM_ID: "T-INLINE",
        TITLE: "Refactor selectors",
        PRIORITY: "2",
        PARENT: "F-ROOT",
        SUMMARY: expect.stringContaining("name-sort fallback"),
      }),
    );
  });

  it("truncates long task body to keep the PR description readable", async () => {
    const longBody = "x".repeat(2000);
    await writeFile(
      join(dataDir, "T-LONG.md"),
      `---\nid: T-LONG\ntype: task\ntitle: "Long task"\nstatus: pending\npriority: 3\ncreated_at: "2026-04-16"\n---\n\n${longBody}`,
      "utf-8",
    );
    const { deps, mocks } = makeHookDeps({ dataDir });
    await buildVerifierDrivenCreatorBuildPR(deps)(makeStageDef(), makeStageInput("T-LONG"), makeCtx());
    const call = mocks.prManager.loadTemplate.mock.calls[0];
    const vars = call[2] as Record<string, string>;
    expect(vars.SUMMARY.length).toBeLessThan(longBody.length);
    expect(vars.SUMMARY).toContain("[…truncated]");
  });

  it("demotes the task body's headings and drops the duplicate leading H1 so it nests under the PR Summary", async () => {
    // Regression: the task body's own markdown headings (`#`, `##`) were
    // dumped raw under the template's `### Summary` (an H3), so a task `# Title`
    // rendered as a top-level PR heading and the leading H1 duplicated the PR
    // title — the cause of the unreadable PR description observed 2026-06-19.
    await writeFile(
      join(dataDir, "T-HEAD.md"),
      `---\nid: T-HEAD\ntype: task\ntitle: "Add docs page"\nstatus: pending\npriority: 1\ncreated_at: "2026-04-16"\n---\n\n# Add docs page\n\n## Problem\n\nNo in-app guide exists.\n\n## Solution\n\nRun the skill.`,
      "utf-8",
    );
    const { deps, mocks } = makeHookDeps({ dataDir });
    await buildVerifierDrivenCreatorBuildPR(deps)(makeStageDef(), makeStageInput("T-HEAD"), makeCtx());
    const vars = mocks.prManager.loadTemplate.mock.calls[0][2] as Record<string, string>;
    expect(vars.SUMMARY).not.toContain("# Add docs page");
    expect(vars.SUMMARY).toContain("#### Problem");
    expect(vars.SUMMARY).toContain("#### Solution");
    expect(vars.SUMMARY).not.toMatch(/^## Problem/m);
  });
});

describe("buildVerifierDrivenCreatorBuildRunInput", () => {
  let dataDir: string;
  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "op-buildrun-"));
  });
  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it("builds a valid AgentRunInput for the configured agent role", async () => {
    await writeFile(
      join(dataDir, "T-RUN.md"),
      `---\nid: T-RUN\ntype: task\ntitle: "Run"\nstatus: pending\npriority: 3\ncreated_at: "2026-04-16"\n---\n\ntask body`,
      "utf-8",
    );
    const { deps } = makeHookDeps({ dataDir });
    const input = await buildVerifierDrivenCreatorBuildRunInput(deps)(makeStageDef(), makeStageInput("T-RUN"), makeCtx());
    expect(input.agentName).toBe("creator");
    expect(input.taskContent).toContain("task body");
    expect(input.promptContext.vars).toMatchObject({ TASK_ID: "T-RUN", ITEM_ID: "T-RUN" });
  });
});
