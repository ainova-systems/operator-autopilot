import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, rm, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OperationContext, StateManager } from "@operator/core";
import type { AgentsFile } from "../../config/schemas.js";
import type { StageDef, StageInput, AgentResult } from "../types.js";
import {
  buildAopPlannerBeforeAgent,
  buildAopPlannerAfterAgent,
  buildAopPlannerBuildRunInput,
  buildAopPlannerBuildPR,
  buildAopPlannerSynthesizeAgentResult,
  type AopPlannerHookDeps,
} from "./aop-planner-stage.js";
import { makeTestKindRegistry } from "../../test-helpers/test-kind-registry.js";

function makeCtx(): OperationContext {
  return {
    traceId: `trace-${Math.random()}`,
    repoId: "sample",
    action: "test",
    budget: { limitUsd: undefined, spentUsd: 0, add: () => {}, isExceeded: () => false },
    signal: AbortSignal.timeout(10_000),
  };
}

function makeStageDef(): StageDef {
  return {
    name: "finding-plan", agent: "planner", selector: "per-item",
    merge: "gated", branchScope: "per-item", branchPrefix: "ai/findings",
    schedule: "*/5 * * * *", enabled: true, baseBranch: "develop",
  };
}

function makeStageInput(id: string): StageInput {
  return { scopeKey: id };
}

function makeWorkspace(branch: string) {
  return { branch, baseBranch: "develop", existedRemote: false };
}

function makeAopPlannerDeps(overrides: { findingsDir: string; tasksDir: string } & Partial<AopPlannerHookDeps>): AopPlannerHookDeps {
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
    closeAndClean: vi.fn().mockResolvedValue(undefined),
    postBotComment: vi.fn().mockResolvedValue(undefined),
    loadTemplate: vi.fn().mockResolvedValue("body"),
  };
  const git = { headSha: vi.fn().mockResolvedValue("abc123") };
  const vcs = { getCodeReviews: vi.fn().mockResolvedValue([]) };
  const log = {
    info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(),
    child: vi.fn(),
  } as unknown as AopPlannerHookDeps["log"];
  const { findingsDir, tasksDir, ...rest } = overrides;
  return {
    state,
    vcs: vcs as unknown as AopPlannerHookDeps["vcs"],
    prManager: prManager as unknown as AopPlannerHookDeps["prManager"],
    git: git as unknown as AopPlannerHookDeps["git"],
    kindRegistry: makeTestKindRegistry(),
    parentDataDir: findingsDir,
    childDataDir: tasksDir,
    automationDir: "/tmp/.operator",
    workspacePath: "/tmp/ws",
    templatesDir: "/tmp/templates",
    agentsConfig: { defaultProvider: "claude", providers: { claude: { command: "claude" } }, agents: { planner: { instructions: "agents/planner.md", timeout: 600 } } } as unknown as AgentsFile,
    promptSource: { loadChain: vi.fn().mockResolvedValue("") } as unknown as AopPlannerHookDeps["promptSource"],
    workItemSource: {
      create: vi.fn((rec) => Promise.resolve(rec)),
      read: vi.fn(), updateStatus: vi.fn(), updateBody: vi.fn(), list: vi.fn(),
    } as unknown as AopPlannerHookDeps["workItemSource"],
    agentEventStream: {
      parse: vi.fn().mockReturnValue({ events: [], diagnostics: [] }),
    } as unknown as AopPlannerHookDeps["agentEventStream"],
    log,
    parentKind: "finding",
    agentRole: "planner",
    verifierTopic: "finding",
    branchPrefix: "ai/findings",
    prPrefix: "[AI:Finding]",
    prTemplate: "finding-pr-inprogress-body.md",
    displayName: "Finding",
    idPrefix: "F",
    idVarName: "FINDING_ID",
    seqVarName: "FINDING_SEQ",
    ...rest,
  };
}

async function writeFinding(dir: string, id: string, status: string): Promise<void> {
  const content = `---\nid: ${id}\ntype: finding\ntitle: "${id} title"\nstatus: ${status}\npriority: 3\ncreated_at: "2026-04-16"\nsource: "analyzer-x"\n---\n\n${id} body paragraph.`;
  await writeFile(join(dir, `${id}.md`), content, "utf-8");
}

