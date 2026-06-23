import type { CodeReview, KVStore, OperationContext, PrStateCacheEntry } from "@operator/core";

/**
 * PR-state cache primitive — preserves terminal-state facts per
 * `prNumber` so the App UI can show historical PR states even after
 * the work-item observation overwrites with a newer PR.
 *
 * Why this exists: `kv:work-items/{id}.statusSources.prState` only
 * tracks the latest PR on a branch. When a branch had multiple PRs
 * (`#780 merged → #808 merged → #820 closed`), the work-item only
 * remembers `#820 closed` — the merged history is lost. This cache
 * upserts a row per terminal PR seen, keyed by PR number, so the App
 * can resolve `prNumber → state` reliably for any execution row.
 *
 * Write rules:
 *   - Only terminal PRs (`closed: true`, either merged or closed-no-merge).
 *   - Open PRs are ignored — their state is always live.
 *   - `merged` is final and never overwritten (GitHub does not unmerge).
 *   - `closed` may be re-observed and overwritten by a newer terminal
 *     observation — but in practice each PR's terminal state stabilises.
 */

export type CachedPrState = "merged" | "closed";

/**
 * Upsert cache rows for every terminal PR in the supplied list. No-op
 * for open PRs. Idempotent: re-running with the same input does not
 * change the existing `merged` rows.
 */
export async function recordTerminalPRStates(
  prs: ReadonlyArray<CodeReview>,
  kv: KVStore,
  ctx: OperationContext,
): Promise<void> {
  for (const pr of prs) {
    if (!pr.closed) continue;
    const key = String(pr.id);
    const existing = await kv.get("pr-states", key);
    const existingState = (existing?.value as { state?: string } | undefined)?.state;
    if (existingState === "merged") continue;
    const state: CachedPrState = pr.merged ? "merged" : "closed";
    const row: PrStateCacheEntry = {
      prNumber: pr.id,
      state,
      branch: pr.branch,
      title: pr.title,
      mergedAt: pr.merged ? pr.updatedAt : undefined,
      closedAt: !pr.merged ? pr.updatedAt : undefined,
      observedAt: new Date().toISOString(),
    };
    await kv.put("pr-states", key, row);
  }
  void ctx;
}

/**
 * Read a single PR's cached state. Returns `null` when the PR has
 * never been observed in a terminal state. Open PRs always return
 * `null` here; callers must consult the live work-item observation
 * for "current" state.
 */
export async function readCachedPRState(
  kv: KVStore,
  prNumber: number,
): Promise<PrStateCacheEntry | null> {
  const entry = await kv.get("pr-states", String(prNumber));
  if (!entry) return null;
  const v = entry.value as PrStateCacheEntry;
  return v;
}
