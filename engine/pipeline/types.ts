import type { WorkflowStageEntry } from "@operator/core";

/**
 * Shared runtime types for the `runStage` generic loop and its primitives.
 *
 * These types are module-local to the `engine/pipeline/**` subtree. They do
 * not leak to `@operator/core` or `@operator/adapters` — they describe
 * orchestrator-internal shapes that no adapter or app consumer needs.
 *
 * Frozen contract from `docs/architecture-v5.md §3.1.1`. Any change requires
 * a doc revision in the same PR.
 */

/** Fully-resolved stage definition that `runStage` consumes. */
export type StageDef = WorkflowStageEntry & {
  /** Base branch used for branch creation + reset. */
  readonly baseBranch: string;
};

/**
 * Terminal (or retry-loop) disposition for a stage's agent run.
 *
 * - `approved` — agent + verifier succeeded, persist the output
 * - `retry` — verifier asked for another attempt; in-budget, consumed by
 *   `AgentRuntime`'s internal retry loop; NEVER surfaced as a verdict
 * - `failed` — verifier terminal `failed`, or CLI/verify retries exhausted
 * - `cancelled` — verifier terminal `cancelled` (work no longer needed)
 * - `rejected` — verifier terminal `rejected` (scope wrong)
 */
export type Verdict = "approved" | "failed" | "cancelled" | "rejected";

/** One unit of work selected by an {@link InputSelector}. */
export interface StageInput {
  /** Branch-scope key appended to `branchPrefix`. For bootstrap = "init". */
  readonly scopeKey: string;
  /** Strategy-specific payload (work-item id, PR number, etc). */
  readonly data?: unknown;
  /** Diagnostic reason surfaced into execution logs. */
  readonly reason?: string;
}

/** Result of {@link AgentInvocation.invoke}. */
export interface AgentResult {
  readonly verdict: Verdict;
  /** Raw stdout of the last agent attempt. */
  readonly output: string;
  /** Number of attempts the runtime made (1-based). */
  readonly attempts: number;
  /** Verifier-extracted summary when verdict = approved; error reason otherwise. */
  readonly summary: string;
}

/** Result of a complete {@link runStage} invocation. */
export interface StageRunResult {
  readonly status: "completed" | "skipped" | "failed";
  readonly reason?: string;
  readonly verdict?: Verdict;
  readonly prNumber?: number;
  readonly branch?: string;
}