/**
 * Override the AOP event stream on supplied deps to inject typed events
 * the applier will see — mirrors what `parseAgentOutput` would emit in
 * production but lets tests bypass the text-block format coupling.
 */
function withStream(deps: AopPlannerHookDeps, events: ReadonlyArray<Record<string, unknown>>, diagnostics: ReadonlyArray<Record<string, unknown>> = []): AopPlannerHookDeps {
  return {
    ...deps,
    agentEventStream: {
      parse: vi.fn().mockReturnValue({ events, diagnostics }),
    } as unknown as AopPlannerHookDeps["agentEventStream"],
  };
}

// Legacy parseVerdict / parseTaskBlocks tests removed in S2 — the planner
// now emits AOP `EMIT verdict` + `EMIT child-item` records via the F1
// text-block parser (engine/pipeline/primitives/agent-output-protocol.ts).
// Coverage for the new parser lives in agent-output-protocol.test.ts; this
// file now only exercises the hook composition + idempotency logic.

// ── Hook closure tests ─────────────────────────────────────────────────

describe("buildAopPlannerBeforeAgent", () => {
  let findingsDir: string;
  let tasksDir: string;
  beforeEach(async () => {
    findingsDir = await mkdtemp(join(tmpdir(), "op-findplan-"));
    tasksDir = await mkdtemp(join(tmpdir(), "op-findplan-t-"));
  });
  afterEach(async () => {
    await rm(findingsDir, { recursive: true, force: true });
    await rm(tasksDir, { recursive: true, force: true });
  });

  it("resets failed → in-progress and snapshots HEAD", async () => {
    await writeFile(
      join(findingsDir, "F-001.md"),
      `---\nid: F-001\ntype: finding\ntitle: "F-001"\nstatus: failed\npriority: 3\ncreated_at: "2026-04-16"\nfailed_at: "2026-04-15"\n---\n\nbody`,
      "utf-8",
    );
    const deps = makeAopPlannerDeps({ findingsDir, tasksDir });
    await buildAopPlannerBeforeAgent(deps)(makeStageDef(), makeStageInput("F-001"), makeWorkspace("ai/findings/F-001"), makeCtx());
    const content = await readFile(join(findingsDir, "F-001.md"), "utf-8");
    expect(content).toMatch(/status:\s*in-progress/);
    expect(content).not.toMatch(/failed_at:/);
    expect(deps.git.headSha).toHaveBeenCalled();
  });
});

