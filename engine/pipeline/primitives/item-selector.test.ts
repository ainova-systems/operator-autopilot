import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OperationContext, CodeReview, StateManager, WorkItem } from "@operator/core";
import {
  bootstrapSelect,
  perItemSelect,
  ItemSelectorRegistry,
  createDefaultSelectorRegistry,
} from "./item-selector.js";
import type { StageDef } from "../types.js";

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
    selectorConfig: {},
    merge: "gated",
    branchScope: "singleton",
    branchPrefix: "ai/init",
    schedule: "on-start",
    review: false,
    enabled: true,
    baseBranch: "develop",
    ...overrides,
  };
}

function makePR(id: number, branch: string, closed = false, labelNames: string[] = []): CodeReview {
  return {
    id,
    title: "",
    url: "",
    branch,
    baseBranch: "develop",
    labels: labelNames.map((name) => ({ name })),
    comments: [],
    draft: false,
    merged: false,
    closed,
  };
}

describe("bootstrapSelect", () => {
  let workspacePath: string;

  beforeEach(async () => {
    workspacePath = await mkdtemp(join(tmpdir(), "op-bootstrap-"));
  });

  afterEach(async () => {
    await rm(workspacePath, { recursive: true, force: true });
  });

  it("returns null when .operator/project.yaml exists on the workspace branch", async () => {
    await mkdir(join(workspacePath, ".operator"), { recursive: true });
    await writeFile(join(workspacePath, ".operator", "project.yaml"), "scripts: {}");
    const vcs = { getCodeReviews: vi.fn().mockResolvedValue([]) };

    const result = await bootstrapSelect(makeStageDef(), { vcs, workspacePath }, makeCtx());

    expect(result).toBeNull();
    // File-check short-circuits before the VCS call.
    expect(vcs.getCodeReviews).not.toHaveBeenCalled();
  });

  it("returns null when an open init PR already exists", async () => {
    // No .operator/project.yaml on disk — file check fails.
    const vcs = {
      getCodeReviews: vi.fn<() => Promise<CodeReview[]>>().mockResolvedValue([
        makePR(773, "ai/init", false),
      ]),
    };

    const result = await bootstrapSelect(makeStageDef(), { vcs, workspacePath }, makeCtx());

    expect(result).toBeNull();
    expect(vcs.getCodeReviews).toHaveBeenCalledOnce();
  });

  it("ignores closed init PRs", async () => {
    const vcs = {
      getCodeReviews: vi.fn<() => Promise<CodeReview[]>>().mockResolvedValue([
        makePR(100, "ai/init", true),
      ]),
    };

    const result = await bootstrapSelect(makeStageDef(), { vcs, workspacePath }, makeCtx());

    expect(result).toEqual({ scopeKey: "init", reason: "missing-scaffold" });
  });

  it("returns proceed-input when neither file nor open PR exists", async () => {
    const vcs = { getCodeReviews: vi.fn().mockResolvedValue([]) };

    const result = await bootstrapSelect(makeStageDef(), { vcs, workspacePath }, makeCtx());

    expect(result).toEqual({ scopeKey: "init", reason: "missing-scaffold" });
  });

  it("honors custom requiredFile from selectorConfig", async () => {
    await mkdir(join(workspacePath, "custom"), { recursive: true });
    await writeFile(join(workspacePath, "custom", "sentinel"), "");
    const vcs = { getCodeReviews: vi.fn() };

    const result = await bootstrapSelect(
      makeStageDef({ selectorConfig: { requiredFile: "custom/sentinel" } }),
      { vcs, workspacePath },
      makeCtx(),
    );

    expect(result).toBeNull();
    expect(vcs.getCodeReviews).not.toHaveBeenCalled();
  });

  it("throws when branchPrefix is missing", async () => {
    const vcs = { getCodeReviews: vi.fn().mockResolvedValue([]) };

    await expect(
      bootstrapSelect(
        makeStageDef({ branchPrefix: undefined }),
        { vcs, workspacePath },
        makeCtx(),
      ),
    ).rejects.toThrow(/branchPrefix/);
  });
});

