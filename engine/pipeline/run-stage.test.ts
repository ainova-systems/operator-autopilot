import { describe, it, expect, vi } from "vitest";
import type { OperationContext, LockHandle, CodeReview } from "@operator/core";
import { runStage } from "./run-stage.js";
import type { RunStageDeps } from "./run-stage.js";
import type { StageDef, StageInput, AgentResult } from "./types.js";

function makeCtx(): OperationContext {
  return {
    traceId: "t",
    repoId: "sample",
    action: "test",
    budget: { limitUsd: undefined, spentUsd: 0, add: () => {}, isExceeded: () => false },
    signal: AbortSignal.timeout(10_000),
  };
}

function makeStageDef(overrides?: Partial<StageDef>): StageDef {
  return {
    name: "init",
    agent: "scout",
    selector: "bootstrap",
    merge: "gated",
    branchScope: "singleton",
    branchPrefix: "ai/init",
    schedule: "on-start",
    enabled: true,
    baseBranch: "develop",
    ...overrides,
  };
}

function makeLock(): LockHandle {
  return { key: "stage:init:sample", lockId: "l-1", acquiredAt: new Date().toISOString() };
}

type Deps = RunStageDeps;

function makeDeps(overrides?: Partial<Deps>): Deps {
  const agentResult: AgentResult = {
    verdict: "approved",
    output: "## Execution Summary\ndone",
    attempts: 1,
    summary: "done",
  };
  return {
    guard: {
      acquire: vi.fn().mockResolvedValue(makeLock()),
      release: vi.fn().mockResolvedValue(undefined),
      complete: vi.fn(),
    },
    workspace: {
      prepare: vi.fn().mockResolvedValue({
        branch: "ai/init",
        baseBranch: "develop",
        existedRemote: false,
      }),
    } as unknown as Deps["workspace"],
    persistOutput: {
      persist: vi.fn().mockResolvedValue({
        committed: true,
        sha: "abc123",
        prNumber: 773,
        prExisted: false,
      }),
    } as unknown as Deps["persistOutput"],
    selectors: {
      select: vi.fn().mockResolvedValue({ scopeKey: "init", reason: "missing-scaffold" } as StageInput),
    } as unknown as Deps["selectors"],
    agentInvocation: {
      invoke: vi.fn().mockResolvedValue(agentResult),
    },
    verdictRouter: {
      route: vi.fn().mockResolvedValue(undefined),
    },
    bus: { emit: vi.fn().mockResolvedValue(undefined) },
    vcs: { getCodeReviews: vi.fn().mockResolvedValue([] as CodeReview[]) } as unknown as Deps["vcs"],
    prManager: { markFailed: vi.fn().mockResolvedValue(undefined) } as unknown as Deps["prManager"],
    agentRuntime: {} as Deps["agentRuntime"],
    git: {
      resetToBase: vi.fn().mockResolvedValue(undefined),
    } as unknown as Deps["git"],
    workspacePath: "/tmp/ws",
    buildRunInput: vi.fn().mockResolvedValue({
      agentName: "scout",
      providerId: "claude",
      promptContext: { automationDir: "/tmp/.operator", contextFiles: [], instructionsTopic: "scout", vars: {} },
      model: "sonnet",
      timeoutMs: 60_000,
      maxRetries: 2,
      reviewEnabled: false,
      cwd: "/tmp",
    }),
    buildPR: vi.fn().mockResolvedValue({
      title: "[AI:Init] scaffold",
      body: "body",
      commitMessage: "Init scaffold",
    }),
    ...overrides,
  };
}

