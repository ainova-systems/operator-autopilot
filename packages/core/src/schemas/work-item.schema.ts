import { z } from "zod";

/**
 * Work-item KV row schema (Step 14).
 *
 * `kv:work-items/{id}` is reconciled once per cycle by `syncFilesToState` and
 * after every stage that touches the item. The schema adds observability
 * columns alongside the canonical fields so the UI can surface drift between
 * four observation sources (develop file, feature-branch file, PR label,
 * last execution verdict).
 *
 * See architecture-v5.md §6.3 (reconciliation) and §7 (execution history).
 */

const workItemStatusSchema = z.enum([
  "pending",
  "in-progress",
  "completed",
  "failed",
  "cancelled",
  "rejected",
  "duplicate",
  "reopened",
  "in-review",
  "ready-to-merge",
  "merged",
  // T-601 Phase A (2026-05-20): `accepted` introduced as a non-VCS
  // synonym for `merged` so future non-PR-bound kinds can reach a
  // terminal-success state without inheriting GitHub vocabulary.
  // Treated as terminal-success equivalent to `merged` in every
  // engine code path; reconciler still writes `merged` from PR-merge
  // observations (Phase B will flip the write path + add backfill).
  "accepted",
]);

/**
 * Develop-branch file observation. Captured by `observeDevelopFile` during
 * `syncFilesToState` — that is the reconciler's "merged file" slot.
 *
 * `sha` is the develop HEAD commit SHA at read time so the observation can
 * be replayed against the exact file content the engine saw.
 */
export const developFileObservationSchema = z.object({
  value: z.union([workItemStatusSchema, z.literal("missing")]),
  observedAt: z.string().min(1),
  sha: z.string().optional(),
  path: z.string().optional(),
});

/**
 * Feature-branch file observation. Captured by `observeFeatureBranchFile`
 * before and after `persistOutput` commits — that is the "in-flight PR" slot.
 */
export const featureBranchFileObservationSchema = z.object({
  value: z.union([workItemStatusSchema, z.literal("missing")]),
  observedAt: z.string().min(1),
  branch: z.string().optional(),
  sha: z.string().optional(),
});

/**
 * PR label observation. Captured by `observePRLabel` — the "label" slot on
 * the item's open code review. `null` value means no open PR was found.
 */
export const prLabelObservationSchema = z.object({
  value: z.string(),
  observedAt: z.string().min(1),
  prNumber: z.number().int().positive().optional(),
  branch: z.string().optional(),
});

/**
 * Execution verdict observation. Captured by `observeExecutionVerdict` when
 * `route-verdict` records the final verdict of a stage run targeting this
 * work item.
 */
export const executionVerdictObservationSchema = z.object({
  value: z.enum(["approved", "failed", "cancelled", "rejected"]),
  observedAt: z.string().min(1),
  executionId: z.string().min(1),
  stageName: z.string().optional(),
});

/**
 * PR state observation — distinguishes "open PR, AI done, waiting for merge"
 * (an expected in-flight state) from actual label drift. Captured alongside
 * `prLabel` during `syncFilesToState` and `persist-output`.
 *
 * `open` means the PR exists and is not closed — develop file being behind
 * the feature branch is normal. `merged` means the PR has been merged;
 * develop should now reflect the branch's state — a mismatch here IS drift.
 * `closed` means closed without merge; the task was cancelled/rejected.
 * `none` means no PR was found for the item branch.
 */
export const prStateObservationSchema = z.object({
  value: z.enum(["open", "merged", "closed", "none"]),
  observedAt: z.string().min(1),
  prNumber: z.number().int().positive().optional(),
  branch: z.string().optional(),
});

/**
 * CI / pipeline status observation (D-503). Aggregated value is the
 * worst-of per-check conclusion: any `failure` → `failing`; any pending
 * → `pending`; all success/neutral/skipped → `passing`; empty → `none`.
 * Per-check rows preserve provider-supplied annotations so the engine
 * can hand them to the agent without re-fetching.
 */
export const checkAnnotationSchema = z.object({
  path: z.string(),
  startLine: z.number().int().nonnegative(),
  endLine: z.number().int().nonnegative().optional(),
  message: z.string(),
  severity: z.enum(["notice", "warning", "failure"]),
  title: z.string().optional(),
});

export const checkRunSchema = z.object({
  name: z.string().min(1),
  conclusion: z.string().min(1),
  completedAt: z.string().optional(),
  headSha: z.string().optional(),
  detailsUrl: z.string().optional(),
  workflowName: z.string().optional(),
  workflowRunId: z.number().int().nonnegative().optional(),
  title: z.string().optional(),
  summary: z.string().optional(),
  text: z.string().optional(),
  annotations: z.array(checkAnnotationSchema).optional(),
});

export const checksObservationSchema = z.object({
  value: z.enum(["passing", "failing", "pending", "none"]),
  observedAt: z.string().min(1),
  headSha: z.string().optional(),
  checks: z.array(checkRunSchema),
});

/** Aggregate of all observation slots — optional because cycle order
 * populates them incrementally. Missing slots imply "not yet observed". */
