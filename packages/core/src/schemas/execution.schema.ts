import { z } from "zod";

/**
 * Execution history schemas (Step 14).
 *
 * Three KV categories share one file to keep the execution-history surface
 * cohesive. Every stage run writes one `executions/{id}` metadata row, N
 * `execution-events/{id}/{seq}` rows as it progresses, and optionally one
 * `execution-logs/{id}` blob. See architecture-v5.md §7.
 */

/**
 * Verdict surfaced by {@link runStage} after the agent + afterAgent hooks
 * finish. Mirrors `engine/pipeline/types.ts#Verdict` as a string literal
 * union — core has no orchestrator types so we restate the four values.
 */
const verdictSchema = z.enum(["approved", "failed", "cancelled", "rejected"]);

/**
 * Terminal status of the execution record itself. Distinct from `verdict`:
 * an execution can finish `completed` with a `failed` verdict (the stage ran
 * to the end and produced a failure PR), or `interrupted` when the engine
 * was killed mid-run.
 */
const executionStatusSchema = z.enum([
  "running",
  "completed",
  "failed",
  "interrupted",
  "timed-out",
]);

/**
 * Row in `kv:executions/{id}`. Written twice: first at stage start with
 * `status: "running"`, then on exit with final fields (durationMs, verdict,
 * summary, prNumber, status). `recentExecutionIds` on the work-item row is
 * the secondary index — query `kv:executions/{id}` by known id, or list
 * `kv:executions` + filter by `workItemId` in memory.
 */
export const executionEntrySchema = z.object({
  id: z.string().min(1),
  traceId: z.string().min(1),
  repoId: z.string().min(1),
  stageName: z.string().min(1),
  agent: z.string().optional(),
  workItemId: z.string().optional(),
  prNumber: z.number().int().positive().optional(),
  scopeKey: z.string().optional(),
  startedAt: z.string().min(1),
  finishedAt: z.string().optional(),
  durationMs: z.number().int().nonnegative().optional(),
  attempts: z.number().int().nonnegative().optional(),
  verdict: verdictSchema.optional(),
  summary: z.string().optional(),
  status: executionStatusSchema,
  error: z.string().optional(),
  /**
   * Normalized success rate in [0, 1]. The current implementation
   * collapses to two endpoints — `1` means the stage produced a fully
   * successful outcome (PR merged or `verdict=approved` for terminal
   * stages), `0` means failure / cancellation / rejection / timed-out.
   * Future iterations grade intermediate values from review-loop
   * activity (attempts spent, negative verifier comments, retries
   * survived). Surfaced in App UI as the dominant per-execution
   * signal.
   */
  successScore: z.number().min(0).max(1).nullable().optional(),
  /**
   * Parent execution id. Set on stage rows to point at the cycle row
   * that wrapped them. Cycle rows themselves have `parentExecutionId
   * === undefined` and are distinguished by `stageName: "cycle"`.
   * App UI uses this to render a tree (cycle ▸ stages ▸ child agents).
   */
  parentExecutionId: z.string().optional(),
  /**
   * IDs of executions wrapped under this row. Populated only on cycle
   * rows; stage rows leave it undefined.
   */
  childExecutionIds: z.array(z.string()).optional(),
  /**
   * Engine-instance id that produced this execution. Joins back to
   * `kv:instances/{instanceId}` so `/instances/{id}` can list every run
   * spawned by that runner. Optional for backwards-compat with rows
   * written before the instances category landed.
   */
  instanceId: z.string().optional(),
});

export type ExecutionEntry = z.infer<typeof executionEntrySchema>;

/**
 * Row in `kv:execution-events/{id}/{seq:0000}`. Append-only — never rewritten.
 * Primitives emit one event per logical transition inside the 8-step loop.
 */
export const executionEventSchema = z.object({
  seq: z.number().int().nonnegative(),
  timestamp: z.string().min(1),
  type: z.string().min(1),
  /** Severity for UI rendering; defaults to "info" when absent. */
  level: z.enum(["info", "warn", "error"]).optional(),
  message: z.string(),
  /**
   * Optional multi-line human-readable detail. Used for stderr blocks,
   * agent stdout previews, full prompts, verifier feedback — anything
   * the operator needs to read inline without expanding the JSON
   * payload.
   */
  detail: z.string().optional(),
  payload: z.unknown().optional(),
});

export type ExecutionEventEntry = z.infer<typeof executionEventSchema>;

/**
 * Row in `kv:execution-logs/{id}`. One per execution; contains the raw log
 * text (agent stdout, hook decisions, verdict narrative) joined with
 * newlines. Not streamed — we write once at execution end.
 */
export const executionLogSchema = z.object({
  executionId: z.string().min(1),
  body: z.string(),
  lineCount: z.number().int().nonnegative().optional(),
});

export type ExecutionLogEntry = z.infer<typeof executionLogSchema>;
