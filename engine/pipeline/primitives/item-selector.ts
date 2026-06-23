import { access } from "node:fs/promises";
import { join } from "node:path";
import type { OperationContext, VCSPlatform, StateManager, WorkItem, ConventionsConfig } from "@operator/core";
import type { Logger } from "../../logging/logger.js";
import type { StageDef, StageInput } from "../types.js";
import { prFeedbackSelect } from "./pr-feedback-selector.js";
import { discoverySelect } from "./discovery-selector.js";
import { singletonSelect } from "./singleton-selector.js";

/**
 * Input-selection strategy — registry-backed, one function per kind.
 *
 * The `runStage` loop looks up the strategy by `stageDef.selector` and calls
 * {@link InputSelectorFn}. No enum constraint — the string lands in the
 * registry, returns the implementation, runs. Adding a strategy = writing
 * one function + one registry entry.
 *
 * Strategies implemented so far: `bootstrap` (Step 8b), `per-item` (Step 9),
 * `pr-feedback` (Step 10 — lives in {@link ./pr-feedback-selector.js} to keep
 * this file under the pipeline 200-line cap), `discovery` (Step 11 — lives in
 * {@link ./discovery-selector.js} for the same reason, used by research),
 * `singleton` (Step 12 — lives in {@link ./singleton-selector.js}, used by
 * retrospective).
 */

/**
 * Deps the bootstrap selector needs. Narrower than full engine deps so the
 * primitive is unit-testable with a fake VCS and a real temp workspace path.
 */
export interface BootstrapSelectorDeps {
  readonly vcs: Pick<VCSPlatform, "getCodeReviews"> & Partial<Pick<VCSPlatform, "getComments" | "getReviewComments" | "getCheckRuns">>;
  /** Absolute path to the managed repo checkout on disk. */
  readonly workspacePath: string;
  /**
   * Optional logger. When provided, the selector emits INFO lines explaining
   * each skip decision (v5 observability mandate — `intelligence/rules/typescript.md`:
   * every decision with a reason gets an INFO log).
   */
  readonly log?: Logger;
  /** StateManager for per-item selector (unused by bootstrap). */
  readonly state?: StateManager;
  /** Repo conventions (branch prefixes) for per-item capacity check. */
  readonly conventions?: ConventionsConfig;
  /**
   * Optional per-stage work-item filter for per-item strategy. When provided,
   * candidate items the filter returns `false` for are skipped. Used by
   * task-execute for domain-conflict + unmet-dependency checks.
   */
  readonly perItemFilter?: (
    item: WorkItem,
    ctx: OperationContext,
  ) => Promise<boolean>;
}

/**
 * Universal bounded-iteration cap for `per-item` selector. Items reaching
 * this attempt count are permanently skipped (no auto-retry past the cap).
 * Industry-standard guardrail per Spotify LLM Judge / LangGraph supervisor
 * patterns. Reset is a human action through the UI (or by spawning a fresh
 * replacement work-item with a new id).
 */
const MAX_ATTEMPTS_PER_ITEM = 2;

/**
 * Strategy-specific selector signature. Returns the selected input when there
 * is work to do, or `null` when the stage should no-op this cycle.
 */
export type InputSelectorFn = (
  stageDef: StageDef,
  deps: BootstrapSelectorDeps,
  ctx: OperationContext,
) => Promise<StageInput | null>;

/**
 * Registry-backed dispatch. Strategies are added by registering them;
 * unknown strategies throw (never silently no-op).
 */
export class ItemSelectorRegistry {
  private readonly strategies = new Map<string, InputSelectorFn>();

  register(name: string, fn: InputSelectorFn): void {
    if (this.strategies.has(name)) {
      throw new Error(`Selector strategy already registered: ${name}`);
    }
    this.strategies.set(name, fn);
  }

