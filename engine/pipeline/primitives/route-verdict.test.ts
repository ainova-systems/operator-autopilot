import { describe, it, expect, vi } from "vitest";
import type { OperationContext } from "@operator/core";
import { STAGE_COMPLETED, STAGE_SKIPPED, PIPELINE_FAILED } from "../../events/types.js";
import { FileVerdictRouter, emitSkipped } from "./route-verdict.js";
import type { StageDef, AgentResult, StageInput } from "../types.js";
import type { PersistOutputResult } from "./persist-output.js";

function makeCtx(): OperationContext {
  return {
    traceId: "trace-1",
    repoId: "sample",
    action: "test",
    budget: { limitUsd: undefined, spentUsd: 0, add: () => {}, isExceeded: () => false },
    signal: AbortSignal.timeout(10_000),
  };
}

function makeStageDef(): StageDef {
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
  };
}

function makeInput(): StageInput {
  return { scopeKey: "init", reason: "missing-scaffold" };
}

function makeAgentResult(overrides?: Partial<AgentResult>): AgentResult {
  return {
    verdict: "approved",
    output: "",
    attempts: 1,
    summary: "scaffold created",
    ...overrides,
  };
}

function makePersistResult(overrides?: Partial<PersistOutputResult>): PersistOutputResult {
  return {
    committed: true,
    sha: "sha123",
    prNumber: 773,
    prExisted: false,
    ...overrides,
  };
}

describe("FileVerdictRouter.route", () => {
  it("emits STAGE_COMPLETED on approved verdict with summary + prNumber", async () => {
    const bus = { emit: vi.fn().mockResolvedValue(undefined) };
    const router = new FileVerdictRouter();

    await router.route(
      {
        stageDef: makeStageDef(),
        stageInput: makeInput(),
        agentResult: makeAgentResult(),
        persistResult: makePersistResult(),
      },
      { bus },
      makeCtx(),
    );

    expect(bus.emit).toHaveBeenCalledOnce();
    expect(bus.emit).toHaveBeenCalledWith(STAGE_COMPLETED, expect.objectContaining({
      traceId: "trace-1",
      projectId: "sample",
      data: expect.objectContaining({
        stage: "init",
        scopeKey: "init",
        verdict: "approved",
        prNumber: 773,
        committed: true,
        summary: "scaffold created",
      }),
    }));
  });

  it("emits PIPELINE_FAILED on verdict = failed", async () => {
    const bus = { emit: vi.fn().mockResolvedValue(undefined) };
    const router = new FileVerdictRouter();

    await router.route(
      {
        stageDef: makeStageDef(),
        stageInput: makeInput(),
        agentResult: makeAgentResult({ verdict: "failed", summary: "verifier terminal" }),
        persistResult: null,
      },
      { bus },
      makeCtx(),
    );

    expect(bus.emit).toHaveBeenCalledWith(PIPELINE_FAILED, expect.objectContaining({
      data: expect.objectContaining({ verdict: "failed", committed: false }),
    }));
  });

  it("emits PIPELINE_FAILED on verdict = cancelled", async () => {
    const bus = { emit: vi.fn().mockResolvedValue(undefined) };
    const router = new FileVerdictRouter();

    await router.route(
      {
        stageDef: makeStageDef(),
        stageInput: makeInput(),
        agentResult: makeAgentResult({ verdict: "cancelled" }),
        persistResult: null,
      },
      { bus },
      makeCtx(),
    );

    expect(bus.emit).toHaveBeenCalledWith(PIPELINE_FAILED, expect.anything());
  });

  it("emits STAGE_COMPLETED on verdict = rejected (rejection is a successful agent outcome, NOT a failure)", async () => {
    // 2026-05-13 semantics fix: rejected was previously bucketed as
    // PIPELINE_FAILED because route-verdict's isTerminalFailure included
    // rejected alongside failed + cancelled. That mapping was wrong —
    // when planner emits EMIT verdict: rejected it means "I correctly
    // identified this finding as a false positive / obsolete / invalid"
    // which is the agent doing its job successfully. PIPELINE_FAILED
    // should fire only for actual orchestration errors (verdict=failed)
    // or user-aborted cycles (verdict=cancelled).
    const bus = { emit: vi.fn().mockResolvedValue(undefined) };
    const router = new FileVerdictRouter();

    await router.route(
      {
        stageDef: makeStageDef(),
        stageInput: makeInput(),
        agentResult: makeAgentResult({ verdict: "rejected" }),
        persistResult: null,
      },
      { bus },
      makeCtx(),
    );

    expect(bus.emit).toHaveBeenCalledWith(STAGE_COMPLETED, expect.objectContaining({
      data: expect.objectContaining({ verdict: "rejected" }),
    }));
    expect(bus.emit).not.toHaveBeenCalledWith(PIPELINE_FAILED, expect.anything());
  });

  it("omits persist-result fields when persist was skipped (null)", async () => {
    const bus = { emit: vi.fn().mockResolvedValue(undefined) };
    const router = new FileVerdictRouter();

    await router.route(
      {
        stageDef: makeStageDef(),
        stageInput: makeInput(),
        agentResult: makeAgentResult(),
        persistResult: null,
      },
      { bus },
      makeCtx(),
    );

    expect(bus.emit).toHaveBeenCalledWith(STAGE_COMPLETED, expect.objectContaining({
      data: expect.objectContaining({ prNumber: null, committed: false }),
    }));
  });
});

