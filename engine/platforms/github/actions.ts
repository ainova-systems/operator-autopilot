import type { Octokit } from "@octokit/rest";

/**
 * GitHub Actions helpers split out of {@link GitHubVCS} so the adapter file
 * stays focused on the provider-neutral `VCSPlatform` surface. These two
 * functions back the transient-CI retry path:
 *
 *   - {@link reRunFailedJobs}  — re-trigger the failed jobs of a workflow run
 *     (the actual "restart the pipeline" action).
 *   - {@link fetchJobLogTail}  — pull the tail of one job's log so the engine
 *     can tell an infra flake (ECONNRESET, registry 5xx, runner loss) from a
 *     genuine code failure before deciding to re-run vs. engage the agent.
 *
 * Both are best-effort and never throw: a stale/un-re-runnable run or an
 * unavailable log must degrade gracefully, never abort the lifecycle sweep.
 */

/** Cap the per-job log we scan — the transient signal is always near the end. */
export const JOB_LOG_TAIL_BYTES = 16_384;

/**
 * Re-run the failed jobs of each given workflow run. Returns `true` when at
 * least one run was re-triggered. Per-run errors (403 run too old, 422 not
 * re-runnable, already re-running, 404) are swallowed so one stale run never
 * blocks retrying the others. Logs the count via the optional `log` callback.
 */
export async function reRunFailedJobs(
  octokit: Octokit,
  owner: string,
  repo: string,
  runIds: ReadonlyArray<number>,
  log?: (runId: number, ok: boolean, err?: unknown) => void,
): Promise<boolean> {
  let any = false;
  for (const runId of new Set(runIds)) {
    try {
      await octokit.rest.actions.reRunWorkflowFailedJobs({ owner, repo, run_id: runId });
      any = true;
      log?.(runId, true);
    } catch (err) {
      // Run too old, already re-running, or not re-runnable — try the rest.
      log?.(runId, false, err);
    }
  }
  return any;
}

/**
 * Fetch the tail of a single job's plain-text log, bounded to
 * {@link JOB_LOG_TAIL_BYTES}. GitHub responds with a redirect to a
 * short-lived log URL; Octokit follows it and exposes the text as
 * `response.data`. Returns `undefined` on any failure or empty body —
 * the caller treats absence as "not provably transient".
 */
export async function fetchJobLogTail(
  octokit: Octokit,
  owner: string,
  repo: string,
  jobId: number,
): Promise<string | undefined> {
  try {
    const res = await octokit.rest.actions.downloadJobLogsForWorkflowRun({
      owner, repo, job_id: jobId,
    });
    const data = (res as { data?: unknown }).data;
    const text = typeof data === "string" ? data : data == null ? "" : String(data);
    if (!text) return undefined;
    return text.length > JOB_LOG_TAIL_BYTES ? text.slice(-JOB_LOG_TAIL_BYTES) : text;
  } catch {
    return undefined;
  }
}
