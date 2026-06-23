import type { VCSPlatform } from "@operator/core";

/**
 * Find open code review ID for a branch. Returns null if none found.
 * Extracted from finding-execute.ts and task-execute.ts (identical duplicates).
 */
export async function findCodeReviewForBranch(
  vcs: VCSPlatform,
  branch: string,
): Promise<number | null> {
  const prs = await vcs.getCodeReviews();
  const pr = prs.find((p) => p.branch === branch && !p.closed);
  return pr ? pr.id : null;
}

/**
 * Count active work item PRs matching a branch prefix.
 * Generalizes countActiveFindings and countActiveTasks.
 */
export async function countActivePRs(
  vcs: VCSPlatform,
  branchPrefix: string,
): Promise<number> {
  const prs = await vcs.getCodeReviews();
  return prs.filter((pr) => pr.branch.startsWith(branchPrefix) && !pr.closed).length;
}

/**
 * Build a trailing markdown link to the current CI run for failure/unexpected
 * PR comments. Returns an empty string unless both the project-level debug
 * flag and a populated run URL are provided — so the helper is safe to call
 * unconditionally from stages that may run in local dev, dry-run, or CI.
 *
 * Pattern:
 *   `Task X failed...` + formatDebugRunLinkSuffix(deps) → adds a two-newline
 *   "[Pipeline run](<url>)" tail when the operator runs inside GitHub Actions
 *   and the repo has opted in via `debug: true` in repos.yaml.
 */
export function formatDebugRunLinkSuffix(
  debug: boolean | undefined,
  runUrl: string | undefined,
): string {
  if (!debug || !runUrl) return "";
  return `\n\n[Pipeline run](${runUrl})`;
}
