import { z } from "zod";

/**
 * Per-PR terminal-state cache.
 *
 * `kv:work-items/{id}.statusSources.prState` only records the LATEST PR
 * observed on the branch. When a branch hosts multiple PRs over its
 * lifetime (e.g. `ai/findings/F20260416-0002` had #780 merged → #808
 * merged → #820 closed), the latest observation forgets that the
 * earlier PRs were merged. This category preserves the per-PR fact
 * keyed by PR number so the App UI can render historical execution
 * rows (`prNumber: 808`) with their actual state (`merged`) instead of
 * inheriting the work-item's most-recent observation.
 *
 * Only **terminal** states are cached:
 *   - `merged` is permanent — GitHub does not unmerge.
 *   - `closed` (without merge) is technically reversible (a closed PR
 *     can be reopened), but in practice our engine only re-records
 *     when the next observation lands; the cache row trails reality
 *     by at most one cycle.
 *
 * Open PRs are intentionally NOT cached: their state is always live
 * (label transitions, comments, CI re-runs); reading the latest
 * observation from `kv:work-items/{id}.statusSources.prState` is
 * authoritative for "the current PR".
 */
export const prStateCacheSchema = z.object({
  prNumber: z.number().int().positive(),
  state: z.enum(["merged", "closed"]),
  branch: z.string().min(1),
  title: z.string().optional(),
  /** ISO timestamp from the platform — when GitHub recorded the merge. */
  mergedAt: z.string().optional(),
  /** ISO timestamp from the platform — when GitHub recorded the close. */
  closedAt: z.string().optional(),
  /** When our engine first wrote this cache row. */
  observedAt: z.string().min(1),
});

export type PrStateCacheEntry = z.infer<typeof prStateCacheSchema>;
