import { describe, it, expect, vi } from "vitest";
import type {
  OperationContext, KindRegistry, AgentEventStream, AgentEventParseResult,
  WorkItemSource, WorkItemRecord, WorkItemRef,
} from "@operator/core";
import type { AgentsFile } from "../../config/schemas.js";
import type { StageDef, StageInput, AgentResult } from "../types.js";
import {
  buildPrFeedbackSupervisorBeforeAgent,
  buildPrFeedbackSupervisorBuildRunInput,
  buildPrFeedbackSupervisorBuildPR,
  buildPrFeedbackSupervisorAfterAgent,
  buildPrFeedbackSupervisorSynthesizeAgentResult,
  buildSupervisorTask,
  type PrFeedbackSupervisorHookDeps,
} from "./pr-feedback-supervisor-stage.js";

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
    name: "pr-review",
    agent: "supervisor",
    selector: "pr-feedback",
    merge: "gated",
    branchScope: "pr",
    schedule: "*/5 * * * *",
    enabled: true,
    baseBranch: "develop",
  };
}

function makePayload(overrides: Partial<{
  prId: number; branch: string; prType: string;
  newFeedback: string; fullThread: string; respondedIds: string[];
  ciAttempts: number; maxCiRetryAttempts: number; botAttempts: number;
  oldestFreshAt: string;
  checks: { value: "passing" | "failing" | "pending" | "none"; observedAt: string; headSha?: string; checks: never[] };
}>) {
  return {
    prId: 842,
    branch: "ai/tasks/T20260511-0001",
    baseBranch: "develop",
    prType: "task",
    newFeedback: "User comment: rename foo to bar.",
    fullThread: "User: rename foo to bar.\n",
    botAttempts: 0,
    oldestFreshAt: "2026-05-11T10:00:00Z",
    checks: { value: "passing" as const, observedAt: "2026-05-11T10:00:00Z", checks: [] },
    respondedIds: [],
    ciAttempts: 0,
    maxCiRetryAttempts: 3,
    ...overrides,
  };
}

function makeStageInput(payload: ReturnType<typeof makePayload>): StageInput {
  return { scopeKey: String(payload.prId), data: payload };
}

function makeWorkspace(branch: string, baseBranch = "develop") {
  return { branch, baseBranch, existedRemote: true };
}

function makeAgentResult(verdict: AgentResult["verdict"], output: string, summary = "supervisor decision"): AgentResult {
  return {
    verdict, summary, output,
    attempts: 1,
    costUsd: 0.1,
  } as unknown as AgentResult;
}

function makeTestRegistry(): KindRegistry {
  return {
    all: [
      { name: "finding", idPrefix: "F", dataDir: ".operator/data/findings", branchPrefix: "ai/findings", terminalStatuses: ["completed", "rejected", "duplicate", "cancelled"], parentKinds: [] },
      { name: "task", idPrefix: "T", dataDir: ".operator/data/tasks", branchPrefix: "ai/tasks", terminalStatuses: ["completed", "rejected", "duplicate", "cancelled"], parentKinds: ["finding"] },
    ],
    get: vi.fn(),
    branchPrefixFor: vi.fn((kind) => kind === "finding" ? "ai/findings" : "ai/tasks"),
    dataDirFor: vi.fn((kind) => kind === "finding" ? ".operator/data/findings" : ".operator/data/tasks"),
    idPrefixFor: vi.fn((kind) => kind === "finding" ? "F" : "T"),
    isTerminal: vi.fn(() => false),
    generateId: vi.fn().mockResolvedValue("T20260511-0099"),
    terminalStatusesFor: vi.fn(() => []),
  } as unknown as KindRegistry;
}

function makeFakeSource(): WorkItemSource {
  return {
    create: vi.fn((rec: WorkItemRecord) => Promise.resolve(rec)),
    read: vi.fn(),
    updateStatus: vi.fn((_ref: WorkItemRef, _status: string, _reason?: string) => Promise.resolve({} as WorkItemRecord)),
    updateBody: vi.fn((_ref: WorkItemRef) => Promise.resolve({} as WorkItemRecord)),
    list: vi.fn(),
  } as unknown as WorkItemSource;
}

