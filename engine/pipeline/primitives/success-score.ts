import type { WorkItemStatus } from "@operator/core";

/**
 * Continuous success score primitive. Replaces the pre-2026-05-20 binary
 * `successScore: 0 | 1 | null` with a graded `[SCORE_FLOOR..1]` value so
 * "one-shot landed clean" reads differently from "merged after 3 retries
 * and 2 pr-review cycles".
 *
 * Two scopes:
 *
 * - {@link executionScore} — per-execution. Inputs: the verifier verdict
 *   and the number of agent attempts within that execution. Lives on
 *   `kv:executions/{id}.successScore`, set by `run-stage.finalize`.
 *
 * - {@link workItemScore} — per work-item rollup. Inputs: the
 *   terminal lifecycle status and the list of executions accumulated on
 *   the way there. Lives on `kv:work-items/{id}.successScore`, set by
 *   `reconcileAndWrite` once the item reaches a terminal state.
 *
 * Both return `undefined` while in-flight so the UI keeps showing "—"
 * for items whose outcome is not yet decided.
 *
 * Penalty model (two data-light
 * adjustments: CI-retry-on-same-SHA and negative-reviewer-comment
 * multipliers are deferred until we have reliable data sources for
 * them):
 *
 *   per-execution:
 *     base × ATTEMPT_PENALTY ^ max(0, attempts - 1)
 *
 *   per work-item:
 *     base × PR_REVIEW_CYCLE_PENALTY ^ max(0, supervisorExecutionCount - 1)
 *           × FAILED_EXECUTION_PENALTY ^ failedVerdictCount
 *
 * Bases:
 *   approved / merged / completed → 1
 *   rejected                       → 1 (caught false positive — terminal SUCCESS for agent)
 *   failed / cancelled / duplicate → 0
 *   in-flight                      → undefined
 *
 * Note on `duplicate`: per project policy (`feedback_pr_bound_terminal_statuses`)
 * `duplicate` is a terminal FAILURE for scoring purposes, not a half-credit
 * outcome — App lifecycle grouping treats duplicate as a "did not land"
 * signal even though the underlying work may have been duplicated.
 *
 * Note on `rejected`: the rejection flow doctrine treats a rejected
 * verdict as a successful agent outcome (the agent caught a false-positive
 * work-item and refused to act). Score 1, not 0.
 *
 * Floor (`SCORE_FLOOR = 0.05`) caps how low chain-multipliers can drag a
 * score so the signal stays interpretable. Without it, 6 cascaded
 * penalties collapse below 0.01 where the UI badge could no longer
 * differentiate "very bad" from "absolutely catastrophic" — neither is
 * actionable beyond "this needs attention".
 */

export const SCORE_FLOOR = 0.05;

/**
 * Multiplier per agent attempt past the first within one execution. An
 * attempts=1 execution pays no penalty; attempts=2 pays one (0.7x);
 * attempts=3 pays two (0.49x). Matches the `failed-execution before
 * terminal success` multiplier in the work-item rollup so the two
 * scoring layers reflect the same intuition: "the agent had to redo
 * itself".
 */
const ATTEMPT_PENALTY = 0.7;

/** Per pr-review cycle past the first on a work item. */
const PR_REVIEW_CYCLE_PENALTY = 0.85;

// Per-failed-execution penalty is intentionally reused from
// ATTEMPT_PENALTY (0.7) — same intuition ("an attempt failed") applies at
// both scoring layers, so they stay numerically aligned.

export interface ExecutionScoreInput {
  /** Verdict from the verifier. `approved` / `rejected` / `failed` / `cancelled`. */
  readonly verdict: string | undefined;
  /** Number of agent attempts within this execution (1 = no retry, N>1 = N-1 retries). */
  readonly attempts: number;
}

/**
 * Score one completed execution. Returns `undefined` for verdicts not in
 * the scoring vocabulary (the execution is still pending or carries an
 * unknown shape — caller treats that as "no signal yet").
 */
export function executionScore(input: ExecutionScoreInput): number | undefined {
  const base = baseFromVerdict(input.verdict);
  if (base === undefined) return undefined;
  if (base === 0) return 0;
  const retryExponent = Math.max(0, input.attempts - 1);
  const score = base * Math.pow(ATTEMPT_PENALTY, retryExponent);
  return clampToFloor(score);
}

export interface ExecutionDataPoint {
  /** Verifier verdict on the execution row, if it terminated. */
  readonly verdict?: string;
  /** Agent role that ran (e.g. `creator`, `planner`, `supervisor`). */
  readonly agent?: string;
}

export interface WorkItemScoreInput {
  /** The computed lifecycle status the reconciler is about to write. */
  readonly status: WorkItemStatus;
  /** Execution rows referenced by `recentExecutionIds` (engine fetches them ahead of calling this). */
  readonly executions: readonly ExecutionDataPoint[];
}

/**
 * Score one work item from its terminal status + accumulated execution
 * history. Returns `undefined` while the item is in-flight.
 *
 * Agent-role-based counting is intentionally stage-name-agnostic: we
 * count `supervisor` executions as pr-review cycles because the
 * supervisor role IS the pr-feedback agent across all repos (per the
 * Phase A supervisor architecture). Stage-name-based counting would
 * couple scoring to per-repo stage config.
 */
export function workItemScore(input: WorkItemScoreInput): number | undefined {
  const base = baseFromWorkItemStatus(input.status);
  if (base === undefined) return undefined;
  if (base === 0) return 0;
  const supervisorCount = input.executions.filter((e) => e.agent === "supervisor").length;
  const failedCount = input.executions.filter((e) => e.verdict === "failed").length;
  const prCyclePenaltyExp = Math.max(0, supervisorCount - 1);
  let score = base;
  score *= Math.pow(PR_REVIEW_CYCLE_PENALTY, prCyclePenaltyExp);
  score *= Math.pow(ATTEMPT_PENALTY, failedCount);
  return clampToFloor(score);
}

function baseFromVerdict(verdict: string | undefined): number | undefined {
  switch (verdict) {
    case "approved":
    case "rejected":
      return 1;
    case "failed":
    case "cancelled":
      return 0;
    default:
      return undefined;
  }
}

function baseFromWorkItemStatus(status: WorkItemStatus): number | undefined {
  switch (status) {
    case "merged":
    case "accepted": // T-601 Phase A: non-VCS terminal-success synonym for `merged`.
    case "completed":
    case "rejected":
      return 1;
    case "failed":
    case "cancelled":
    case "duplicate":
      return 0;
    default:
      return undefined;
  }
}

function clampToFloor(score: number): number {
  // Round to 4 decimals first so equal inputs always produce equal
  // bytes (KV equality checks rely on this; without rounding `0.85 * 1`
  // can become `0.8500000000000001` on JS floats).
  const rounded = Number(score.toFixed(4));
  return Math.max(SCORE_FLOOR, rounded);
}