describe("ItemSelectorRegistry", () => {
  it("routes to the registered strategy by name", async () => {
    const registry = new ItemSelectorRegistry();
    const fn = vi.fn().mockResolvedValue({ scopeKey: "x" });
    registry.register("test", fn);

    const result = await registry.select(
      makeStageDef({ selector: "test" as unknown as StageDef["selector"] }),
      { vcs: { getCodeReviews: vi.fn() }, workspacePath: "/tmp" },
      makeCtx(),
    );

    expect(result).toEqual({ scopeKey: "x" });
    expect(fn).toHaveBeenCalledOnce();
  });

  it("throws on unknown strategy", async () => {
    const registry = new ItemSelectorRegistry();

    await expect(
      registry.select(
        makeStageDef({ selector: "ghost" as unknown as StageDef["selector"] }),
        { vcs: { getCodeReviews: vi.fn() }, workspacePath: "/tmp" },
        makeCtx(),
      ),
    ).rejects.toThrow(/Unknown selector strategy/);
  });

  it("throws on duplicate registration (catches misconfig early)", () => {
    const registry = new ItemSelectorRegistry();
    const fn = vi.fn();
    registry.register("x", fn);

    expect(() => registry.register("x", fn)).toThrow(/already registered/);
  });
});

describe("createDefaultSelectorRegistry", () => {
  it("returns a registry wired with the Step 8b bootstrap strategy", async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), "op-default-"));
    try {
      const registry = createDefaultSelectorRegistry();
      const vcs = { getCodeReviews: vi.fn().mockResolvedValue([]) };

      const result = await registry.select(makeStageDef(), { vcs, workspacePath }, makeCtx());

      expect(result).toEqual({ scopeKey: "init", reason: "missing-scaffold" });
    } finally {
      await rm(workspacePath, { recursive: true, force: true });
    }
  });

  it("registers per-item strategy (Step 9)", async () => {
    const registry = createDefaultSelectorRegistry();
    const state = makeStateWithItems([]);
    const vcs = { getCodeReviews: vi.fn().mockResolvedValue([]) };

    const result = await registry.select(
      makePerItemStageDef({ selector: "per-item" }),
      { vcs, workspacePath: "/tmp", state, conventions: undefined },
      makeCtx(),
    );

    expect(result).toBeNull();
    expect(state.listWorkItems).toHaveBeenCalled();
  });

  it("registers pr-feedback strategy (Step 10)", async () => {
    const registry = createDefaultSelectorRegistry();
    const vcs = {
      getCodeReviews: vi.fn<() => Promise<CodeReview[]>>().mockResolvedValue([]),
      getComments: vi.fn().mockResolvedValue([]),
      getReviewComments: vi.fn().mockResolvedValue([]),
    };

    const prReviewDef: StageDef = {
      name: "pr-review",
      agent: "creator",
      selector: "pr-feedback",
      selectorConfig: { branchPrefixes: ["ai/tasks"], commentMarker: "<!-- bot:operator -->" },
      merge: "gated",
      branchScope: "pr",
      schedule: "*/5 * * * *",
      review: true,
      enabled: true,
      baseBranch: "develop",
    };
    const result = await registry.select(
      prReviewDef,
      { vcs, workspacePath: "/tmp" },
      makeCtx(),
    );

    expect(result).toBeNull();
    expect(vcs.getCodeReviews).toHaveBeenCalled();
  });

  it("registers discovery strategy (Step 11)", async () => {
    const registry = createDefaultSelectorRegistry();
    const vcs = {
      getCodeReviews: vi.fn<() => Promise<CodeReview[]>>().mockResolvedValue([]),
    };

    const researchDef: StageDef = {
      name: "research",
      agent: "analyst",
      selector: "discovery",
      selectorConfig: { discoveryDir: ".operator/analyst" },
      merge: "gated",
      branchScope: "per-item",
      branchPrefix: "ai/research",
      schedule: "0 8 * * *",
      review: false,
      enabled: true,
      baseBranch: "develop",
    };
    // Workspace does not exist → discovery returns null (skip reason:
    // "no-analyzer-dir"), which confirms the strategy is registered.
    const result = await registry.select(
      researchDef,
      { vcs, workspacePath: "/tmp/definitely-missing" },
      makeCtx(),
    );
    expect(result).toBeNull();
  });

  it("registers singleton strategy (Step 12)", async () => {
    const registry = createDefaultSelectorRegistry();
    const vcs = {
      getCodeReviews: vi.fn<() => Promise<CodeReview[]>>().mockResolvedValue([]),
    };

    const retrospectiveDef: StageDef = {
      name: "retrospective",
      agent: "improver",
      selector: "singleton",
      selectorConfig: { scopeKind: "week" },
      merge: "gated",
      branchScope: "per-item",
      branchPrefix: "ai/retrospective",
      schedule: "0 9 * * 1",
      review: true,
      enabled: true,
      baseBranch: "develop",
    };
    const result = await registry.select(
      retrospectiveDef,
      { vcs, workspacePath: "/tmp" },
      makeCtx(),
    );
    expect(result).not.toBeNull();
    expect(result?.scopeKey).toMatch(/^\d{4}W\d{2}$/);
  });
});