function makeFakeStream(events: AgentEventParseResult["events"], diagnostics: AgentEventParseResult["diagnostics"] = []): AgentEventStream {
  return {
    parse: vi.fn().mockReturnValue({ events, diagnostics }),
  } as unknown as AgentEventStream;
}

function makeDeps(overrides: Partial<PrFeedbackSupervisorHookDeps> = {}): PrFeedbackSupervisorHookDeps {
  const prManager = {
    markProcessing: vi.fn().mockResolvedValue(undefined),
    postBotComment: vi.fn().mockResolvedValue(undefined),
    markFailed: vi.fn().mockResolvedValue(undefined),
  };
  const git = {
    commitCount: vi.fn().mockResolvedValue(2),
    isClean: vi.fn().mockResolvedValue(true),
    headSha: vi.fn().mockResolvedValue("sha-pre"),
  };
  return {
    prManager: prManager as unknown as PrFeedbackSupervisorHookDeps["prManager"],
    git: git as unknown as PrFeedbackSupervisorHookDeps["git"],
    agentsConfig: {
      defaultProvider: "claude",
      providers: { claude: { command: "claude" } },
      agents: {
        supervisor: {
          provider: "claude",
          instructions: "agents/supervisor.md",
          timeout: 3600, model: "opus", review: true,
          tools: "Read,Edit,Write,Bash", maxBudget: 15.0, context: ["base"],
        },
      },
    } as unknown as AgentsFile,
    promptSource: { loadChain: vi.fn().mockResolvedValue("verifier criteria") } as unknown as PrFeedbackSupervisorHookDeps["promptSource"],
    defaults: {
      limits: { maxReviewAttempts: 20, maxCiRetryAttempts: 3 },
      review: { ignoredBotLogins: [] },
    } as unknown as PrFeedbackSupervisorHookDeps["defaults"],
    automationDir: "/tmp/.operator",
    workspacePath: "/tmp/ws",
    kindRegistry: makeTestRegistry(),
    workItemSource: makeFakeSource(),
    agentEventStream: makeFakeStream([]),
    log: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as PrFeedbackSupervisorHookDeps["log"],
    agentRole: "supervisor",
    verifierTopic: "supervisor",
    ...overrides,
  };
}