describe("buildAopPlannerAfterAgent", () => {
  let findingsDir: string;
  let tasksDir: string;
  beforeEach(async () => {
    findingsDir = await mkdtemp(join(tmpdir(), "op-findplan-after-"));
    tasksDir = await mkdtemp(join(tmpdir(), "op-findplan-aftert-"));
  });
  afterEach(async () => {
    await rm(findingsDir, { recursive: true, force: true });
    await rm(tasksDir, { recursive: true, force: true });
  });

  it("VALID + EMIT child-item: calls workItemSource.create per task and overrides summary", async () => {
    await writeFinding(findingsDir, "F-OK", "in-progress");
    const baseDeps = makeAopPlannerDeps({ findingsDir, tasksDir });
    const deps = withStream(baseDeps, [
      { type: "child-item", kind: "task", parent: "self", title: "child 1", body: "body 1", priority: 3 },
      { type: "verdict", value: "approved", summary: "1 task created" },
    ]);
    const ctx = makeCtx();
    await buildAopPlannerBeforeAgent(deps)(makeStageDef(), makeStageInput("F-OK"), makeWorkspace("ai/findings/F-OK"), ctx);
    const agentResult: AgentResult = { verdict: "approved", output: "irrelevant", attempts: 1, summary: "raw" };
    const override = await buildAopPlannerAfterAgent(deps)(
      makeStageDef(), makeStageInput("F-OK"), agentResult, makeWorkspace("ai/findings/F-OK"), ctx,
    );
    expect(override?.summaryOverride).toContain("1 item");
    expect(deps.workItemSource.create).toHaveBeenCalledTimes(1);
    expect(deps.workItemSource.create).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "task", parentId: "F-OK", title: "child 1" }),
      expect.anything(),
    );
  });

  it("does NOT upsert newly-created child tasks into KV state (state mirrors develop)", async () => {
    // Regression: T20260416-000301 ENOENT in same-cycle task-execute. Tasks
    // land in state via syncFilesToState after the plan PR merges, never
    // upserted directly by finding-plan.afterAgent.
    await writeFinding(findingsDir, "F-NOSYNC", "in-progress");
    const baseDeps = makeAopPlannerDeps({ findingsDir, tasksDir });
    const deps = withStream(baseDeps, [
      { type: "child-item", kind: "task", parent: "self", title: "t", body: "body", priority: 3 },
      { type: "verdict", value: "approved", summary: "1 task created" },
    ]);
    const ctx = makeCtx();
    await buildAopPlannerBeforeAgent(deps)(makeStageDef(), makeStageInput("F-NOSYNC"), makeWorkspace("ai/findings/F-NOSYNC"), ctx);
    const agentResult: AgentResult = { verdict: "approved", output: "irrelevant", attempts: 1, summary: "" };
    await buildAopPlannerAfterAgent(deps)(
      makeStageDef(), makeStageInput("F-NOSYNC"), agentResult, makeWorkspace("ai/findings/F-NOSYNC"), ctx,
    );
    expect(deps.workItemSource.create).toHaveBeenCalledTimes(1);
    // The finding's own status bump syncs through state.updateWorkItemStatus
    // via updateStatusAndSync, but no child-task row is upserted directly.
    const upsertCalls = (deps.state.upsertWorkItem as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    const taskUpserts = upsertCalls.filter((args) => {
      const item = args[1] as { kind?: string; id?: string };
      return item.kind === "task";
    });
    expect(taskUpserts).toHaveLength(0);
  });

  it("VALID verdict bumps a pending finding to in-progress on the workspace file", async () => {
    // Symmetric to task-execute: orchestrator owns the forward-flow
    // status transition. Without this bump, develop stays `pending`
    // after the plan PR merges and the selector re-picks the finding
    // (the PR-on-PR loop seen on a real repo across PRs #780/#808/#820).
    await writeFinding(findingsDir, "F-FRESH", "pending");
    const baseDeps = makeAopPlannerDeps({ findingsDir, tasksDir });
    const deps = withStream(baseDeps, [
      { type: "child-item", kind: "task", parent: "self", title: "t1", body: "body", priority: 3 },
      { type: "verdict", value: "approved", summary: "1 task created" },
    ]);
    const ctx = makeCtx();
    await buildAopPlannerBeforeAgent(deps)(makeStageDef(), makeStageInput("F-FRESH"), makeWorkspace("ai/findings/F-FRESH"), ctx);
    const agentResult: AgentResult = { verdict: "approved", output: "irrelevant", attempts: 1, summary: "raw" };
    await buildAopPlannerAfterAgent(deps)(
      makeStageDef(), makeStageInput("F-FRESH"), agentResult, makeWorkspace("ai/findings/F-FRESH"), ctx,
    );
    const updated = await readFile(join(findingsDir, "F-FRESH.md"), "utf-8");
    expect(updated).toContain("status: in-progress");
    expect(updated).toContain("started_at:");
  });

  it("idempotency: when child tasks already exist, skips planner and refreshes status only", async () => {
    // Pre-existing child task with parent_id pointing at this finding —
    // simulates the state observed after an earlier plan PR merged.
    await writeFinding(findingsDir, "F-DUP", "pending");
    const childContent = [
      "---",
      "id: T-CHILD-1",
      "kind: task",
      "title: \"child\"",
      "status: pending",
      "priority: 3",
      "parent_id: \"F-DUP\"",
      "created_at: \"2026-05-01\"",
      "---",
      "",
      "child body",
    ].join("\n");
    await writeFile(join(tasksDir, "T-CHILD-1.md"), childContent, "utf-8");

    const deps = makeAopPlannerDeps({ findingsDir, tasksDir });
    const ctx = makeCtx();

    // beforeAgent should detect the child, set scratch.alreadyPlannedChildren.
    await buildAopPlannerBeforeAgent(deps)(makeStageDef(), makeStageInput("F-DUP"), makeWorkspace("ai/findings/F-DUP"), ctx);

    // synthesizeAgentResult should now return a synthetic approved result.
    const synth = buildAopPlannerSynthesizeAgentResult(deps);
    const synthesized = await synth(makeStageDef(), makeStageInput("F-DUP"), makeWorkspace("ai/findings/F-DUP"), ctx);
    expect(synthesized).not.toBeNull();
    expect(synthesized!.verdict).toBe("approved");
    expect(synthesized!.summary).toContain("already planned");

    // afterAgent must NOT call createWorkItemFile — but must bump status
    // (because finding is still `pending` here).
    const before = await readdir(tasksDir);
    const override = await buildAopPlannerAfterAgent(deps)(
      makeStageDef(), makeStageInput("F-DUP"), synthesized!, makeWorkspace("ai/findings/F-DUP"), ctx,
    );
    const after = await readdir(tasksDir);
    expect(after).toEqual(before); // no new task files

    expect(override?.summaryOverride).toContain("already planned");
    const updated = await readFile(join(findingsDir, "F-DUP.md"), "utf-8");
    expect(updated).toContain("status: in-progress");
  });

  it("synthesize returns null when no children exist (planner runs normally)", async () => {
    await writeFinding(findingsDir, "F-NEW", "pending");
    const deps = makeAopPlannerDeps({ findingsDir, tasksDir });
    const ctx = makeCtx();
    await buildAopPlannerBeforeAgent(deps)(makeStageDef(), makeStageInput("F-NEW"), makeWorkspace("ai/findings/F-NEW"), ctx);
    const synth = buildAopPlannerSynthesizeAgentResult(deps);
    const synthesized = await synth(makeStageDef(), makeStageInput("F-NEW"), makeWorkspace("ai/findings/F-NEW"), ctx);
    expect(synthesized).toBeNull();
  });

  it("VALID verdict + no tasks (no EMIT child-item): overrides verdict to failed", async () => {
    await writeFinding(findingsDir, "F-EMPTY", "in-progress");
    const baseDeps = makeAopPlannerDeps({ findingsDir, tasksDir });
    // Approved verdict event, no child-item events.
    const deps = withStream(baseDeps, [
      { type: "verdict", value: "approved", summary: "no children" },
    ]);
    const ctx = makeCtx();
    await buildAopPlannerBeforeAgent(deps)(makeStageDef(), makeStageInput("F-EMPTY"), makeWorkspace("ai/findings/F-EMPTY"), ctx);
    const agentResult: AgentResult = { verdict: "approved", output: "irrelevant", attempts: 1, summary: "" };
    const override = await buildAopPlannerAfterAgent(deps)(
      makeStageDef(), makeStageInput("F-EMPTY"), agentResult, makeWorkspace("ai/findings/F-EMPTY"), ctx,
    );
    expect(override?.verdictOverride).toBe("failed");
    expect(override?.summaryOverride).toContain("EMIT child-item");
  });

  it("INVALID verdict (EMIT verdict rejected): overrides verdict to rejected without auto-closing PR (no PR pre-existed → no comment either)", async () => {
    await writeFinding(findingsDir, "F-BAD", "in-progress");
    const baseDeps = makeAopPlannerDeps({ findingsDir, tasksDir });
    const deps = withStream(baseDeps, [
      { type: "verdict", value: "rejected", summary: "Finding invalid — code already handles case" },
    ]);
    const ctx = makeCtx();
    await buildAopPlannerBeforeAgent(deps)(makeStageDef(), makeStageInput("F-BAD"), makeWorkspace("ai/findings/F-BAD"), ctx);
    const agentResult: AgentResult = { verdict: "approved", output: "irrelevant", attempts: 1, summary: "" };
    const override = await buildAopPlannerAfterAgent(deps)(
      makeStageDef(), makeStageInput("F-BAD"), agentResult, makeWorkspace("ai/findings/F-BAD"), ctx,
    );
    expect(override?.verdictOverride).toBe("rejected");
    expect(deps.prManager.closeAndClean).not.toHaveBeenCalled();
  });

  it("HEAD moved contract violation → verdict=failed (applier never runs)", async () => {
    await writeFinding(findingsDir, "F-HEAD", "in-progress");
    const deps = makeAopPlannerDeps({ findingsDir, tasksDir });
    (deps.git.headSha as unknown as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce("abc123")
      .mockResolvedValueOnce("def456");
    const ctx = makeCtx();
    await buildAopPlannerBeforeAgent(deps)(makeStageDef(), makeStageInput("F-HEAD"), makeWorkspace("ai/findings/F-HEAD"), ctx);
    const agentResult: AgentResult = { verdict: "approved", output: "irrelevant", attempts: 1, summary: "" };
    const override = await buildAopPlannerAfterAgent(deps)(
      makeStageDef(), makeStageInput("F-HEAD"), agentResult, makeWorkspace("ai/findings/F-HEAD"), ctx,
    );
    expect(override?.verdictOverride).toBe("failed");
    expect(override?.summaryOverride).toContain("read-only");
  });

  it("non-approved runtime verdict maps to work-item status", async () => {
    await writeFinding(findingsDir, "F-RUNTIME", "in-progress");
    const deps = makeAopPlannerDeps({ findingsDir, tasksDir });
    const ctx = makeCtx();
    await buildAopPlannerBeforeAgent(deps)(makeStageDef(), makeStageInput("F-RUNTIME"), makeWorkspace("ai/findings/F-RUNTIME"), ctx);
    const agentResult: AgentResult = { verdict: "failed", output: "", attempts: 2, summary: "retries exhausted" };
    const override = await buildAopPlannerAfterAgent(deps)(
      makeStageDef(), makeStageInput("F-RUNTIME"), agentResult, makeWorkspace("ai/findings/F-RUNTIME"), ctx,
    );
    // Does not override verdict — already reflects runtime failure.
    expect(override).toBeUndefined();
    const content = await readFile(join(findingsDir, "F-RUNTIME.md"), "utf-8");
    expect(content).toMatch(/status:\s*failed/);
  });

  it("VALID + tasks (EMIT child-item) + PR present: posts success comment with task list", async () => {
    await writeFinding(findingsDir, "F-PR-OK", "in-progress");
    const baseDeps = makeAopPlannerDeps({ findingsDir, tasksDir });
    (baseDeps.vcs.getCodeReviews as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: 555, title: "", url: "", branch: "ai/findings/F-PR-OK", baseBranch: "develop", labels: [], comments: [], draft: true, merged: false, closed: false },
    ]);
    const deps = withStream(baseDeps, [
      { type: "child-item", kind: "task", parent: "self", title: "new task", body: "task body", priority: 3 },
      { type: "verdict", value: "approved", summary: "1 task created" },
    ]);
    const ctx = makeCtx();
    await buildAopPlannerBeforeAgent(deps)(makeStageDef(), makeStageInput("F-PR-OK"), makeWorkspace("ai/findings/F-PR-OK"), ctx);
    const agentResult: AgentResult = { verdict: "approved", output: "irrelevant", attempts: 1, summary: "" };
    await buildAopPlannerAfterAgent(deps)(
      makeStageDef(), makeStageInput("F-PR-OK"), agentResult, makeWorkspace("ai/findings/F-PR-OK"), ctx,
    );
    expect(deps.prManager.postBotComment).toHaveBeenCalledWith(555, expect.stringContaining("verified"));
  });

  it("INVALID verdict (EMIT verdict rejected) + PR present: posts rejection comment but does NOT auto-close (PR awaits human review)", async () => {
    // 2026-05-13 MVP-rules fix: removed auto-close on rejected verdict.
    // The rejection PR is a normal data-sync vehicle that propagates the
    // status=rejected flip to develop when the human merges it. Auto-close
    // violated the user's explicit MVP rule "never auto-close PRs unless
    // stage config declares it". The afterAgent posts a bot comment with
    // rejection reasoning so the human reviewer sees the agent's analysis;
    // human then merges (propagate rejection) or closes-without-merge
    // (override the rejection — supervisor picks it up next cycle).
    await writeFinding(findingsDir, "F-PR-BAD", "in-progress");
    const baseDeps = makeAopPlannerDeps({ findingsDir, tasksDir });
    (baseDeps.vcs.getCodeReviews as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: 600, title: "", url: "", branch: "ai/findings/F-PR-BAD", baseBranch: "develop", labels: [], comments: [], draft: true, merged: false, closed: false },
    ]);
    const deps = withStream(baseDeps, [
      { type: "verdict", value: "rejected", summary: "finding invalid" },
    ]);
    const ctx = makeCtx();
    await buildAopPlannerBeforeAgent(deps)(makeStageDef(), makeStageInput("F-PR-BAD"), makeWorkspace("ai/findings/F-PR-BAD"), ctx);
    const agentResult: AgentResult = { verdict: "approved", output: "irrelevant", attempts: 1, summary: "" };
    await buildAopPlannerAfterAgent(deps)(
      makeStageDef(), makeStageInput("F-PR-BAD"), agentResult, makeWorkspace("ai/findings/F-PR-BAD"), ctx,
    );
    expect(deps.prManager.postBotComment).toHaveBeenCalledWith(
      600,
      expect.stringContaining("determined invalid"),
    );
    expect(deps.prManager.closeAndClean).not.toHaveBeenCalled();
  });

  it("non-approved runtime verdict + PR: posts terminal comment", async () => {
    await writeFinding(findingsDir, "F-PR-CANCEL", "in-progress");
    const deps = makeAopPlannerDeps({ findingsDir, tasksDir });
    (deps.vcs.getCodeReviews as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: 700, title: "", url: "", branch: "ai/findings/F-PR-CANCEL", baseBranch: "develop", labels: [], comments: [], draft: true, merged: false, closed: false },
    ]);
    const ctx = makeCtx();
    await buildAopPlannerBeforeAgent(deps)(makeStageDef(), makeStageInput("F-PR-CANCEL"), makeWorkspace("ai/findings/F-PR-CANCEL"), ctx);
    const agentResult: AgentResult = { verdict: "cancelled", output: "", attempts: 1, summary: "stale" };
    await buildAopPlannerAfterAgent(deps)(
      makeStageDef(), makeStageInput("F-PR-CANCEL"), agentResult, makeWorkspace("ai/findings/F-PR-CANCEL"), ctx,
    );
    expect(deps.prManager.postBotComment).toHaveBeenCalledWith(700, expect.stringContaining("cancelled"));
  });

  it("rejected runtime verdict + PR: posts rejected comment", async () => {
    await writeFinding(findingsDir, "F-PR-REJ", "in-progress");
    const deps = makeAopPlannerDeps({ findingsDir, tasksDir });
    (deps.vcs.getCodeReviews as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: 800, title: "", url: "", branch: "ai/findings/F-PR-REJ", baseBranch: "develop", labels: [], comments: [], draft: true, merged: false, closed: false },
    ]);
    const ctx = makeCtx();
    await buildAopPlannerBeforeAgent(deps)(makeStageDef(), makeStageInput("F-PR-REJ"), makeWorkspace("ai/findings/F-PR-REJ"), ctx);
    const agentResult: AgentResult = { verdict: "rejected", output: "", attempts: 1, summary: "scope" };
    await buildAopPlannerAfterAgent(deps)(
      makeStageDef(), makeStageInput("F-PR-REJ"), agentResult, makeWorkspace("ai/findings/F-PR-REJ"), ctx,
    );
    expect(deps.prManager.postBotComment).toHaveBeenCalledWith(800, expect.stringContaining("rejected"));
  });

  it("throws when beforeAgent scratch missing", async () => {
    await writeFinding(findingsDir, "F-NO", "pending");
    const deps = makeAopPlannerDeps({ findingsDir, tasksDir });
    const agentResult: AgentResult = { verdict: "approved", output: "", attempts: 1, summary: "" };
    await expect(
      buildAopPlannerAfterAgent(deps)(
        makeStageDef(), makeStageInput("F-NO"), agentResult, makeWorkspace("ai/findings/F-NO"), makeCtx(),
      ),
    ).rejects.toThrow(/missing scratch/);
  });
});

