import type { VCSPlatform } from "@operator/core";
import type { ConventionsConfig } from "@operator/core";
import { errorMessage } from "@operator/core";
import type { Logger } from "../logging/logger.js";

// ── Core logic ───────────────────────────────────────────────────────

/**
 * Branches without a PR are reaped after this age. Covers the
 * empty-diff retrospective / discovery case where the stage created a
 * branch but persist refused to open a PR (no commits ahead of base).
 */
const ORPHAN_BRANCH_MAX_AGE_HOURS = 24;

/**
 * Delete `ai/*` branches in two cases:
 *   1. PR exists and is merged or closed — branch is no longer needed.
 *   2. No PR exists at all and the branch is older than
 *      {@link ORPHAN_BRANCH_MAX_AGE_HOURS} — empty-diff orphan from a
 *      stage that produced no commits (retrospective .failed marker
 *      identical to base, research with zero findings, etc.). Without
 *      this rule those branches accumulate indefinitely on the remote
 *      and clutter the dashboard.
 */
export async function cleanupBranches(
  vcs: VCSPlatform,
  conventions: ConventionsConfig,
  log?: Logger,
): Promise<number> {
  log?.info(`Scanning for merged/closed/orphan branches`);
  const prefix = `${conventions.branches.aiPrefix}/`;
  const branches = await vcs.listBranches(prefix);
  const prs = await vcs.getCodeReviews({ state: "all" });
  log?.debug(`Found ${branches.length} ai/* branches, ${prs.length} code reviews`);

  let deleted = 0;
  const orphanThresholdMs = ORPHAN_BRANCH_MAX_AGE_HOURS * 60 * 60 * 1000;
  const now = Date.now();

  for (const branch of branches) {
    // Skip init branch (never auto-delete)
    if (branch === conventions.branches.init) continue;

    const pr = prs.find((p) => p.branch === branch);

    // Case 1 — PR exists, terminal state.
    if (pr && (pr.merged || pr.closed)) {
      try {
        await vcs.deleteBranch(branch);
        log?.info(`Deleted branch ${branch} (PR #${pr.id} ${pr.merged ? "merged" : "closed"})`);
        deleted++;
      } catch (err) {
        log?.error(`Failed to delete branch ${branch}: ${errorMessage(err)}`);
      }
      continue;
    }

    // Case 2 — orphan: branch exists but no PR was ever created. Age
    // is read off `getBranchTipCommitTime` when the platform exposes
    // it; otherwise we conservatively skip (the branch will sit until
    // a future cycle where age becomes determinable).
    if (!pr && vcs.getBranchTipCommitTime) {
      try {
        const tipIso = await vcs.getBranchTipCommitTime(branch);
        if (!tipIso) continue;
        const ageMs = now - Date.parse(tipIso);
        if (!Number.isFinite(ageMs) || ageMs < orphanThresholdMs) continue;
        await vcs.deleteBranch(branch);
        log?.warn(`Deleted orphan branch ${branch} (no PR, age ${Math.round(ageMs / 3600_000)}h > ${ORPHAN_BRANCH_MAX_AGE_HOURS}h)`);
        deleted++;
      } catch (err) {
        log?.error(`Failed to age-check or delete orphan branch ${branch}: ${errorMessage(err)}`);
      }
    }
  }

  log?.info(`Deleted ${deleted} branches`);
  return deleted;
}