describe("emitSkipped", () => {
  it("emits STAGE_SKIPPED with reason", async () => {
    const bus = { emit: vi.fn().mockResolvedValue(undefined) };

    await emitSkipped(makeStageDef(), "Already initialized", { bus }, makeCtx());

    expect(bus.emit).toHaveBeenCalledWith(STAGE_SKIPPED, expect.objectContaining({
      data: { stage: "init", reason: "Already initialized" },
    }));
  });
});

describe("FileVerdictRouter.route — execution-verdict observation (Step 14)", () => {
  it("writes executionVerdict observation + reconciles when kv + workItemId + executionId are set", async () => {
    const bus = { emit: vi.fn().mockResolvedValue(undefined) };
    const store = new Map<string, unknown>();
    store.set("work-items/T1", {
      id: "T1",
      status: "in-progress",
      statusSources: {
        developFile: { value: "pending", observedAt: "2026-04-01T00:00:00Z" },
      },
    });
    const kv = {
      get: vi.fn(async (cat: string, key: string) =>
        store.has(`${cat}/${key}`) ? { key, value: store.get(`${cat}/${key}`) } : null,
      ),
      put: vi.fn(async (cat: string, key: string, value: unknown) => {
        store.set(`${cat}/${key}`, value);
      }),
      delete: vi.fn(), list: vi.fn(), close: vi.fn(),
    };
    const router = new FileVerdictRouter();

    await router.route(
      {
        stageDef: { ...makeStageDef(), name: "task-execute" },
        stageInput: makeInput(),
        agentResult: makeAgentResult({ verdict: "approved" }),
        persistResult: makePersistResult(),
        workItemId: "T1",
        executionId: "e-42",
      },
      { bus, kv: kv as never },
      makeCtx(),
    );

    const written = store.get("work-items/T1") as {
      statusSources: { executionVerdict: { executionId: string; value: string } };
      status: string;
      statusReason: string;
      hasDrift: boolean;
    };
    expect(written.statusSources.executionVerdict.executionId).toBe("e-42");
    expect(written.statusSources.executionVerdict.value).toBe("approved");
    // Post-inversion: top-level `status` holds the computed value (was
    // `effectiveStatus` pre-rename); `statusReason` replaces the old
    // `effectiveStatusReason`.
    expect(written.status).toBe("completed");
    expect(written.statusReason).toBe("execution-verdict");
    expect(written.hasDrift).toBe(true); // develop=pending vs verdict=approved
  });

  it("no-ops when kv is absent", async () => {
    const bus = { emit: vi.fn().mockResolvedValue(undefined) };
    const router = new FileVerdictRouter();
    await router.route(
      {
        stageDef: makeStageDef(), stageInput: makeInput(),
        agentResult: makeAgentResult(), persistResult: makePersistResult(),
        workItemId: "T1", executionId: "e",
      },
      { bus },
      makeCtx(),
    );
    // bus still fires
    expect(bus.emit).toHaveBeenCalled();
  });

  it("does NOT increment attemptCount on verdict = rejected (rejection is success, not failure)", async () => {
    // 2026-05-13 semantics fix: rejected used to bump attemptCount which
    // was the safety-net for runaway re-selection of broken items. But
    // rejected means "agent correctly filtered a false positive" — the
    // selector should skip this item via the terminal-status filter
    // (PR-on-PR loop fix landed in the same revision), not via the
    // attempt cap. attemptCount stays reserved for real failures so the
    // cap is meaningful (item retried twice and never worked).
    const bus = { emit: vi.fn().mockResolvedValue(undefined) };
    const store = new Map<string, unknown>();
    store.set("work-items/F1", {
      id: "F1",
      status: "pending",
      attemptCount: 0,
      statusSources: { developFile: { value: "pending", observedAt: "2026-05-08T00:00:00Z" } },
    });
    const kv = {
      get: vi.fn(async (cat: string, key: string) =>
        store.has(`${cat}/${key}`) ? { key, value: store.get(`${cat}/${key}`) } : null,
      ),
      put: vi.fn(async (cat: string, key: string, value: unknown) => {
        store.set(`${cat}/${key}`, value);
      }),
      delete: vi.fn(), list: vi.fn(), close: vi.fn(),
    };
    const router = new FileVerdictRouter();

    await router.route(
      {
        stageDef: { ...makeStageDef(), name: "finding-plan" },
        stageInput: makeInput(),
        agentResult: makeAgentResult({ verdict: "rejected", summary: "INVALID" }),
        persistResult: makePersistResult(),
        workItemId: "F1",
        executionId: "e-rej-1",
      },
      { bus, kv: kv as never },
      makeCtx(),
    );

    const written = store.get("work-items/F1") as { attemptCount: number };
    expect(written.attemptCount).toBe(0);
  });

  it("increments attemptCount on failed verdict and again on second failure", async () => {
    const bus = { emit: vi.fn().mockResolvedValue(undefined) };
    const store = new Map<string, unknown>();
    store.set("work-items/T1", {
      id: "T1",
      status: "in-progress",
      attemptCount: 1,
      statusSources: { developFile: { value: "pending", observedAt: "2026-05-08T00:00:00Z" } },
    });
    const kv = {
      get: vi.fn(async (cat: string, key: string) =>
        store.has(`${cat}/${key}`) ? { key, value: store.get(`${cat}/${key}`) } : null,
      ),
      put: vi.fn(async (cat: string, key: string, value: unknown) => {
        store.set(`${cat}/${key}`, value);
      }),
      delete: vi.fn(), list: vi.fn(), close: vi.fn(),
    };
    const router = new FileVerdictRouter();

    await router.route(
      {
        stageDef: { ...makeStageDef(), name: "task-execute" },
        stageInput: makeInput(),
        agentResult: makeAgentResult({ verdict: "failed", summary: "verify error" }),
        persistResult: makePersistResult(),
        workItemId: "T1",
        executionId: "e-fail-2",
      },
      { bus, kv: kv as never },
      makeCtx(),
    );

    const written = store.get("work-items/T1") as { attemptCount: number };
    expect(written.attemptCount).toBe(2);
  });

  it("leaves attemptCount unchanged on approved verdict", async () => {
    const bus = { emit: vi.fn().mockResolvedValue(undefined) };
    const store = new Map<string, unknown>();
    store.set("work-items/T2", {
      id: "T2",
      status: "in-progress",
      attemptCount: 1,
      statusSources: { developFile: { value: "pending", observedAt: "2026-05-08T00:00:00Z" } },
    });
    const kv = {
      get: vi.fn(async (cat: string, key: string) =>
        store.has(`${cat}/${key}`) ? { key, value: store.get(`${cat}/${key}`) } : null,
      ),
      put: vi.fn(async (cat: string, key: string, value: unknown) => {
        store.set(`${cat}/${key}`, value);
      }),
      delete: vi.fn(), list: vi.fn(), close: vi.fn(),
    };
    const router = new FileVerdictRouter();

    await router.route(
      {
        stageDef: { ...makeStageDef(), name: "task-execute" },
        stageInput: makeInput(),
        agentResult: makeAgentResult({ verdict: "approved" }),
        persistResult: makePersistResult(),
        workItemId: "T2",
        executionId: "e-ok-1",
      },
      { bus, kv: kv as never },
      makeCtx(),
    );

    const written = store.get("work-items/T2") as { attemptCount: number };
    expect(written.attemptCount).toBe(1);
  });

  it("treats missing prior attemptCount as 0 and seeds to 1 on first failure", async () => {
    const bus = { emit: vi.fn().mockResolvedValue(undefined) };
    const store = new Map<string, unknown>();
    store.set("work-items/F-NEW", {
      id: "F-NEW",
      status: "pending",
      // no attemptCount field — legacy row pre-A2 migration
      statusSources: { developFile: { value: "pending", observedAt: "2026-05-08T00:00:00Z" } },
    });
    const kv = {
      get: vi.fn(async (cat: string, key: string) =>
        store.has(`${cat}/${key}`) ? { key, value: store.get(`${cat}/${key}`) } : null,
      ),
      put: vi.fn(async (cat: string, key: string, value: unknown) => {
        store.set(`${cat}/${key}`, value);
      }),
      delete: vi.fn(), list: vi.fn(), close: vi.fn(),
    };
    const router = new FileVerdictRouter();

    await router.route(
      {
        stageDef: { ...makeStageDef(), name: "finding-plan" },
        stageInput: makeInput(),
        agentResult: makeAgentResult({ verdict: "cancelled", summary: "user cancelled" }),
        persistResult: makePersistResult(),
        workItemId: "F-NEW",
        executionId: "e-can-1",
      },
      { bus, kv: kv as never },
      makeCtx(),
    );

    const written = store.get("work-items/F-NEW") as { attemptCount: number };
    expect(written.attemptCount).toBe(1);
  });

  it("no-ops when workItemId is missing (non-per-item stage)", async () => {
    const bus = { emit: vi.fn().mockResolvedValue(undefined) };
    const kv = { get: vi.fn(), put: vi.fn(), delete: vi.fn(), list: vi.fn(), close: vi.fn() };
    const router = new FileVerdictRouter();
    await router.route(
      {
        stageDef: makeStageDef(), stageInput: makeInput(),
        agentResult: makeAgentResult(), persistResult: makePersistResult(),
      },
      { bus, kv: kv as never },
      makeCtx(),
    );
    expect(kv.put).not.toHaveBeenCalled();
  });
});
