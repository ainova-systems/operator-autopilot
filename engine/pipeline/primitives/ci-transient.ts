import type { CheckRun, VCSPlatform } from "@operator/core";
import type { Logger } from "../../logging/logger.js";

/**
 * Transient (infra/network) CI failure detection.
 *
 * A failing PR check is "transient" when the failure is in the CI plumbing,
 * not in the PR's code: an `npm ci` socket reset, a registry 5xx, a Docker
 * pull timeout, a lost runner. The right response to those is to RE-RUN the
 * pipeline — not to wake the fix agent, which would hunt for a non-existent
 * code bug and burn its retry budget (then escalate to `ai:failed`).
 *
 * Detection is deliberately conservative. The aggregate failure is classed
 * `transient` only when EVERY failing check shows a transient signal; if any
 * one failing check looks like a genuine code/test failure, the whole set is
 * `code` and goes to the agent. A real failure is never masked by a
 * co-occurring flake. When a check carries no inline signal we fetch the tail
 * of its job log (the ECONNRESET line lives in the log, not in the check's
 * `output.summary`); absence of any log signal counts as "not transient".
 */

/** Check-run conclusions that count as a hard failure. */
const FAILING_CONCLUSIONS: ReadonlySet<string> = new Set([
  "failure", "timed_out", "action_required", "startup_failure",
]);

export function isFailingConclusion(conclusion: string | undefined | null): boolean {
  return FAILING_CONCLUSIONS.has((conclusion ?? "").toLowerCase());
}

/**
 * Infra/network failure signatures. Curated to match CI plumbing errors, not
 * application errors — kept narrow on purpose so a real failure that merely
 * mentions "timeout" in a test name is not mistaken for a flake. Extend this
 * list (with a test) when a new transient class shows up in the wild.
 */
export const TRANSIENT_CI_PATTERNS: ReadonlyArray<RegExp> = [
  /ECONNRESET/i,
  /ETIMEDOUT/i,
  /ECONNREFUSED/i,
  /EAI_AGAIN/i,
  /ENETUNREACH/i,
  /EHOSTUNREACH/i,
  /socket hang ?up/i,
  /network (?:aborted|timeout|error|connectivity)/i,
  /connection reset(?: by peer)?/i,
  /could not resolve host/i,
  /temporary failure in name resolution/i,
  /getaddrinfo (?:EAI_AGAIN|ENOTFOUND)/i,
  /(?:bad gateway|gateway time-?out|service unavailable)/i,
  /\b(?:429|500|502|503|504)\b[^\n]*?(?:bad gateway|gateway time-?out|service unavailable|internal server error|too many requests|server error)/i,
  /the runner has received a shutdown signal/i,
  /lost communication with the (?:server|runner)/i,
  /the (?:hosted )?runner.*(?:lost|disconnect)/i,
  /tls (?:handshake|connection) (?:timeout|error|failed)/i,
  /i\/o timeout/i,
  /context deadline exceeded/i,
  /failed to (?:pull|fetch)[^\n]*?(?:timeout|connection reset|tls|i\/o|temporarily)/i,
  /dial tcp[^\n]*?(?:timeout|refused)/i,
  /unexpected eof/i,
  /remote end hung up unexpectedly/i,
  /rate limit/i,
];

/** True when any transient signature appears in the supplied text. */
export function matchesTransient(text: string): boolean {
  if (!text) return false;
  return TRANSIENT_CI_PATTERNS.some((re) => re.test(text));
}

export interface ClassifyFailureModeDeps {
  /** Provides the job-log tail used when a check carries no inline signal. */
  readonly vcs: Pick<VCSPlatform, "getJobLogTail">;
  readonly log?: Logger;
}

/**
 * Classify a set of failing checks as `"transient"` or `"code"`. Returns
 * `"code"` for an empty set (defensive — callers only invoke this when the
 * aggregate is failing). Fetches a job-log tail only for checks whose inline
 * text shows no signal, so the common (already-annotated) case costs no extra
 * API calls.
 */
export async function classifyChecksFailureMode(
  failing: ReadonlyArray<CheckRun>,
  deps: ClassifyFailureModeDeps,
): Promise<"transient" | "code"> {
  if (failing.length === 0) return "code";

  for (const check of failing) {
    const inline = [check.title, check.summary, check.text].filter(Boolean).join("\n");
    let evidence = inline;

    if (!matchesTransient(evidence) && typeof check.jobId === "number" && deps.vcs.getJobLogTail) {
      const logTail = await deps.vcs.getJobLogTail(check.jobId);
      if (logTail) evidence = inline ? `${inline}\n${logTail}` : logTail;
    }

    if (!matchesTransient(evidence)) {
      deps.log?.debug(`ci-transient: check "${check.name}" shows no transient signal — treating failure as code`, {
        scope: "ci-transient", check: check.name, jobId: check.jobId, conclusion: check.conclusion,
      });
      return "code";
    }
  }

  deps.log?.info(`ci-transient: all ${failing.length} failing check(s) look like infra flakes — eligible for pipeline re-run`, {
    scope: "ci-transient", failingCount: failing.length,
    checks: failing.map((c) => c.name).join(", "),
  });
  return "transient";
}