describe("buildAopPlannerBuildPR / buildRunInput", () => {
  let findingsDir: string;
  let tasksDir: string;
  beforeEach(async () => {
    findingsDir = await mkdtemp(join(tmpdir(), "op-findpr-"));
    tasksDir = await mkdtemp(join(tmpdir(), "op-findpr-t-"));
    await writeFinding(findingsDir, "F-PR", "in-progress");
  });
  afterEach(async () => {
    await rm(findingsDir, { recursive: true, force: true });
    await rm(tasksDir, { recursive: true, force: true });
  });

  it("buildPR returns title/body/commitMessage with onSuccess=in-review (standard in-progress path)", async () => {
    const deps = makeAopPlannerDeps({ findingsDir, tasksDir });
    const pr = await buildAopPlannerBuildPR(deps)(makeStageDef(), makeStageInput("F-PR"), makeCtx());
    expect(pr.title).toContain("F-PR");
    expect(pr.title).not.toContain("REJECTED");
    expect(pr.title).not.toContain("catch-up");
    expect(pr.commitMessage).toContain("planner emitted");
    expect(pr.onSuccess).toBe("in-review");
  });

  it("buildPR renders catch-up title + self-describing body when scratch carries alreadyPlannedChildren", async () => {
    // Plan-vs-catch-up discriminator: beforeAgent's idempotency scan
    // populates scratch.alreadyPlannedChildren when child items for the
    // parent finding already exist on develop. buildPR reads it (same
    // ctx, same scratch entry) and renders a self-describing PR so the
    // human reviewer does NOT have to guess why the diff is just a
    // status flip with no child files attached.
    const deps = makeAopPlannerDeps({ findingsDir, tasksDir });
    const ctx = makeCtx();
    // Pre-seed a child task so beforeAgent's findChildrenByParentId returns it.
    const childContent = [
      "---",
      "id: T-EXISTING-1",
      "kind: task",
      "title: \"existing child\"",
      "status: pending",
      "priority: 3",
      "parent_id: \"F-PR\"",
      "created_at: \"2026-05-01\"",
      "---",
      "",
      "child body",
    ].join("\n");
    await writeFile(join(tasksDir, "T-EXISTING-1.md"), childContent, "utf-8");
    await buildAopPlannerBeforeAgent(deps)(makeStageDef(), makeStageInput("F-PR"), makeWorkspace("ai/findings/F-PR"), ctx);
    const pr = await buildAopPlannerBuildPR(deps)(makeStageDef(), makeStageInput("F-PR"), ctx);
    expect(pr.title).toContain("F-PR");
    expect(pr.title).toContain("catch-up");
    expect(pr.title).not.toContain("REJECTED");
    expect(pr.body).toContain("catch-up");
    expect(pr.body).toContain("planner skipped");
    expect(pr.body).toContain("T-EXISTING-1");
    expect(pr.body).toContain("safe to merge");
    expect(pr.commitMessage).toContain("catch-up");
    expect(pr.commitMessage).toContain("1 child");
    expect(pr.onSuccess).toBe("in-review");
  });

  it("buildPR renders REJECTED title + rejection-specific body when afterAgent stashed rejection in scratch", async () => {
    // Fix 8 (2026-05-13): rejection PR carries the agent's reasoning
    // directly in the PR description so the human reviewer sees what was
    // rejected and why without opening the execution log. Mechanism: the
    // afterAgent rejected-path stashes `{agentRole, reason}` into
    // scratch.rejection; buildPR (same ctx, same scratch entry) reads it
    // and produces a rejection-specific title + body. Scratch clear was
    // moved from afterAgent.finally to buildPR.finally so the entry
    // survives the afterAgent→buildPR transition.
    const deps = makeAopPlannerDeps({ findingsDir, tasksDir });
    const ctx = makeCtx();
    const depsWithStream = withStream(deps, [
      { type: "verdict", value: "rejected", summary: "Finding invalid — base class already maps name (case-insensitive)" },
    ]);
    await buildAopPlannerBeforeAgent(depsWithStream)(makeStageDef(), makeStageInput("F-PR"), makeWorkspace("ai/findings/F-PR"), ctx);
    const agentResult: AgentResult = { verdict: "approved", output: "irrelevant", attempts: 1, summary: "" };
    await buildAopPlannerAfterAgent(depsWithStream)(
      makeStageDef(), makeStageInput("F-PR"), agentResult, makeWorkspace("ai/findings/F-PR"), ctx,
    );
    const pr = await buildAopPlannerBuildPR(depsWithStream)(makeStageDef(), makeStageInput("F-PR"), ctx);
    expect(pr.title).toContain("REJECTED");
    expect(pr.title).toContain("F-PR");
    expect(pr.body).toContain("rejected by planner");
    expect(pr.body).toContain("Finding invalid");
    expect(pr.body).toContain("status: pending → rejected");
    expect(pr.commitMessage).toContain("rejected");
    expect(pr.onSuccess).toBe("in-review");
  });

  it("buildRunInput returns a planner AgentRunInput", async () => {
    const deps = makeAopPlannerDeps({ findingsDir, tasksDir });
    const input = await buildAopPlannerBuildRunInput(deps)(makeStageDef(), makeStageInput("F-PR"), makeCtx());
    expect(input.agentName).toBe("planner");
    expect(input.taskContent).toContain("F-PR body");
    expect(input.promptContext.vars).toMatchObject({ FINDING_ID: "F-PR" });
  });
});