// ── per-item selector tests (Step 9) ──────────────────────────────────

function makeWorkItem(overrides?: Partial<WorkItem>): WorkItem {
  return {
    id: "F20260416-0001",
    type: "finding",
    title: "sample",
    body: "body",
    status: "pending",
    priority: 3,
    createdAt: "2026-04-16T10:00:00Z",
    updatedAt: "2026-04-16T10:00:00Z",
    ...overrides,
  };
}

function makeStateWithItems(items: WorkItem[]): StateManager {
  return {
    listWorkItems: vi.fn().mockResolvedValue(items),
    upsertWorkItem: vi.fn(), getWorkItem: vi.fn(), updateWorkItemStatus: vi.fn(),
    appendExecution: vi.fn(), listExecutions: vi.fn(),
    saveOutcome: vi.fn(), listOutcomes: vi.fn(),
    isScheduleDue: vi.fn(), markScheduleRun: vi.fn(),
    isKnownItem: vi.fn(), markKnownItem: vi.fn(), close: vi.fn(),
  };
}

function makePerItemStageDef(overrides?: Partial<StageDef>): StageDef {
  return {
    name: "finding-plan",
    agent: "planner",
    selector: "per-item",
    selectorConfig: { kind: "finding", status: "pending" },
    merge: "gated",
    branchScope: "per-item",
    branchPrefix: "ai/findings",
    maxActive: 2,
    schedule: "*/5 * * * *",
    review: true,
    enabled: true,
    baseBranch: "develop",
    ...overrides,
  };
}

