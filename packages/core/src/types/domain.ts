/**
 * Domain types shared across the engine.
 *
 * `WorkItemKind` is an open string — the set of kinds lives in
 * `kv:work-item-kinds/*`, loaded through {@link KindRegistry}. Adding a new
 * kind = editing `engine/content/prompts/kinds.yaml` + reseeding, no code
 * changes (architecture-v5.md §8.1).
 */
export type WorkItemKind = string;

/**
 * Work item status.
 *
 * The set is broader than what lives in file frontmatter:
 *
 * - **Lifecycle statuses** — `"pending"`, `"in-progress"`, `"completed"`,
 *   `"failed"`, `"cancelled"`, `"rejected"`, `"duplicate"`, `"reopened"`.
 *   These are what appears in `.operator/data/{kind}s/{id}.md` frontmatter
 *   and in the `work_items.status` SQLite cache. Engine business logic
 *   (selectors, context building, rejection handler) reads these values.
 *
 * - **Computed statuses** — `"in-review"`, `"ready-to-merge"`. These are
 *   produced ONLY by `reconcileEffectiveStatus` and written into the
 *   UI-facing `kv:work-items/{id}.status` column (the computed slot — see
 *   `work-item.schema.ts` for the field mapping). File frontmatter and
 *   StateManager rows never hold these values.
 *
 * `isTerminal(kind, status)` returns `false` for both computed statuses —
 * a PR under review or waiting on a human merge is not "done".
 */
export type WorkItemStatus =
  | "pending"
  | "in-progress"
  | "completed"
  | "failed"
  | "cancelled"
  | "rejected"
  | "duplicate"
  | "reopened"
  | "in-review"
  | "ready-to-merge"
  | "merged"
  | "accepted";

export type Priority = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;

export interface Label {
  readonly name: string;
  readonly color?: string;
  readonly description?: string;
}

export interface Comment {
  readonly id: string;
  readonly author: string;
  readonly body: string;
  readonly createdAt: string;
  readonly updatedAt?: string;
  /** File path for inline review comments (diff comments). */
  readonly path?: string;
  /** GitHub author association: OWNER, MEMBER, COLLABORATOR, CONTRIBUTOR, etc. */
  readonly authorAssociation?: string;
  /** GitHub account type: "User" for humans, "Bot" for GitHub Apps. */
  readonly authorType?: "User" | "Bot";
}

export interface CodeReview {
  readonly id: number;
  readonly title: string;
  readonly url: string;
  readonly branch: string;
  readonly baseBranch: string;
  readonly draft: boolean;
  readonly labels: Label[];
  readonly comments: Comment[];
  readonly merged: boolean;
  readonly closed: boolean;
  /**
   * ISO timestamp of the last activity on the PR — comment, label
   * change, push, etc. Provided by platforms that expose it (GitHub
   * `updated_at`); used by `pr-lifecycle` to compute idle-hours.
   */
  readonly updatedAt?: string;
}

export interface WorkItem {
  readonly id: string;
  /** Open string-based kind — see {@link WorkItemKind} and {@link KindRegistry}. */
  readonly kind: WorkItemKind;
  readonly title: string;
  readonly body: string;
  readonly status: WorkItemStatus;
  readonly priority: Priority;
  readonly source?: string;
  readonly branch?: string;
  readonly codeReviewId?: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  /**
   * Optional parent work-item id. Generic linkage — replaces the
   * finding-specific `findingRefs`. The kind registry (`parentKinds`
   * field) declares which kinds may legally appear as a parent for
   * this item's kind. ID format is opaque (today: `T20260427-0001`,
   * future: UUID/GUID under cloud storage).
   */
  readonly parentId?: string;
  /**
   * Monotonically-increasing count of terminal-failure stage executions
   * targeting this item — incremented by `route-verdict` whenever a
   * stage produces verdict ∈ {failed, rejected, cancelled}. Approved
   * verdicts leave the counter untouched. Per-item selectors filter
   * items with `attemptCount >= MAX_ATTEMPTS_PER_ITEM` (default 2) to
   * stop infinite re-pick loops on items the agent cannot resolve
   * (e.g., planner repeatedly rejects the same finding). Reset is a
   * human action via the UI; the engine never decrements.
   */
  readonly attemptCount?: number;
}
