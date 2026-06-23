import type { KindDefinition } from "../schemas/work-item-kind.schema.js";
import type { WorkItemKind, WorkItemStatus } from "../types/domain.js";

/**
 * Open kind registry (architecture-v5.md §8).
 *
 * Backs `WorkItem.kind` — an open string — with the metadata stored in
 * `kv:work-item-kinds/{name}`. Replaces the per-kind helpers that existed
 * in v4 (`isFindingTerminal`, `isTaskTerminal`, `generateFindingId`,
 * `generateTaskId`). Adding a new kind = one YAML row + reseed; no code
 * changes.
 *
 * Contract:
 * - `all` / `get` read from the in-memory snapshot loaded at engine boot.
 * - `isTerminal` / `labelFor` / `branchPrefixFor` / `dataDirFor` look up
 *   the kind entry and project a single field — pure functions over the
 *   registry state.
 * - `generateId` mints a globally-unique-by-construction id with no
 *   filesystem or counter scan. Format: `{idPrefix}{date}-{8 hex chars}`
 *   (e.g. `F20260521-9F3A1C7D`). Parent linkage belongs on
 *   `WorkItem.parentId`, not in the ID string.
 */
export interface KindRegistry {
  /** All loaded kind definitions — cheap snapshot for UI + iteration. */
  readonly all: readonly KindDefinition[];
  /** Lookup by kind name. Returns `undefined` when the kind is unknown. */
  get(kind: WorkItemKind): KindDefinition | undefined;
  /** `true` when `status` is listed in the kind's `terminalStatuses`. */
  isTerminal(kind: WorkItemKind, status: WorkItemStatus): boolean;
  /**
   * Mint a globally-unique id for a kind: `{idPrefix}{date}-{8 hex chars}`.
   * The random suffix makes the id collision-resistant by construction —
   * no filesystem or counter scan — so two planners running on sibling
   * feature branches can never mint the same id. (That branch-local scan
   * is exactly what produced the 2026-05-21 add/add merge conflict on a
   * shared work-item file.) `date` defaults to today (YYYYMMDD UTC).
   */
  generateId(kind: WorkItemKind, date?: string): Promise<string>;
  /** Display label — `"Finding"` / `"Task"` / `"Request"` / ... */
  labelFor(kind: WorkItemKind): string;
  /** Branch prefix such as `"ai/findings"` or `"ai/tasks"`. */
  branchPrefixFor(kind: WorkItemKind): string;
  /** Per-kind workspace data directory such as `"findings"` or `"tasks"`. */
  dataDirFor(kind: WorkItemKind): string;
  /**
   * Kinds that may appear as the parent of items of this kind. Returns
   * an empty array for top-level / orphan kinds. Used by stages that
   * spawn children to validate the parent linkage and by the UI to
   * surface aggregated child completion.
   */
  parentKindsFor(kind: WorkItemKind): readonly WorkItemKind[];
  /**
   * Terminal status set for this kind, sourced from the kind config.
   * Replaces global `TERMINAL_STATUSES` constants — `merged` is terminal
   * for PR-bound kinds, `completed` only for kinds that explicitly list
   * it (manual workflows).
   */
  terminalStatusesFor(kind: WorkItemKind): ReadonlySet<WorkItemStatus>;
}