describe("perItemSelect", () => {
  it("returns null when state has no items", async () => {
    const state = makeStateWithItems([]);
    const vcs = { getCodeReviews: vi.fn().mockResolvedValue([]) };

    const result = await perItemSelect(
      makePerItemStageDef(),
      { vcs, workspacePath: "/tmp", state },
      makeCtx(),
    );

    expect(result).toBeNull();
    expect(vcs.getCodeReviews).not.toHaveBeenCalled();
  });

  it("returns null when all state items are non-pending", async () => {
    const state = makeStateWithItems([
      makeWorkItem({ id: "F-1", status: "completed" }),
      makeWorkItem({ id: "F-2", status: "in-progress" }),
    ]);
    const vcs = { getCodeReviews: vi.fn().mockResolvedValue([]) };

    const result = await perItemSelect(
      makePerItemStageDef(),
      { vcs, workspacePath: "/tmp", state },
      makeCtx(),
    );

    expect(result).toBeNull();
  });

  it("returns null when capacity is at maxActive (actively-worked PRs)", async () => {
    const conventions = {
      labels: { pending: "ai:pending", processing: "ai:processing", inReview: "ai:in-review", readyToMerge: "ai:ready-to-merge", failed: "ai:failed" },
      branches: { aiPrefix: "ai", init: "ai/init", tasks: "ai/tasks", findings: "ai/findings", research: "ai/research", retrospective: "ai/retrospective" },
      prPrefixes: { task: "", finding: "", research: "", improver: "", init: "" },
      patterns: { taskId: "", findingPrefix: "F" },
      commentMarker: "",
    };
    const state = makeStateWithItems([makeWorkItem({ id: "F-1" })]);
    const vcs = {
      getCodeReviews: vi.fn().mockResolvedValue([
        makePR(100, "ai/findings/F-100", false, ["ai:processing"]),
        makePR(101, "ai/findings/F-101", false, ["ai:in-review"]),
      ]),
    };

    const result = await perItemSelect(
      makePerItemStageDef({ maxActive: 2 }),
      { vcs, workspacePath: "/tmp", state, conventions },
      makeCtx(),
    );

    expect(result).toBeNull();
  });

  it("picks highest-priority pending item (lower number wins)", async () => {
    const state = makeStateWithItems([
      makeWorkItem({ id: "F-1", priority: 5 }),
      makeWorkItem({ id: "F-2", priority: 2 }),
      makeWorkItem({ id: "F-3", priority: 4 }),
    ]);
    const vcs = { getCodeReviews: vi.fn().mockResolvedValue([]) };

    const result = await perItemSelect(
      makePerItemStageDef(),
      { vcs, workspacePath: "/tmp", state },
      makeCtx(),
    );

    expect(result?.scopeKey).toBe("F-2");
    expect(result?.data).toMatchObject({ workItemId: "F-2" });
  });

  it("tie-breaks by createdAt ASC on equal priority", async () => {
    const state = makeStateWithItems([
      makeWorkItem({ id: "F-NEW", priority: 3, createdAt: "2026-04-16T12:00:00Z" }),
      makeWorkItem({ id: "F-OLD", priority: 3, createdAt: "2026-04-15T08:00:00Z" }),
    ]);
    const vcs = { getCodeReviews: vi.fn().mockResolvedValue([]) };

    const result = await perItemSelect(
      makePerItemStageDef(),
      { vcs, workspacePath: "/tmp", state },
      makeCtx(),
    );

    expect(result?.scopeKey).toBe("F-OLD");
  });

  it("lets an item re-enter when its PR is labelled ai:pending (manual reset)", async () => {
    const conventions = {
      labels: { pending: "ai:pending", processing: "ai:processing", inReview: "ai:in-review", readyToMerge: "ai:ready-to-merge", failed: "ai:failed" },
      branches: { aiPrefix: "ai", init: "ai/init", tasks: "ai/tasks", findings: "ai/findings", research: "ai/research", retrospective: "ai/retrospective" },
      prPrefixes: { task: "", finding: "", research: "", improver: "", init: "" },
      patterns: { taskId: "", findingPrefix: "F" },
      commentMarker: "",
    };
    const state = makeStateWithItems([makeWorkItem({ id: "F-RESET", priority: 1 })]);
    const vcs = {
      getCodeReviews: vi.fn().mockResolvedValue([
        makePR(99, "ai/findings/F-RESET", false, ["ai:pending"]),
      ]),
    };

    const result = await perItemSelect(
      makePerItemStageDef({ maxActive: 2 }),
      { vcs, workspacePath: "/tmp", state, conventions },
      makeCtx(),
    );

    expect(result?.scopeKey).toBe("F-RESET");
  });

  it("skips an item whose existing PR is actively worked (ai:processing)", async () => {
    const conventions = {
      labels: { pending: "ai:pending", processing: "ai:processing", inReview: "ai:in-review", readyToMerge: "ai:ready-to-merge", failed: "ai:failed" },
      branches: { aiPrefix: "ai", init: "ai/init", tasks: "ai/tasks", findings: "ai/findings", research: "ai/research", retrospective: "ai/retrospective" },
      prPrefixes: { task: "", finding: "", research: "", improver: "", init: "" },
      patterns: { taskId: "", findingPrefix: "F" },
      commentMarker: "",
    };
    const state = makeStateWithItems([
      makeWorkItem({ id: "F-WORKING", priority: 1 }),
      makeWorkItem({ id: "F-NEW", priority: 3 }),
    ]);
    const vcs = {
      getCodeReviews: vi.fn().mockResolvedValue([
        makePR(99, "ai/findings/F-WORKING", false, ["ai:processing"]),
      ]),
    };

    const result = await perItemSelect(
      makePerItemStageDef({ maxActive: 2 }),
      { vcs, workspacePath: "/tmp", state, conventions },
      makeCtx(),
    );

    expect(result?.scopeKey).toBe("F-NEW");
  });

  it("ignores ai:failed PRs in capacity count and lets their item re-enter", async () => {
    const conventions = {
      labels: { pending: "ai:pending", processing: "ai:processing", inReview: "ai:in-review", readyToMerge: "ai:ready-to-merge", failed: "ai:failed" },
      branches: { aiPrefix: "ai", init: "ai/init", tasks: "ai/tasks", findings: "ai/findings", research: "ai/research", retrospective: "ai/retrospective" },
      prPrefixes: { task: "", finding: "", research: "", improver: "", init: "" },
      patterns: { taskId: "", findingPrefix: "F" },
      commentMarker: "",
    };
    const state = makeStateWithItems([makeWorkItem({ id: "F-REDO", priority: 1 })]);
    const vcs = {
      getCodeReviews: vi.fn().mockResolvedValue([
        makePR(100, "ai/findings/F-100", false, ["ai:failed"]),
        makePR(101, "ai/findings/F-REDO", false, ["ai:failed"]),
      ]),
    };

    const result = await perItemSelect(
      makePerItemStageDef({ maxActive: 2 }),
      { vcs, workspacePath: "/tmp", state, conventions },
      makeCtx(),
    );

    expect(result?.scopeKey).toBe("F-REDO");
  });

  it("skips items with an existing PR on their per-item branch (rejection filter)", async () => {
    const state = makeStateWithItems([
      makeWorkItem({ id: "F-REJ", priority: 2 }),
      makeWorkItem({ id: "F-OK", priority: 3 }),
    ]);
    const vcs = {
      getCodeReviews: vi.fn().mockResolvedValue([
        makePR(50, "ai/findings/F-REJ", true),    // closed PR on F-REJ → rejected, skip
      ]),
    };

    const result = await perItemSelect(
      makePerItemStageDef(),
      { vcs, workspacePath: "/tmp", state },
      makeCtx(),
    );

    expect(result?.scopeKey).toBe("F-OK");
  });

  it("applies stage-supplied perItemFilter", async () => {
    const state = makeStateWithItems([
      makeWorkItem({ id: "F-1", priority: 2 }),
      makeWorkItem({ id: "F-2", priority: 3 }),
    ]);
    const vcs = { getCodeReviews: vi.fn().mockResolvedValue([]) };
    const perItemFilter = vi.fn().mockImplementation(async (item: WorkItem) => item.id !== "F-1");

    const result = await perItemSelect(
      makePerItemStageDef(),
      { vcs, workspacePath: "/tmp", state, perItemFilter },
      makeCtx(),
    );

    expect(result?.scopeKey).toBe("F-2");
    expect(perItemFilter).toHaveBeenCalled();
  });

  it("skips items at the attempt cap and picks lower-attempt candidates", async () => {
    // F-CAPPED has attemptCount=2 (default cap), F-FRESH has 0 → only F-FRESH selected.
    const state = makeStateWithItems([
      makeWorkItem({ id: "F-CAPPED", priority: 1, attemptCount: 2 }),
      makeWorkItem({ id: "F-FRESH", priority: 3, attemptCount: 0 }),
    ]);
    const vcs = { getCodeReviews: vi.fn().mockResolvedValue([]) };

    const result = await perItemSelect(
      makePerItemStageDef(),
      { vcs, workspacePath: "/tmp", state },
      makeCtx(),
    );

    expect(result?.scopeKey).toBe("F-FRESH");
  });

  it("returns null when every pending item is at the attempt cap", async () => {
    const state = makeStateWithItems([
      makeWorkItem({ id: "F-CAP1", priority: 1, attemptCount: 2 }),
      makeWorkItem({ id: "F-CAP2", priority: 2, attemptCount: 3 }),
    ]);
    const vcs = { getCodeReviews: vi.fn().mockResolvedValue([]) };

    const result = await perItemSelect(
      makePerItemStageDef(),
      { vcs, workspacePath: "/tmp", state },
      makeCtx(),
    );

    expect(result).toBeNull();
  });

  it("treats undefined attemptCount as 0 (fresh item still selectable)", async () => {
    const state = makeStateWithItems([
      makeWorkItem({ id: "F-NEW", priority: 5 /* no attemptCount field */ }),
    ]);
    const vcs = { getCodeReviews: vi.fn().mockResolvedValue([]) };

    const result = await perItemSelect(
      makePerItemStageDef(),
      { vcs, workspacePath: "/tmp", state },
      makeCtx(),
    );

    expect(result?.scopeKey).toBe("F-NEW");
  });

  it("throws when stageDef.selectorConfig.kind is missing", async () => {
    const state = makeStateWithItems([]);
    const vcs = { getCodeReviews: vi.fn().mockResolvedValue([]) };

    await expect(
      perItemSelect(
        makePerItemStageDef({ selectorConfig: {} }),
        { vcs, workspacePath: "/tmp", state },
        makeCtx(),
      ),
    ).rejects.toThrow(/selectorConfig\.kind/);
  });

  it("throws when deps.state is missing", async () => {
    const vcs = { getCodeReviews: vi.fn().mockResolvedValue([]) };

    await expect(
      perItemSelect(
        makePerItemStageDef(),
        { vcs, workspacePath: "/tmp" },
        makeCtx(),
      ),
    ).rejects.toThrow(/deps\.state/);
  });

  it("throws when stageDef.branchPrefix is missing", async () => {
    const state = makeStateWithItems([]);
    const vcs = { getCodeReviews: vi.fn().mockResolvedValue([]) };

    await expect(
      perItemSelect(
        makePerItemStageDef({ branchPrefix: undefined }),
        { vcs, workspacePath: "/tmp", state },
        makeCtx(),
      ),
    ).rejects.toThrow(/branchPrefix/);
  });

  it("returns null when all items are filtered out by perItemFilter", async () => {
    const state = makeStateWithItems([makeWorkItem({ id: "F-1" })]);
    const vcs = { getCodeReviews: vi.fn().mockResolvedValue([]) };
    const perItemFilter = vi.fn().mockResolvedValue(false);

    const result = await perItemSelect(
      makePerItemStageDef(),
      { vcs, workspacePath: "/tmp", state, perItemFilter },
      makeCtx(),
    );

    expect(result).toBeNull();
  });
});