describe("runStage", () => {
  it("composes the 8 steps and returns completed on approved verdict", async () => {
    const deps = makeDeps();

    const result = await runStage(makeStageDef(), deps, makeCtx());

    expect(deps.guard.acquire).toHaveBeenCalledOnce();
    expect(deps.selectors.select).toHaveBeenCalledOnce();
    expect(deps.workspace.prepare).toHaveBeenCalledWith(
      { branch: "ai/init", baseBranch: "develop" },
      expect.anything(),
      expect.anything(),
      undefined,
    );
    expect(deps.agentInvocation.invoke).toHaveBeenCalledOnce();
    expect(deps.persistOutput.persist).toHaveBeenCalledOnce();
    expect(deps.verdictRouter.route).toHaveBeenCalledOnce();
    expect(deps.guard.release).toHaveBeenCalledOnce();
    expect(deps.git.resetToBase).toHaveBeenCalledWith("develop");

    expect(result).toEqual({
      status: "completed",
      verdict: "approved",
      prNumber: 773,
      branch: "ai/init",
    });
  });

  it("skips and returns skipped:locked when guard.acquire returns null", async () => {
    const deps = makeDeps({
      guard: {
        acquire: vi.fn().mockResolvedValue(null),
        release: vi.fn(),
        complete: vi.fn(),
      },
    });

    const result = await runStage(makeStageDef(), deps, makeCtx());

    expect(result).toEqual({ status: "skipped", reason: "locked" });
    expect(deps.selectors.select).not.toHaveBeenCalled();
    expect(deps.agentInvocation.invoke).not.toHaveBeenCalled();
    expect(deps.persistOutput.persist).not.toHaveBeenCalled();
  });

  it("skips and returns skipped:no-input when selector returns null", async () => {
    const deps = makeDeps({
      selectors: { select: vi.fn().mockResolvedValue(null) } as unknown as Deps["selectors"],
    });

    const result = await runStage(makeStageDef(), deps, makeCtx());

    expect(result).toEqual({ status: "skipped", reason: "no-input" });
    expect(deps.workspace.prepare).not.toHaveBeenCalled();
    expect(deps.agentInvocation.invoke).not.toHaveBeenCalled();
    expect(deps.guard.release).toHaveBeenCalledOnce();
    expect(deps.bus.emit).toHaveBeenCalledWith("stage.skipped", expect.anything());
  });

  it("returns failed status on non-approved verdict (failed/cancelled/rejected)", async () => {
    const deps = makeDeps({
      agentInvocation: {
        invoke: vi.fn().mockResolvedValue({
          verdict: "failed",
          output: "",
          attempts: 2,
          summary: "verifier terminal",
        } as AgentResult),
      },
    });

    const result = await runStage(makeStageDef(), deps, makeCtx());

    expect(result.status).toBe("failed");
    expect(result.verdict).toBe("failed");
    expect(deps.persistOutput.persist).toHaveBeenCalledWith(
      expect.anything(),      // stageDef
      expect.anything(),      // input
      expect.objectContaining({ verdict: "failed" }), // agentResult drives label transition
      expect.anything(),      // workspace
      expect.objectContaining({
        pr: expect.objectContaining({ draft: true }),
      }),
      expect.anything(),      // deps
      expect.anything(),      // ctx
    );
  });

  it("calls beforeAgent hook (if provided) after workspace prep but before agent invocation", async () => {
    const callOrder: string[] = [];
    const deps = makeDeps({
      workspace: {
        prepare: vi.fn().mockImplementation(async () => {
          callOrder.push("prepare");
          return { branch: "ai/init", baseBranch: "develop", existedRemote: false };
        }),
      } as unknown as Deps["workspace"],
      beforeAgent: vi.fn().mockImplementation(async () => {
        callOrder.push("beforeAgent");
      }),
      agentInvocation: {
        invoke: vi.fn().mockImplementation(async () => {
          callOrder.push("invoke");
          return { verdict: "approved", output: "", attempts: 1, summary: "" } as AgentResult;
        }),
      },
    });

    await runStage(makeStageDef(), deps, makeCtx());

    expect(callOrder).toEqual(["prepare", "beforeAgent", "invoke"]);
  });

  it("releases the lock and resets workspace even when agent invocation throws", async () => {
    const error = new Error("infra crash");
    const deps = makeDeps({
      agentInvocation: {
        invoke: vi.fn().mockRejectedValue(error),
      },
    });

    await expect(runStage(makeStageDef(), deps, makeCtx())).rejects.toBe(error);

    expect(deps.guard.release).toHaveBeenCalledOnce();
    expect(deps.git.resetToBase).toHaveBeenCalledWith("develop");
  });

  it("composes per-item branches as branchPrefix/scopeKey", async () => {
    const deps = makeDeps({
      selectors: {
        select: vi.fn().mockResolvedValue({ scopeKey: "T-0001" } as StageInput),
      } as unknown as Deps["selectors"],
    });

    await runStage(
      makeStageDef({ branchScope: "per-item", branchPrefix: "ai/tasks" }),
      deps,
      makeCtx(),
    );

    expect(deps.workspace.prepare).toHaveBeenCalledWith(
      { branch: "ai/tasks/T-0001", baseBranch: "develop" },
      expect.anything(),
      expect.anything(),
      undefined,
    );
  });

  it("composes pr-scoped branches from input.data.branch", async () => {
    const deps = makeDeps({
      selectors: {
        select: vi.fn().mockResolvedValue({
          scopeKey: "891",
          data: { branch: "ai/tasks/T-0001" },
        } as StageInput),
      } as unknown as Deps["selectors"],
    });

    await runStage(
      makeStageDef({ branchScope: "pr", branchPrefix: undefined }),
      deps,
      makeCtx(),
    );

    expect(deps.workspace.prepare).toHaveBeenCalledWith(
      { branch: "ai/tasks/T-0001", baseBranch: "develop" },
      expect.anything(),
      expect.anything(),
      undefined,
    );
  });

  it("throws when a pr-scoped stage's input lacks data.branch", async () => {
    const deps = makeDeps({
      selectors: {
        select: vi.fn().mockResolvedValue({ scopeKey: "891" } as StageInput),
      } as unknown as Deps["selectors"],
    });

    await expect(
      runStage(makeStageDef({ branchScope: "pr" }), deps, makeCtx()),
    ).rejects.toThrow(/data.branch/);
    expect(deps.guard.release).toHaveBeenCalledOnce();
  });

  it("uses synthesizeAgentResult when provided (research's per-analyzer path)", async () => {
    const synthesize = vi.fn().mockResolvedValue({
      verdict: "approved",
      output: "",
      attempts: 1,
      summary: "4 findings from 4 analyzers",
    } as AgentResult);
    const deps = makeDeps({
      synthesizeAgentResult: synthesize,
    });

    const result = await runStage(makeStageDef(), deps, makeCtx());

    expect(synthesize).toHaveBeenCalledOnce();
    expect(deps.agentInvocation.invoke).not.toHaveBeenCalled();
    expect(deps.buildRunInput).not.toHaveBeenCalled();
    expect(result.status).toBe("completed");
    expect(result.verdict).toBe("approved");
  });

  it("synthesizeAgentResult failed verdict → persist called with failed + draft PR", async () => {
    const deps = makeDeps({
      synthesizeAgentResult: vi.fn().mockResolvedValue({
        verdict: "failed",
        output: "",
        attempts: 1,
        summary: "all analyzers failed",
      } as AgentResult),
    });

    const result = await runStage(makeStageDef(), deps, makeCtx());

    expect(result.status).toBe("failed");
    expect(deps.persistOutput.persist).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ verdict: "failed" }),
      expect.anything(),
      expect.objectContaining({ pr: expect.objectContaining({ draft: true }) }),
      expect.anything(),
      expect.anything(),
    );
  });

  it("calls afterAgent hook when provided; hook-returned verdictOverride replaces agent verdict", async () => {
    const deps = makeDeps({
      afterAgent: vi.fn().mockResolvedValue({
        verdictOverride: "rejected",
        summaryOverride: "contract violation",
      }),
    });

    const result = await runStage(makeStageDef(), deps, makeCtx());

    expect(deps.afterAgent).toHaveBeenCalledOnce();
    expect(result.verdict).toBe("rejected");
    // 2026-05-13 semantics fix: rejected verdict maps to execution status
    // `completed` (agent correctly filtered a false positive — that's
    // success). `failed` is reserved for real orchestration errors.
    expect(result.status).toBe("completed");
    // Persist sees the overridden verdict.
    expect(deps.persistOutput.persist).toHaveBeenCalledWith(
      expect.anything(), expect.anything(),
      expect.objectContaining({ verdict: "rejected", summary: "contract violation" }),
      expect.anything(), expect.anything(), expect.anything(), expect.anything(),
    );
  });

  it("applies summaryOverride alone when no verdictOverride is provided", async () => {
    const deps = makeDeps({
      afterAgent: vi.fn().mockResolvedValue({ summaryOverride: "2 tasks created" }),
    });

    await runStage(makeStageDef(), deps, makeCtx());

    expect(deps.persistOutput.persist).toHaveBeenCalledWith(
      expect.anything(), expect.anything(),
      expect.objectContaining({ verdict: "approved", summary: "2 tasks created" }),
      expect.anything(), expect.anything(), expect.anything(), expect.anything(),
    );
  });

  it("buildPR receives ctx (Step 11 signature extension)", async () => {
    const buildPR = vi.fn().mockResolvedValue({
      title: "T",
      body: "B",
      commitMessage: "M",
    });
    const deps = makeDeps({ buildPR });

    await runStage(makeStageDef(), deps, makeCtx());

    expect(buildPR).toHaveBeenCalledWith(
      expect.anything(), // stageDef
      expect.anything(), // input
      expect.objectContaining({ traceId: "t", repoId: "sample" }), // ctx
    );
  });

  // ── Label safety-net (PR #754/#779 incident fix, preventive) ──────

  it("safety-net: flips processingPRs to ai:failed when agent throws after markProcessing", async () => {
    const markFailed = vi.fn().mockResolvedValue(undefined);
    const deps = makeDeps({
      prManager: { markFailed } as unknown as RunStageDeps["prManager"],
      beforeAgent: vi.fn().mockResolvedValue({ processingPRs: [754, 779] }),
      agentInvocation: {
        invoke: vi.fn().mockRejectedValue(new Error("agent crashed")),
      },
    });

    await expect(runStage(makeStageDef(), deps, makeCtx())).rejects.toThrow("agent crashed");
    expect(markFailed).toHaveBeenCalledTimes(2);
    expect(markFailed).toHaveBeenCalledWith(754);
    expect(markFailed).toHaveBeenCalledWith(779);
  });

  it("safety-net: does NOT fire when persist completed successfully (verdict=approved)", async () => {
    const markFailed = vi.fn().mockResolvedValue(undefined);
    const deps = makeDeps({
      prManager: { markFailed } as unknown as RunStageDeps["prManager"],
      beforeAgent: vi.fn().mockResolvedValue({ processingPRs: [771] }),
    });

    await runStage(makeStageDef(), deps, makeCtx());
    // persist's own markCompleted handled the terminal transition; runStage
    // safety-net must not duplicate / override it.
    expect(markFailed).not.toHaveBeenCalled();
  });

  it("safety-net: no-op when beforeAgent returns no processingPRs", async () => {
    const markFailed = vi.fn().mockResolvedValue(undefined);
    const deps = makeDeps({
      prManager: { markFailed } as unknown as RunStageDeps["prManager"],
      beforeAgent: vi.fn().mockResolvedValue(undefined),
      agentInvocation: {
        invoke: vi.fn().mockRejectedValue(new Error("agent crashed")),
      },
    });

    await expect(runStage(makeStageDef(), deps, makeCtx())).rejects.toThrow("agent crashed");
    expect(markFailed).not.toHaveBeenCalled();
  });

  it("safety-net: markFailed failure is logged as ERROR but does not mask the original exception", async () => {
    const markFailed = vi.fn().mockRejectedValue(new Error("github 500"));
    const deps = makeDeps({
      prManager: { markFailed } as unknown as RunStageDeps["prManager"],
      beforeAgent: vi.fn().mockResolvedValue({ processingPRs: [779] }),
      agentInvocation: {
        invoke: vi.fn().mockRejectedValue(new Error("agent crashed")),
      },
    });

    await expect(runStage(makeStageDef(), deps, makeCtx())).rejects.toThrow("agent crashed");
    expect(markFailed).toHaveBeenCalledWith(779);
  });
});
