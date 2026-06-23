import type { WorkItemKind, WorkItemStatus } from "../types/domain.js";
import type { OperationContext } from "../types/context.js";
import type { Priority } from "../types/domain.js";

/**
 * Kind-agnostic CRUD over Work Items, regardless of storage backend.
 *
 * Two implementations:
 *   - `FileBackedWorkItemSource` — reads/writes markdown files in the
 *     active workspace branch. Used by file+git kinds (finding/task/...).
 *   - `VirtualWorkItemSource` — reads/writes JSON in the KVStore
 *     (`kv:work-items/...`). Used by virtual kinds (retrospective-cycle,
 *     agent-improvement, ...).
 *
 * Stage code never branches on storage mode — it composes a source via
 * `WorkItemSourceRouter.fromKind(kind)` (F9) and calls the same API.
 */

/** Stable lightweight reference to a Work Item. */
export interface WorkItemRef {
  readonly id: string;
  readonly kind: WorkItemKind;
}

/**
 * Canonical Work Item shape used at the source boundary. Mirrors the
 * file-frontmatter shape used by `engine/work-items/work-items.ts` so
 * file-backed sources can re-use the existing parser. Virtual sources
 * still produce this shape regardless of where the data is stored.
 */
export interface WorkItemRecord {
  readonly id: string;
  readonly kind: WorkItemKind;
  readonly title: string;
  readonly body: string;
  readonly status: WorkItemStatus;
  readonly priority: Priority;
  readonly source?: string;
  readonly createdAt: string;
  readonly startedAt?: string;
  readonly completedAt?: string;
  readonly failedAt?: string;
  readonly rejectedAt?: string;
  readonly parentId?: string;
  readonly dependsOn?: ReadonlyArray<string>;
  readonly previousPrs?: string;
  readonly issueNumber?: number;
  readonly path?: string;
  /** Free-form additional frontmatter fields kept verbatim. */
  readonly extra?: Readonly<Record<string, string>>;
}

/** Strategy when an EMIT body-update event is applied. */
export type BodyMergeStrategy = "replace" | "append-section";

/**
 * Filter for {@link WorkItemSource.list}. `kind` is required because
 * file-backed sources resolve to a single per-kind directory; virtual
 * sources scope to a single category.
 */
export interface WorkItemListFilter {
  readonly kind: WorkItemKind;
  readonly status?: WorkItemStatus;
  readonly parentId?: string;
}

/**
 * Single CRUD interface every storage backend implements. All methods
 * take `OperationContext` so cancellation, budget, and tracing work
 * uniformly across file + virtual modes.
 */
export interface WorkItemSource {
  /**
   * Create a new Work Item record. The implementation is responsible
   * for honouring the kind's storage policy (file write + git-stage,
   * or KV `put`). Idempotent on identical content.
   */
  create(item: WorkItemRecord, ctx: OperationContext): Promise<WorkItemRecord>;

  /**
   * Load a Work Item by ref. Returns `null` when the record is
   * absent — callers must handle missing items explicitly.
   */
  read(ref: WorkItemRef, ctx: OperationContext): Promise<WorkItemRecord | null>;

  /**
   * Transition the lifecycle status. `reason` is persisted alongside
   * the status (frontmatter field for file-backed; JSON property for
   * virtual). Throws `WorkItemSourceError("WI_NOT_FOUND")` when ref
   * does not resolve.
   */
  updateStatus(
    ref: WorkItemRef,
    status: WorkItemStatus,
    reason: string | undefined,
    ctx: OperationContext,
  ): Promise<WorkItemRecord>;

  /**
   * Replace the markdown body, or append a `## sectionHeader` block
   * when `mergeStrategy === "append-section"`. Frontmatter is
   * preserved unchanged.
   */
  updateBody(
    ref: WorkItemRef,
    body: string,
    mergeStrategy: BodyMergeStrategy,
    sectionHeader: string | undefined,
    ctx: OperationContext,
  ): Promise<WorkItemRecord>;

  /**
   * List records matching the filter. Implementations MAY enforce a
   * sane upper bound and return a truncated list with a diagnostic
   * (file-backed scans the directory; virtual lists the KV category).
   */
  list(
    filter: WorkItemListFilter,
    ctx: OperationContext,
  ): Promise<ReadonlyArray<WorkItemRecord>>;
}

/**
 * Router that selects the right {@link WorkItemSource} for a given
 * kind, driven by the kind registry's `storage.mode`. Lands in F9 with
 * `VirtualWorkItemSource`; F2 ships only the file-backed branch and
 * the router falls through to it for any registered kind.
 */
export interface WorkItemSourceRouter {
  forKind(kind: WorkItemKind): WorkItemSource;
}