export const statusSourcesSchema = z.object({
  developFile: developFileObservationSchema.optional(),
  featureBranchFile: featureBranchFileObservationSchema.optional(),
  prLabel: prLabelObservationSchema.optional(),
  executionVerdict: executionVerdictObservationSchema.optional(),
  prState: prStateObservationSchema.optional(),
  checks: checksObservationSchema.optional(),
});

export type StatusSources = z.infer<typeof statusSourcesSchema>;
export type DevelopFileObservation = z.infer<typeof developFileObservationSchema>;
export type FeatureBranchFileObservation = z.infer<typeof featureBranchFileObservationSchema>;
export type PrLabelObservation = z.infer<typeof prLabelObservationSchema>;
export type ExecutionVerdictObservation = z.infer<typeof executionVerdictObservationSchema>;
export type PrStateObservation = z.infer<typeof prStateObservationSchema>;
export type ChecksObservation = z.infer<typeof checksObservationSchema>;

/**
 * `kv:work-items/{id}` row. All baseline WorkItem fields plus the four
 * observation slots, the reconciled effective status, a drift flag, and a
 * ring-buffer of recent execution ids so the UI can render the timeline
 * without scanning every execution row.
 */
export const workItemEntrySchema = z.object({
  id: z.string().min(1),
  kind: z.string().min(1),
  title: z.string(),
  body: z.string().optional(),
  status: workItemStatusSchema,
  priority: z.number().int(),
  source: z.string().optional(),
  branch: z.string().optional(),
  codeReviewId: z.number().int().optional(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
  /**
   * Timestamp of the last domain-meaningful event on this item — what a
   * human would call "last activity". Bumps on status flips, new
   * executions, observation transitions (open→merged, passing→failing)
   * and drift state changes. Stays put when only background timestamps
   * (`observedAt`, per-check `completedAt`) refresh. The App UI sorts
   * by this column to keep recently-active items on top.
   */
  lastEventAt: z.string().optional(),
  /**
   * Generic parent linkage. Set when a stage spawns a child item
   * (today: planner creates tasks from a finding). The kind registry's
   * `parentKinds` declares which kinds may legally appear here.
   */
  parentId: z.string().optional(),
  /**
   * Bounded-iteration counter. Incremented by `route-verdict` on every
   * terminal-failure verdict ({failed, rejected, cancelled}). Per-item
   * selectors skip items whose `attemptCount >= MAX_ATTEMPTS_PER_ITEM`
   * (default 2) — this is the universal guardrail against infinite
   * re-pick loops on items the agent cannot resolve. Industry-standard
   * "max iteration count" guardrail (Spotify LLM Judge, LangGraph
   * supervisor pattern). Never decremented by the engine; reset is a
   * human action via the UI or by spawning a fresh replacement item.
   */
  attemptCount: z.number().int().nonnegative().optional(),

  // Observation layer — Step 14 + 2026-04-20 status-semantics inversion +
  // 2026-05-13 `effectiveStatus` → `developFileStatus` rename.
  //
  // `status` (top-level) holds the **computed** status — the one the UI
  // renders as "current state": `in-review`, `ready-to-merge`,
  // `completed`, etc. Produced by `reconcileEffectiveStatus`. This is
  // what the pipeline promotes through labels, drift reconciler writes,
  // and the app timeline shows.
  //
  // `developFileStatus` carries the **raw develop-file value** for
  // observability — the literal value recorded on the merged branch.
  // The UI uses it alongside `status` to show "develop is behind" or
  // "develop never received the rejection" diagnostics. Pre-rename this
  // field was called `effectiveStatus` which made the name collide with
  // the reconciler's internal "computed effective status" concept;
  // 2026-05-13 renamed for clarity (the field is observational only, it
  // is never the authoritative current status).
  //
  // `statusReason` replaces the previous `effectiveStatusReason` and
  // documents which source produced the computed `status` (e.g.
  // `"pr-label"`, `"execution-verdict"`, `"develop-file"`,
  // `"terminal-sticky"`, `"initial"`).
  developFileStatus: workItemStatusSchema.optional(),
  statusReason: z.string(),
  statusSources: statusSourcesSchema,
  /**
   * `isActive: true` means the item is in a normal in-flight state —
   * agent has done its part, PR is open, and develop is expected to lag
   * until merge. The UI should show this as "in progress" rather than
   * "drift warning". `hasDrift` remains `false` in this case.
   */
  isActive: z.boolean().optional(),
  hasDrift: z.boolean(),
  driftDetails: z.array(z.string()).optional(),
  recentExecutionIds: z.array(z.string()).optional(),
  /**
   * Normalized success rate in [0, 1] aggregated across the item's
   * lifetime. MVP: `1` when the item reaches `completed`, `0` on
   * `failed`/`cancelled`/`rejected`/`duplicate`. Intermediate values
   * may surface from review-loop activity (negative comments, retries,
   * iteration count) once the metric extends. Used as the dominant
   * per-item health signal in the App UI.
   */
  successScore: z.number().min(0).max(1).optional(),
});

export type WorkItemEntry = z.infer<typeof workItemEntrySchema>;