  async select(
    stageDef: StageDef,
    deps: BootstrapSelectorDeps,
    ctx: OperationContext,
  ): Promise<StageInput | null> {
    const fn = this.strategies.get(stageDef.selector);
    if (!fn) {
      throw new Error(
        `Unknown selector strategy: ${stageDef.selector} (stage: ${stageDef.name})`,
      );
    }
    return fn(stageDef, deps, ctx);
  }
}

/**
 * Bootstrap selector — used by the `init` stage (and any future stage that
 * needs "seed the repo if not seeded yet" semantics).
 *
 * Three-way decision:
 *
 *   1. `requiredFile` already present on the workspace's current branch
 *      → `null` (stage is a no-op; repo is already initialized)
 *   2. A PR already exists on `branchPrefix` (e.g. `ai/init`)
 *      → `null` (pr-review handles feedback on the open PR; init skips)
 *   3. Neither → return `{ scopeKey: "init", reason: "missing-scaffold" }`
 *
 * Replaces the inline skip checks that Step 8a put in the init case block of
 * `engine/entry.ts` — those lines are deleted when init migrates to runStage.
 */
export const bootstrapSelect: InputSelectorFn = async (stageDef, deps, _ctx) => {
  const requiredFile = typeof stageDef.selectorConfig?.["requiredFile"] === "string"
    ? (stageDef.selectorConfig["requiredFile"] as string)
    : ".operator/project.yaml";
  const targetBranch = stageDef.branchPrefix;
  if (!targetBranch) {
    throw new Error(`bootstrap selector requires branchPrefix (stage: ${stageDef.name})`);
  }

  const absoluteFile = join(deps.workspacePath, requiredFile);
  const fileExists = await access(absoluteFile).then(() => true, () => false);
  if (fileExists) {
    // v5 logging audit §14 — skip-with-reason INFO log. The caller logs the
    // stage-level skip too, but this narrows it to the selector's specific
    // decision path (file-already-present vs open-PR-exists).
    deps.log?.info(`bootstrap: ${requiredFile} already present, stage ${stageDef.name} will skip`, {
      stage: stageDef.name, selector: "bootstrap", reason: "file-exists", file: requiredFile,
    });
    return null;
  }

  const openPRs = await deps.vcs.getCodeReviews();
  const existing = openPRs.find((pr) => pr.branch === targetBranch && !pr.closed);
  if (existing) {
    deps.log?.info(`bootstrap: open PR #${existing.id} on ${targetBranch}, stage ${stageDef.name} will skip`, {
      stage: stageDef.name, selector: "bootstrap", reason: "open-pr", prNumber: existing.id, branch: targetBranch,
    });
    return null;
  }

  deps.log?.info(`bootstrap: repo needs init (no ${requiredFile}, no open ${targetBranch})`, {
    stage: stageDef.name, selector: "bootstrap", decision: "proceed",
  });
  return { scopeKey: "init", reason: "missing-scaffold" };
};

/**
 * Per-item selector — picks the highest-priority pending WorkItem of a given
 * kind (`"finding"` or `"task"`) and returns it as stage input. Used by
 * `finding-plan` and `task-execute` in Step 9 onwards.
 *
 * Decision flow (all INFO-logged per observability mandate):
 *
 *   1. List work items of `selectorConfig.kind` + `status` from StateManager.
 *   2. Fetch open PRs once (shared with capacity check + rejection filter).
 *   3. Apply capacity cap — if count of open AI PRs on `branchPrefix/*` ≥
 *      `selectorConfig.maxActive`, skip (null).
 *   4. Apply optional `deps.perItemFilter` (task-execute uses this for
 *      domain-conflict + dependency checks).
 *   5. Pick highest priority (priority DESC, createdAt ASC) that has no
 *      existing open / closed-unmerged PR on its per-item branch
 *      (prevents picking up a previously-rejected item).
 *   6. Return `{scopeKey: workItem.id, data: {workItemId, workItem}}`.
 *
 * Returns `null` for any skip path so `runStage` exits cleanly with
 * `status: "skipped", reason: "no-input"`.
 */
