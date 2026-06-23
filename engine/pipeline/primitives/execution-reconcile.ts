import type {
  OperationContext, KVStore, ExecutionEntry, VCSPlatform, ConventionsConfig,
} from "@operator/core";
import { errorMessage } from "@operator/core";
import type { Logger } from "../../logging/logger.js";

/**
 * Default wall-clock ceiling for a single stage run. Any `executions/*`
 * row still in `status: "running"` this long after `startedAt` is
 * considered stuck — either the daemon crashed mid-cycle, the agent
 * process hung past its own timeout, or a signal killed the node
 * worker before `finalize()` could write the terminal row.
 *
 * 2 hours is chosen to comfortably exceed the longest healthy stage
 * (agent timeout 60min + verify 2min + review 10min + overhead) while
 * still recovering a stuck row within the same working day.
 */
const DEFAULT_STUCK_THRESHOLD_MS = 2 * 60 * 60 * 1000;

export interface ReconcileOptions {
  /** Milliseconds since `startedAt` above which a `running` row is stuck. */
  readonly stuckAfterMs?: number;
  /** Injection point for tests. Defaults to `Date.now()`. */
  readonly now?: () => number;
}

export interface ReconcileResult {
  readonly scanned: number;
  readonly reconciled: number;
  readonly skipped: number;
}

/**
 * Scan `kv:executions/*` and finalise any row stuck in `status:
 * "running"` past {@link stuckAfterMs}. Each reconciled row is updated
 * in place with `status: "timed-out"`, `finishedAt: now`, a
 * `durationMs`, and a diagnostic `error` so the UI can distinguish
 * auto-timeouts from stages that failed through normal channels.
 *
 * Idempotent — running twice does the same thing on second pass for
 * any rows that became stuck between runs, and is a no-op for rows
 * already reconciled (status is no longer `"running"`).
 */
export async function reconcileStuckExecutions(
  kv: KVStore,
  opts: ReconcileOptions,
  ctx: OperationContext,
  log?: Logger,
): Promise<ReconcileResult> {
  const stuckAfterMs = opts.stuckAfterMs ?? DEFAULT_STUCK_THRESHOLD_MS;
  const nowMs = (opts.now ?? Date.now)();
  const nowIso = new Date(nowMs).toISOString();

  const rows = await kv.list("executions");
  let reconciled = 0;
  let skipped = 0;

  for (const row of rows) {
    const entry = row.value as ExecutionEntry | undefined;
    if (!entry || entry.status !== "running") continue;

    const startedMs = Date.parse(entry.startedAt);
    if (!Number.isFinite(startedMs)) {
      skipped++;
      continue;
    }
    const age = nowMs - startedMs;
    if (age < stuckAfterMs) continue;

    const timedOut: ExecutionEntry = {
      ...entry,
      status: "timed-out",
      finishedAt: nowIso,
      durationMs: age,
      verdict: entry.verdict ?? "failed",
      summary: entry.summary ?? `Execution timed out after ${Math.round(age / 1000)}s without finalizing`,
      error: "stuck-execution-auto-timeout",
    };
    await kv.put("executions", row.key, timedOut, { metadata: row.metadata });
    log?.warn(`execution-reconcile: ${entry.id} → timed-out (age ${Math.round(age / 1000)}s, stage=${entry.stageName})`, {
      executionId: entry.id, stageName: entry.stageName, workItemId: entry.workItemId,
      ageSec: Math.round(age / 1000), thresholdSec: Math.round(stuckAfterMs / 1000),
      traceId: ctx.traceId,
    });
    reconciled++;
  }

  if (reconciled > 0) {
    log?.info(`execution-reconcile: finalised ${reconciled} stuck execution(s) as timed-out`, {
      scanned: rows.length, reconciled, skipped, traceId: ctx.traceId,
    });
  }
  return { scanned: rows.length, reconciled, skipped };
}

export interface OrphanLabelOptions {
  /** Convention labels — used to recognise the active-work bands. */
  readonly conventions: ConventionsConfig;
}

export interface OrphanLabelResult {
  readonly scanned: number;
  readonly reverted: number;
  readonly errors: number;
}

/**
 * Reset open PRs whose label says they are actively being worked but
 * the daemon process that was working them is gone. At boot time no
 * cycle is in flight yet, so any `ai:processing` PR is by definition
 * orphaned — the previous daemon was killed mid-stage before the
 * runStage `finally` block could fire `markFailed` / `markInReview`.
 * Flipping such PRs back to `ai:pending` lets the next cycle's
 * selector pick them up cleanly.
 *
 * Idempotent: when no `ai:processing` PR is present the call is a
 * fast no-op (one paginated open-PR list, no writes).
 */
export async function revertOrphanProcessingLabels(
  vcs: Pick<VCSPlatform, "getCodeReviews" | "addLabel" | "removeLabel">,
  opts: OrphanLabelOptions,
  ctx: OperationContext,
  log?: Logger,
): Promise<OrphanLabelResult> {
  const processingLabel = opts.conventions.labels.processing;
  const pendingLabel = opts.conventions.labels.pending;
  const aiPrefix = `${opts.conventions.branches.aiPrefix}/`;

  const open = await vcs.getCodeReviews({ state: "open" });
  let reverted = 0;
  let errors = 0;
  let scanned = 0;

  for (const pr of open) {
    if (!pr.branch.startsWith(aiPrefix)) continue;
    if (!pr.labels.some((l) => l.name === processingLabel)) continue;
    scanned++;
    try {
      await vcs.removeLabel(pr.id, processingLabel).catch(() => {});
      await vcs.addLabel(pr.id, pendingLabel).catch(() => {});
      log?.warn(`orphan-label: PR #${pr.id} ${processingLabel} → ${pendingLabel} (orphan from prior daemon)`, {
        prNumber: pr.id, branch: pr.branch, traceId: ctx.traceId,
      });
      reverted++;
    } catch (err) {
      log?.error(`orphan-label: failed to revert PR #${pr.id}: ${errorMessage(err)}`, {
        prNumber: pr.id, traceId: ctx.traceId,
      });
      errors++;
    }
  }

  if (reverted > 0) {
    log?.warn(`orphan-label: reverted ${reverted} orphan ${processingLabel} PR(s) to ${pendingLabel}`, {
      scanned, reverted, errors, traceId: ctx.traceId,
    });
  }
  return { scanned, reverted, errors };
}