describe("supervisor stage-logic", () => {
  describe("buildSupervisorTask", () => {
    it("includes PR coordinates and feedback", () => {
      const task = buildSupervisorTask("task", "ai/tasks/T-0001", "user comment here", "");
      expect(task).toContain("ai/tasks/T-0001");
      expect(task).toContain("user comment here");
      expect(task).toContain("fix-in-place");
      expect(task).toContain("cancel");
      expect(task).toContain("retry-as-new");
    });

    it("includes CI context file path when supplied", () => {
      const task = buildSupervisorTask("task", "ai/tasks/T-0001", "fb", "", "/tmp/ci.md");
      expect(task).toContain("/tmp/ci.md");
      expect(task).toContain("CI Pipeline Context");
    });

    it("includes thread file path when supplied", () => {
      const task = buildSupervisorTask("task", "ai/tasks/T-0001", "fb", "/tmp/thread.md");
      expect(task).toContain("/tmp/thread.md");
      expect(task).toContain("Discussion History");
    });
  });

  describe("buildPrFeedbackSupervisorBeforeAgent", () => {
    it("transitions label to processing and returns processingPRs", async () => {
      const deps = makeDeps();
      const hook = buildPrFeedbackSupervisorBeforeAgent(deps);
      const result = await hook(
        makeStageDef(),
        makeStageInput(makePayload()),
        makeWorkspace("ai/tasks/T20260511-0001"),
        makeCtx(),
      );
      expect(deps.prManager.markProcessing).toHaveBeenCalledWith(842);
      expect(result).toEqual({ processingPRs: [842] });
    });

    it("skips markProcessing when attempt cap reached and returns void", async () => {
      const deps = makeDeps({
        git: {
          commitCount: vi.fn().mockResolvedValue(50),
          isClean: vi.fn().mockResolvedValue(true),
        } as unknown as PrFeedbackSupervisorHookDeps["git"],
      });
      const hook = buildPrFeedbackSupervisorBeforeAgent(deps);
      const result = await hook(
        makeStageDef(),
        makeStageInput(makePayload()),
        makeWorkspace("ai/tasks/T20260511-0001"),
        makeCtx(),
      );
      expect(deps.prManager.markProcessing).not.toHaveBeenCalled();
      expect(result).toBeUndefined();
    });
  });

  describe("buildPrFeedbackSupervisorSynthesizeAgentResult", () => {
    it("returns null when the review cap is not reached (agent runs normally)", async () => {
      const deps = makeDeps(); // commitCount=2, cap=20 → not reached
      const ctx = makeCtx();
      const input = makeStageInput(makePayload());
      await buildPrFeedbackSupervisorBeforeAgent(deps)(makeStageDef(), input, makeWorkspace("ai/tasks/T20260511-0001"), ctx);
      const synth = await buildPrFeedbackSupervisorSynthesizeAgentResult(deps)(
        makeStageDef(), input, makeWorkspace("ai/tasks/T20260511-0001"), ctx,
      );
      expect(synth).toBeNull();
    });

    it("short-circuits with a failed result when the review cap is reached (agent skipped)", async () => {
      // Regression: when the cap is genuinely reached the engine used to run a
      // full ~10-min supervisor Opus call and then discard it in afterAgent.
      // The cap must be enforced before the agent runs (PR #898).
      const deps = makeDeps({
        git: {
          commitCount: vi.fn().mockResolvedValue(50), // 50 - 2 (task initial) = 48 ≥ 20
          isClean: vi.fn().mockResolvedValue(true),
          headSha: vi.fn().mockResolvedValue("sha-pre"),
        } as unknown as PrFeedbackSupervisorHookDeps["git"],
      });
      const ctx = makeCtx();
      const input = makeStageInput(makePayload());
      await buildPrFeedbackSupervisorBeforeAgent(deps)(makeStageDef(), input, makeWorkspace("ai/tasks/T20260511-0001"), ctx);
      const synth = await buildPrFeedbackSupervisorSynthesizeAgentResult(deps)(
        makeStageDef(), input, makeWorkspace("ai/tasks/T20260511-0001"), ctx,
      );
      expect(synth).not.toBeNull();
      expect(synth?.verdict).toBe("failed");
      expect(synth?.attempts).toBe(0);
      expect(synth?.summary).toContain("review cycle limit reached");
    });
  });

  describe("buildPrFeedbackSupervisorBuildRunInput", () => {
    it("throws when scratch is missing (beforeAgent not run)", async () => {
      const deps = makeDeps();
      const hook = buildPrFeedbackSupervisorBuildRunInput(deps);
      await expect(
        hook(makeStageDef(), makeStageInput(makePayload()), makeCtx()),
      ).rejects.toThrow(/missing scratch/);
    });

    it("builds run input after beforeAgent ran", async () => {
      const deps = makeDeps();
      const ctx = makeCtx();
      const input = makeStageInput(makePayload());
      await buildPrFeedbackSupervisorBeforeAgent(deps)(makeStageDef(), input, makeWorkspace("ai/tasks/T20260511-0001"), ctx);
      const runInput = await buildPrFeedbackSupervisorBuildRunInput(deps)(makeStageDef(), input, ctx);
      expect(runInput.agentName).toBe("supervisor");
      expect(runInput.taskContent).toContain("rename foo to bar");
    });
  });

  describe("buildPrFeedbackSupervisorBuildPR", () => {
    it("returns title/body/commit with onSuccess in-review", async () => {
      const deps = makeDeps();
      const ctx = makeCtx();
      const input = makeStageInput(makePayload());
      await buildPrFeedbackSupervisorBeforeAgent(deps)(makeStageDef(), input, makeWorkspace("ai/tasks/T20260511-0001"), ctx);
      const pr = await buildPrFeedbackSupervisorBuildPR(deps)(makeStageDef(), input, ctx);
      expect(pr.onSuccess).toBe("in-review");
      expect(pr.title).toContain("842");
    });
  });

  describe("buildPrFeedbackSupervisorAfterAgent", () => {
    it("applies AOP records via applyAgentEvents and posts applied-feedback comment on approved + dirty workspace", async () => {
      const stream = makeFakeStream([
        { type: "verdict", value: "approved", summary: "Renamed foo to bar" } as never,
      ]);
      const deps = makeDeps({
        git: {
          commitCount: vi.fn().mockResolvedValue(2),
          isClean: vi.fn().mockResolvedValue(false),
        } as unknown as PrFeedbackSupervisorHookDeps["git"],
        agentEventStream: stream,
      });
      const ctx = makeCtx();
      const input = makeStageInput(makePayload());
      await buildPrFeedbackSupervisorBeforeAgent(deps)(makeStageDef(), input, makeWorkspace("ai/tasks/T20260511-0001"), ctx);
      const result = await buildPrFeedbackSupervisorAfterAgent(deps)(
        makeStageDef(), input,
        makeAgentResult("approved", "=== EMIT verdict ===\nvalue: approved\nsummary: ok\n=== END EMIT ==="),
        makeWorkspace("ai/tasks/T20260511-0001"), ctx,
      );
      expect(deps.prManager.postBotComment).toHaveBeenCalledWith(
        842,
        expect.stringContaining("Applied review feedback"),
        expect.any(Object),
      );
      expect(result).toBeUndefined();
    });

    it("posts no-changes comment on approved + clean workspace AND HEAD unchanged", async () => {
      const stream = makeFakeStream([
        { type: "verdict", value: "approved", summary: "no fix needed" } as never,
      ]);
      const deps = makeDeps({
        git: {
          commitCount: vi.fn().mockResolvedValue(2),
          isClean: vi.fn().mockResolvedValue(true),
          headSha: vi.fn().mockResolvedValue("sha-pre"),
        } as unknown as PrFeedbackSupervisorHookDeps["git"],
        agentEventStream: stream,
      });
      const ctx = makeCtx();
      const input = makeStageInput(makePayload());
      await buildPrFeedbackSupervisorBeforeAgent(deps)(makeStageDef(), input, makeWorkspace("ai/tasks/T20260511-0001"), ctx);
      await buildPrFeedbackSupervisorAfterAgent(deps)(
        makeStageDef(), input,
        makeAgentResult("approved", "approval text"),
        makeWorkspace("ai/tasks/T20260511-0001"), ctx,
      );
      expect(deps.prManager.postBotComment).toHaveBeenCalledWith(
        842,
        expect.stringContaining("No code changes"),
        expect.any(Object),
      );
    });

    // Regression for PR #892 (2026-05-21). On an "escalate" cycle the
    // supervisor returns verdict=approved with NO code changes (supervisor.md
    // maps escalate → approved + no status update) and a reasoning summary
    // that explicitly says it is escalating to a human. The engine used to
    // prepend a fixed "supervisor considered the feedback already addressed"
    // sentence, which flatly contradicted that reasoning. The no-changes
    // comment must state only the observable fact and let the agent's
    // reasoning carry the WHY — never assert an interpretation the engine
    // cannot verify.
    it("does not claim feedback was 'already addressed' on an escalate cycle (PR-892 regression)", async () => {
      const escalateReasoning = "## Decision: escalate\n\nMerge conflict is a work-item ID collision, not a code conflict — handing back to a human.";
      const stream = makeFakeStream([
        { type: "verdict", value: "approved", summary: escalateReasoning } as never,
      ]);
      const deps = makeDeps({
        git: {
          commitCount: vi.fn().mockResolvedValue(2),
          isClean: vi.fn().mockResolvedValue(true), // pristine workspace
          headSha: vi.fn().mockResolvedValue("sha-pre"), // HEAD unchanged
        } as unknown as PrFeedbackSupervisorHookDeps["git"],
        agentEventStream: stream,
      });
      const ctx = makeCtx();
      const input = makeStageInput(makePayload());
      await buildPrFeedbackSupervisorBeforeAgent(deps)(makeStageDef(), input, makeWorkspace("ai/tasks/T20260511-0001"), ctx);
      await buildPrFeedbackSupervisorAfterAgent(deps)(
        makeStageDef(), input,
        makeAgentResult("approved", "out", escalateReasoning),
        makeWorkspace("ai/tasks/T20260511-0001"), ctx,
      );
      // misleading interpretation must be gone …
      expect(deps.prManager.postBotComment).toHaveBeenCalledWith(
        842,
        expect.not.stringContaining("considered the feedback already addressed"),
        expect.any(Object),
      );
      // … neutral fact retained, and the agent's own reasoning carries the WHY
      expect(deps.prManager.postBotComment).toHaveBeenCalledWith(
        842,
        expect.stringContaining("No code changes"),
        expect.any(Object),
      );
      expect(deps.prManager.postBotComment).toHaveBeenCalledWith(
        842,
        expect.stringContaining("Decision: escalate"),
        expect.any(Object),
      );
    });

    // Regression for PR #887 (2026-05-20). The supervisor agent
    // edited Intelligence/rules/backend.md, ran `git commit` via Bash,
    // returned `verdict=approved` with a populated summary. The engine's
    // afterAgent saw a clean workspace (commit already absorbed the
    // dirty diff) and posted "No code changes — supervisor considered
    // the feedback already addressed" even though the commit was right
    // there in git log. Fix: capture HEAD SHA in beforeAgent, compare
    // in afterAgent — a HEAD advance means the agent committed.
    it("posts applied-feedback comment when HEAD advanced even though workspace is clean (PR-887 regression)", async () => {
      const headSha = vi.fn()
        .mockResolvedValueOnce("sha-pre")   // beforeAgent capture
        .mockResolvedValueOnce("sha-post"); // afterAgent comparison
      const stream = makeFakeStream([
        { type: "verdict", value: "approved", summary: "fixed the lint comment" } as never,
      ]);
      const deps = makeDeps({
        git: {
          commitCount: vi.fn().mockResolvedValue(2),
          isClean: vi.fn().mockResolvedValue(true), // agent already committed → tree clean
          headSha,
        } as unknown as PrFeedbackSupervisorHookDeps["git"],
        agentEventStream: stream,
      });
      const ctx = makeCtx();
      const input = makeStageInput(makePayload());
      await buildPrFeedbackSupervisorBeforeAgent(deps)(makeStageDef(), input, makeWorkspace("ai/tasks/T20260511-0001"), ctx);
      await buildPrFeedbackSupervisorAfterAgent(deps)(
        makeStageDef(), input,
        makeAgentResult("approved", "fix"),
        makeWorkspace("ai/tasks/T20260511-0001"), ctx,
      );
      expect(deps.prManager.postBotComment).toHaveBeenCalledWith(
        842,
        expect.stringContaining("Applied review feedback"),
        expect.any(Object),
      );
      expect(deps.prManager.postBotComment).not.toHaveBeenCalledWith(
        842,
        expect.stringContaining("No code changes"),
        expect.any(Object),
      );
    });

    it("posts applied-feedback comment when workspace is dirty regardless of HEAD (uncommitted diff path)", async () => {
      const stream = makeFakeStream([
        { type: "verdict", value: "approved", summary: "fix" } as never,
      ]);
      const deps = makeDeps({
        git: {
          commitCount: vi.fn().mockResolvedValue(2),
          isClean: vi.fn().mockResolvedValue(false), // uncommitted diff
          headSha: vi.fn().mockResolvedValue("sha-pre"), // HEAD same → must still trigger "applied"
        } as unknown as PrFeedbackSupervisorHookDeps["git"],
        agentEventStream: stream,
      });
      const ctx = makeCtx();
      const input = makeStageInput(makePayload());
      await buildPrFeedbackSupervisorBeforeAgent(deps)(makeStageDef(), input, makeWorkspace("ai/tasks/T20260511-0001"), ctx);
      await buildPrFeedbackSupervisorAfterAgent(deps)(
        makeStageDef(), input,
        makeAgentResult("approved", "fix"),
        makeWorkspace("ai/tasks/T20260511-0001"), ctx,
      );
      expect(deps.prManager.postBotComment).toHaveBeenCalledWith(
        842,
        expect.stringContaining("Applied review feedback"),
        expect.any(Object),
      );
    });

    it("trusts verifier on approved + CI failing — does NOT override (defense-in-depth removed 2026-05-13)", async () => {
      // Pre-2026-05-13: composer had a defense-in-depth check that flipped
      // verdict to failed when agent returned approved but observed CI was
      // failing. The check duplicated the verifier (which is the authority
      // on whether the supervisor's fix addresses CI) and second-guessed
      // it from a STALE observation captured at cycle start — BEFORE the
      // supervisor committed via Bash. The canonical failure case:
      // supervisor correctly fixed 47 backend tests + 14
      // Copilot comments, committed, pushed, returned approved; the
      // post-verifier check flipped to failed anyway because checks.headSha
      // was the pre-commit SHA. Per user guidance: trust verifier, if
      // wrong the next pr-feedback cycle catches it with fresh CI data.
      const stream = makeFakeStream([
        { type: "verdict", value: "approved", summary: "ok" } as never,
      ]);
      const deps = makeDeps({ agentEventStream: stream });
      const ctx = makeCtx();
      const failingPayload = makePayload({
        checks: { value: "failing", observedAt: "2026-05-11T10:00:00Z", headSha: "abc123", checks: [] },
      });
      const input = makeStageInput(failingPayload);
      await buildPrFeedbackSupervisorBeforeAgent(deps)(makeStageDef(), input, makeWorkspace("ai/tasks/T20260511-0001"), ctx);
      const result = await buildPrFeedbackSupervisorAfterAgent(deps)(
        makeStageDef(), input,
        makeAgentResult("approved", "ok"),
        makeWorkspace("ai/tasks/T20260511-0001"), ctx,
      );
      // Verifier-approved verdict is preserved — no override.
      expect(result?.verdictOverride).toBeUndefined();
    });

    it("emits verdictOverride when applier verdict is rejected (retry-as-new path)", async () => {
      const stream = makeFakeStream([
        { type: "child-item", kind: "task", parent: "self", title: "Spawned replacement", body: "...", priority: 3 } as never,
        { type: "status-update", target: "self", status: "rejected", reason: "user clarified scope" } as never,
        { type: "verdict", value: "rejected", summary: "retry-as-new spawned" } as never,
      ]);
      const source = makeFakeSource();
      const deps = makeDeps({
        agentEventStream: stream,
        workItemSource: source,
        git: {
          commitCount: vi.fn().mockResolvedValue(2),
          isClean: vi.fn().mockResolvedValue(true),
        } as unknown as PrFeedbackSupervisorHookDeps["git"],
      });
      const ctx = makeCtx();
      const input = makeStageInput(makePayload());
      await buildPrFeedbackSupervisorBeforeAgent(deps)(makeStageDef(), input, makeWorkspace("ai/tasks/T20260511-0001"), ctx);
      const result = await buildPrFeedbackSupervisorAfterAgent(deps)(
        makeStageDef(), input,
        makeAgentResult("approved", "..."),
        makeWorkspace("ai/tasks/T20260511-0001"), ctx,
      );
      expect(source.create).toHaveBeenCalled();
      expect(source.updateStatus).toHaveBeenCalledWith(
        expect.objectContaining({ id: "T20260511-0001" }),
        "rejected",
        "user clarified scope",
        expect.anything(),
      );
      expect(result?.verdictOverride).toBe("rejected");
    });

    it("emits verdictOverride=cancelled on /cancel decision", async () => {
      const stream = makeFakeStream([
        { type: "status-update", target: "self", status: "cancelled", reason: "user wrote /cancel" } as never,
        { type: "verdict", value: "cancelled", summary: "cancelled by user" } as never,
      ]);
      const source = makeFakeSource();
      const deps = makeDeps({
        agentEventStream: stream,
        workItemSource: source,
        git: {
          commitCount: vi.fn().mockResolvedValue(2),
          isClean: vi.fn().mockResolvedValue(true),
        } as unknown as PrFeedbackSupervisorHookDeps["git"],
      });
      const ctx = makeCtx();
      const input = makeStageInput(makePayload());
      await buildPrFeedbackSupervisorBeforeAgent(deps)(makeStageDef(), input, makeWorkspace("ai/tasks/T20260511-0001"), ctx);
      const result = await buildPrFeedbackSupervisorAfterAgent(deps)(
        makeStageDef(), input,
        makeAgentResult("approved", "..."),
        makeWorkspace("ai/tasks/T20260511-0001"), ctx,
      );
      expect(source.updateStatus).toHaveBeenCalledWith(
        expect.objectContaining({ id: "T20260511-0001" }),
        "cancelled",
        "user wrote /cancel",
        expect.anything(),
      );
      expect(result?.verdictOverride).toBe("cancelled");
    });

    it("overrides to failed and posts limit-reached comment when attempt cap exceeded", async () => {
      const deps = makeDeps({
        git: {
          commitCount: vi.fn().mockResolvedValue(50),
          isClean: vi.fn().mockResolvedValue(true),
        } as unknown as PrFeedbackSupervisorHookDeps["git"],
      });
      const ctx = makeCtx();
      const input = makeStageInput(makePayload());
      await buildPrFeedbackSupervisorBeforeAgent(deps)(makeStageDef(), input, makeWorkspace("ai/tasks/T20260511-0001"), ctx);
      const result = await buildPrFeedbackSupervisorAfterAgent(deps)(
        makeStageDef(), input,
        makeAgentResult("approved", "..."),
        makeWorkspace("ai/tasks/T20260511-0001"), ctx,
      );
      expect(result?.verdictOverride).toBe("failed");
      expect(deps.prManager.postBotComment).toHaveBeenCalledWith(
        842,
        expect.stringContaining("Review cycle limit reached"),
        expect.any(Object),
      );
    });

    it("throws when afterAgent runs without prior beforeAgent (missing scratch)", async () => {
      const deps = makeDeps();
      const ctx = makeCtx();
      await expect(
        buildPrFeedbackSupervisorAfterAgent(deps)(
          makeStageDef(),
          makeStageInput(makePayload()),
          makeAgentResult("approved", ""),
          makeWorkspace("ai/tasks/T20260511-0001"), ctx,
        ),
      ).rejects.toThrow(/missing scratch/);
    });

    it("falls back to no active item when branch does not match any registered kind", async () => {
      const stream = makeFakeStream([
        { type: "verdict", value: "approved", summary: "ok" } as never,
      ]);
      const deps = makeDeps({
        agentEventStream: stream,
        git: {
          commitCount: vi.fn().mockResolvedValue(2),
          isClean: vi.fn().mockResolvedValue(true),
        } as unknown as PrFeedbackSupervisorHookDeps["git"],
      });
      const ctx = makeCtx();
      const payload = makePayload({ branch: "ai/unknown/SOMETHING-0001" });
      const input = makeStageInput(payload);
      await buildPrFeedbackSupervisorBeforeAgent(deps)(makeStageDef(), input, makeWorkspace(payload.branch), ctx);
      // Should not throw; applier just receives no active workItem.
      await buildPrFeedbackSupervisorAfterAgent(deps)(
        makeStageDef(), input,
        makeAgentResult("approved", ""),
        makeWorkspace(payload.branch), ctx,
      );
      expect(deps.agentEventStream.parse).toHaveBeenCalled();
    });
  });
});
