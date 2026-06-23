/**
 * Build a GitHub PR URL from a repo slug + PR number.
 *
 * Returns `null` when either input is missing so callers can fall back
 * to plain text. Repo slug comes from `kv:repos/{id}.vcs.repo` (shape:
 * `owner/repo`). Platform is hardcoded to github.com — the schema is
 * already locked to GitHub (`platform: literal("github")`).
 */
export function buildPrUrl(
  repoSlug: string | undefined,
  prNumber: number | undefined,
): string | null {
  if (!repoSlug || !prNumber) return null;
  return `https://github.com/${repoSlug}/pull/${prNumber}`;
}

/**
 * Build a `repoId → "owner/repo"` slug lookup from a list of `kv:repos/*` rows.
 *
 * Used by execution / work-item pages to render `#123` PR mentions as live
 * links without storing the URL on every execution row.
 */
export function buildRepoSlugMap(
  rows: ReadonlyArray<{ readonly key: string; readonly value: unknown }>,
): Map<string, string> {
  const map = new Map<string, string>();
  for (const r of rows) {
    const slug = (r.value as { vcs?: { repo?: string } } | null)?.vcs?.repo;
    if (typeof slug === "string" && slug.length > 0) map.set(r.key, slug);
  }
  return map;
}

/** PR state derived from the `kv:work-items/{id}.statusSources.prState`. */
export type PrState = "open" | "merged" | "closed" | "none";

/**
 * Distill the human-meaningful PR lifecycle state for a work item, derived
 * from the `prState` observation. Returns `null` when nothing was observed.
 */
export function workItemPrState(value: unknown): PrState | null {
  const obs = (value as {
    statusSources?: { prState?: { value?: PrState } };
  } | null)?.statusSources?.prState?.value;
  return obs ?? null;
}

/**
 * Computed status of the work item — already reconciled by
 * `status-reconcile.ts` server-side. Mirrors the lifecycle the operator
 * tracks (open PR labels, terminal merge/close states, etc.).
 */
export function workItemStatus(value: unknown): string | null {
  const status = (value as { status?: string } | null)?.status;
  return typeof status === "string" && status.length > 0 ? status : null;
}

/**
 * Derive a success score in {1, 0, null} from a work-item's computed status.
 *
 *   merged                                 → 1   (the only success)
 *   failed | rejected | cancelled |        → 0   (final failure outcomes)
 *   duplicate
 *   pending | in-progress | in-review |    → null (still in flight)
 *   ready-to-merge | reopened
 *   completed                              → 1   (non-PR stage success)
 *
 * `null` means "not yet ready to grade" — UI shows it as a pending dash so
 * statistics counters do not bake the wrong answer in early.
 */
export function deriveScore(workItemStatusValue: string | null | undefined): number | null {
  if (!workItemStatusValue) return null;
  switch (workItemStatusValue) {
    case "merged":
    case "completed":
      return 1;
    case "failed":
    case "rejected":
    case "cancelled":
    case "duplicate":
      return 0;
    default:
      return null;
  }
}