export const perItemSelect: InputSelectorFn = async (stageDef, deps, ctx) => {
  const cfg = stageDef.selectorConfig ?? {};
  const kind = typeof cfg["kind"] === "string" ? cfg["kind"] as string : null;
  if (!kind) {
    throw new Error(`per-item selector requires selectorConfig.kind (stage: ${stageDef.name})`);
  }
  const status = typeof cfg["status"] === "string" ? cfg["status"] as string : "pending";
  if (!deps.state) {
    throw new Error(`per-item selector requires deps.state (stage: ${stageDef.name})`);
  }
  if (!stageDef.branchPrefix) {
    throw new Error(`per-item selector requires stageDef.branchPrefix (stage: ${stageDef.name})`);
  }
  const maxActive = stageDef.maxActive ?? 2;

  // 1. List candidate items.
  const items = await deps.state.listWorkItems(ctx, { kind });
  if (items.length === 0) {
    deps.log?.info(`per-item: no ${kind} items in state, stage ${stageDef.name} will skip`, {
      stage: stageDef.name, selector: "per-item", reason: "empty-state", kind,
    });
    return null;
  }

  // 2. Fetch open PRs — shared across capacity + rejection filter.
  const openPRs = await deps.vcs.getCodeReviews();
  const branchPrefix = stageDef.branchPrefix;

  // Classify existing open PRs by lifecycle label. Only PRs in the
  // "active" band (agent currently working or awaiting review/human
  // merge) occupy a capacity slot and block re-entry of their item.
  // PRs in the "requeued" band (`ai:pending` manual reset or
  // `ai:failed` retry) are available for the pipeline to pick up
  // again — re-entering them is the whole point of those labels.
  const labels = deps.conventions?.labels;
  const pendingLabel = labels?.pending;
  const processingLabel = labels?.processing;
  const inReviewLabel = labels?.inReview;
  const readyToMergeLabel = labels?.readyToMerge;
  const failedLabel = labels?.failed;
  const hasLabel = (pr: typeof openPRs[number], name: string | undefined): boolean =>
    name != null && pr.labels.some((l) => l.name === name);
  const isRequeued = (pr: typeof openPRs[number]): boolean =>
    hasLabel(pr, pendingLabel) || hasLabel(pr, failedLabel);
  const isActivelyWorked = (pr: typeof openPRs[number]): boolean =>
    hasLabel(pr, processingLabel)
    || hasLabel(pr, inReviewLabel)
    || hasLabel(pr, readyToMergeLabel);

  // 3. Capacity check — only actively-worked PRs use a slot.
  const activeCount = openPRs.filter(
    (pr) => pr.branch.startsWith(`${branchPrefix}/`) && !pr.closed && isActivelyWorked(pr),
  ).length;
  if (activeCount >= maxActive) {
    deps.log?.info(`per-item: at capacity ${activeCount}/${maxActive} on ${branchPrefix}/*, stage ${stageDef.name} will skip`, {
      stage: stageDef.name, selector: "per-item", reason: "at-capacity", kind,
      activeCount, maxActive, branchPrefix,
    });
    return null;
  }

  // 4. Filter candidate items by status + bounded-iteration guard.
  //
  // Bounded-iteration: items whose `attemptCount` reached the cap are
  // permanently skipped by selectors (no auto-retry past the cap — human
  // resets via UI or spawns a replacement). Industry-standard guardrail
  // against infinite re-pick loops (LangGraph supervisor pattern,
  // Spotify LLM Judge).
  const cappedItems = items.filter((item) => (item.attemptCount ?? 0) >= MAX_ATTEMPTS_PER_ITEM);
  if (cappedItems.length > 0) {
    deps.log?.info(`per-item: ${cappedItems.length} ${kind} item(s) at attempt cap ${MAX_ATTEMPTS_PER_ITEM}, skipping permanently`, {
      stage: stageDef.name, selector: "per-item", reason: "attempt-cap",
      kind, cappedIds: cappedItems.map((i) => i.id), cap: MAX_ATTEMPTS_PER_ITEM,
    });
  }
  const candidates = items.filter(
    (item) => item.status === status && (item.attemptCount ?? 0) < MAX_ATTEMPTS_PER_ITEM,
  );
  if (candidates.length === 0) {
    deps.log?.info(`per-item: no ${kind} items with status=${status} below attempt cap, stage ${stageDef.name} will skip`, {
      stage: stageDef.name, selector: "per-item", reason: "no-pending", kind, status,
      totalItems: items.length, cappedCount: cappedItems.length,
    });
    return null;
  }

  // 5. Apply optional stage-specific filter (task-execute uses this).
  const filtered: WorkItem[] = [];
  for (const item of candidates) {
    if (deps.perItemFilter && !(await deps.perItemFilter(item, ctx))) continue;
    // Skip items whose per-item branch already has a PR that is
    // actively being worked. PRs labelled `ai:pending` (manual reset)
    // or `ai:failed` (retry) are requeued and the stage SHOULD pick
    // them up again — beforeAgent reuses the existing PR via
    // `findCodeReviewForBranch` + `markProcessing`.
    const itemBranch = `${branchPrefix}/${item.id}`;
    const existingPR = openPRs.find((pr) => pr.branch === itemBranch);
    if (existingPR && !isRequeued(existingPR) && isActivelyWorked(existingPR)) {
      deps.log?.debug(`per-item: skipping ${item.id} — existing PR on ${itemBranch} actively worked`, {
        stage: stageDef.name, itemId: item.id, branch: itemBranch,
      });
      continue;
    }
    if (existingPR && !isRequeued(existingPR) && !isActivelyWorked(existingPR)) {
      // PR exists with no lifecycle label (unknown state) — skip to
      // avoid stomping; operator can add `ai:pending` manually to
      // route it back through the pipeline.
      deps.log?.debug(`per-item: skipping ${item.id} — existing PR on ${itemBranch} has no lifecycle label`, {
        stage: stageDef.name, itemId: item.id, branch: itemBranch,
      });
      continue;
    }
    filtered.push(item);
  }
  if (filtered.length === 0) {
    deps.log?.info(`per-item: all ${candidates.length} ${kind} candidates filtered out, stage ${stageDef.name} will skip`, {
      stage: stageDef.name, selector: "per-item", reason: "all-filtered", kind,
      candidateCount: candidates.length,
    });
    return null;
  }

  // 6. Pick highest priority. Lower numeric priority wins (P1 > P8);
  // tie-break by createdAt ASC (oldest first).
  const sorted = [...filtered].sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority;
    const aTime = a.createdAt ? Date.parse(a.createdAt) : 0;
    const bTime = b.createdAt ? Date.parse(b.createdAt) : 0;
    return aTime - bTime;
  });
  const picked = sorted[0];

  deps.log?.info(
    `per-item: selected ${kind} ${picked.id} P${picked.priority} for stage ${stageDef.name} ` +
    `(${filtered.length}/${candidates.length} eligible, ${activeCount}/${maxActive} active)`,
    {
      stage: stageDef.name, selector: "per-item", decision: "proceed",
      kind, itemId: picked.id, priority: picked.priority, title: picked.title?.slice(0, 80),
      activeCount, maxActive, candidateCount: candidates.length, filteredCount: filtered.length,
    },
  );

  return {
    scopeKey: picked.id,
    data: { workItemId: picked.id, workItem: picked },
    reason: `priority-${picked.priority}`,
  };
};

/**
 * Build a registry pre-populated with the strategies wired in the current
 * migration step. Composition root instantiates this and passes it into
 * `runStage` via deps.
 */
export function createDefaultSelectorRegistry(): ItemSelectorRegistry {
  const registry = new ItemSelectorRegistry();
  registry.register("bootstrap", bootstrapSelect);
  registry.register("per-item", perItemSelect);
  registry.register("pr-feedback", prFeedbackSelect);
  registry.register("discovery", discoverySelect);
  registry.register("singleton", singletonSelect);
  return registry;
}
