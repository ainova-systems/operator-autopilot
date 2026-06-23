import {
  WorkItemSourceError,
  workItemVirtualSchema,
  type BodyMergeStrategy,
  type KVStore,
  type KindRegistry,
  type OperationContext,
  type Priority,
  type WorkItemKind,
  type WorkItemListFilter,
  type WorkItemRecord,
  type WorkItemRef,
  type WorkItemSource,
  type WorkItemStatus,
  type WorkItemVirtualEntry,
} from "@operator/core";

/**
 * Virtual implementation of `WorkItemSource` — backs kinds whose home
 * is the KV store rather than the develop file tree.
 *
 * D-502 / Phase 5.0 §3.4 calls these "virtual outcomes": items that
 * never produce a markdown file under `.operator/data/{kind}/` and
 * never anchor a per-item branch (no `ai/{prefix}/{id}` PR shape).
 * Today's targets: `retrospective-cycle` (the weekly batch identity
 * itself, not the artefact PR), `agent-improvement` (recorded prompt
 * changes), and any future analytics kinds.
 *
 * Reads / writes the `kv:work-items-virtual/{id}` category. Stays
 * separate from `kv:work-items/{id}` (which the file-backed
 * reconciler owns) so the two storage modes never collide on a key.
 *
 * Phase 5.0 F9 — gated until F4+ stages opt their kinds in via
 * `WorkItemSourceRouter`. The colocated test exercises the full
 * surface so ts-prune treats every method as reachable.
 */

const TERMINAL_TIMESTAMP_FIELDS: Partial<Record<WorkItemStatus, "completedAt" | "failedAt" | "rejectedAt">> = {
  completed: "completedAt",
  failed: "failedAt",
  rejected: "rejectedAt",
  duplicate: "completedAt",
  merged: "completedAt",
};

const VIRTUAL_CATEGORY = "work-items-virtual";

export interface VirtualWorkItemSourceDeps {
  readonly kv: KVStore;
  readonly registry: KindRegistry;
  /** Optional clock injection so tests pin timestamps deterministically. */
  readonly now?: () => Date;
}

function entryToRecord(entry: WorkItemVirtualEntry): WorkItemRecord {
  return {
    id: entry.id,
    kind: entry.kind as WorkItemKind,
    title: entry.title,
    body: entry.body,
    status: entry.status,
    priority: entry.priority as Priority,
    source: entry.source,
    createdAt: entry.createdAt,
    startedAt: entry.startedAt,
    completedAt: entry.completedAt,
    failedAt: entry.failedAt,
    rejectedAt: entry.rejectedAt,
    parentId: entry.parentId,
    dependsOn: entry.dependsOn,
    previousPrs: entry.previousPrs,
    issueNumber: entry.issueNumber,
    extra: entry.extra,
  };
}

function recordToEntry(record: WorkItemRecord, statusReason?: string): WorkItemVirtualEntry {
  const entry: WorkItemVirtualEntry = {
    id: record.id,
    kind: record.kind,
    title: record.title,
    body: record.body,
    status: record.status,
    priority: record.priority,
    source: record.source,
    createdAt: record.createdAt,
    startedAt: record.startedAt,
    completedAt: record.completedAt,
    failedAt: record.failedAt,
    rejectedAt: record.rejectedAt,
    parentId: record.parentId,
    dependsOn: record.dependsOn ? [...record.dependsOn] : undefined,
    previousPrs: record.previousPrs,
    issueNumber: record.issueNumber,
    statusReason,
    extra: record.extra ? { ...record.extra } : undefined,
  };
  // Drop undefined fields so KV row stays compact.
  for (const k of Object.keys(entry) as Array<keyof WorkItemVirtualEntry>) {
    if (entry[k] === undefined) delete (entry as Record<string, unknown>)[k];
  }
  return entry;
}

export class VirtualWorkItemSource implements WorkItemSource {
  private readonly kv: KVStore;
  private readonly registry: KindRegistry;
  private readonly now: () => Date;

  constructor(deps: VirtualWorkItemSourceDeps) {
    this.kv = deps.kv;
    this.registry = deps.registry;
    this.now = deps.now ?? ((): Date => new Date());
  }

  private assertKind(kind: WorkItemKind): void {
    if (!this.registry.get(kind)) {
      throw new WorkItemSourceError("WI_KIND_UNKNOWN", `Kind "${kind}" not registered`);
    }
  }

  async create(item: WorkItemRecord, _ctx: OperationContext): Promise<WorkItemRecord> {
    this.assertKind(item.kind);
    const stamped = item.createdAt ? item : { ...item, createdAt: this.now().toISOString() };
    const existing = await this.kv.get(VIRTUAL_CATEGORY, item.id);
    if (existing) {
      const validated = workItemVirtualSchema.parse(existing.value);
      const prior = entryToRecord(validated);
      if (prior.body.trim() === stamped.body.trim() && prior.title === stamped.title) {
        return prior;
      }
      throw new WorkItemSourceError(
        "WI_DUPLICATE",
        `Virtual work item ${item.id} already exists with different content`,
      );
    }
    const entry = recordToEntry(stamped);
    workItemVirtualSchema.parse(entry); // assert shape before writing
    await this.kv.put(VIRTUAL_CATEGORY, item.id, entry);
    return stamped;
  }

  async read(ref: WorkItemRef, _ctx: OperationContext): Promise<WorkItemRecord | null> {
    this.assertKind(ref.kind);
    const row = await this.kv.get(VIRTUAL_CATEGORY, ref.id);
    if (!row) return null;
    let entry: WorkItemVirtualEntry;
    try {
      entry = workItemVirtualSchema.parse(row.value);
    } catch (err) {
      throw new WorkItemSourceError(
        "WI_INVALID_FRONTMATTER",
        `Virtual work item ${ref.id} has invalid stored shape: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (entry.kind !== ref.kind) return null;
    return entryToRecord(entry);
  }

  async updateStatus(
    ref: WorkItemRef,
    status: WorkItemStatus,
    reason: string | undefined,
    ctx: OperationContext,
  ): Promise<WorkItemRecord> {
    const current = await this.read(ref, ctx);
    if (!current) {
      throw new WorkItemSourceError(
        "WI_NOT_FOUND",
        `Virtual work item ${ref.kind}/${ref.id} not found`,
      );
    }
    const stampField = TERMINAL_TIMESTAMP_FIELDS[status];
    const nowIso = this.now().toISOString();
    const next: WorkItemRecord = {
      ...current,
      status,
      startedAt: status === "in-progress" && !current.startedAt ? nowIso : current.startedAt,
      ...(stampField ? { [stampField]: nowIso } : {}),
    };
    const entry = recordToEntry(next, reason);
    workItemVirtualSchema.parse(entry);
    await this.kv.put(VIRTUAL_CATEGORY, ref.id, entry);
    return next;
  }

  async updateBody(
    ref: WorkItemRef,
    body: string,
    mergeStrategy: BodyMergeStrategy,
    sectionHeader: string | undefined,
    ctx: OperationContext,
  ): Promise<WorkItemRecord> {
    const current = await this.read(ref, ctx);
    if (!current) {
      throw new WorkItemSourceError(
        "WI_NOT_FOUND",
        `Virtual work item ${ref.kind}/${ref.id} not found`,
      );
    }
    let nextBody: string;
    if (mergeStrategy === "replace") {
      nextBody = body.trim();
    } else {
      const header = sectionHeader && sectionHeader.trim()
        ? `## ${sectionHeader.replace(/^#+\s*/, "")}`
        : "## Update";
      nextBody = `${current.body.trim()}\n\n${header}\n\n${body.trim()}`;
    }
    const next: WorkItemRecord = { ...current, body: nextBody };
    const entry = recordToEntry(next);
    workItemVirtualSchema.parse(entry);
    await this.kv.put(VIRTUAL_CATEGORY, ref.id, entry);
    return next;
  }

  async list(filter: WorkItemListFilter, _ctx: OperationContext): Promise<ReadonlyArray<WorkItemRecord>> {
    this.assertKind(filter.kind);
    const rows = await this.kv.list(VIRTUAL_CATEGORY);
    const out: WorkItemRecord[] = [];
    for (const row of rows) {
      let entry: WorkItemVirtualEntry;
      try {
        entry = workItemVirtualSchema.parse(row.value);
      } catch {
        continue; // skip malformed rows; never abort listing
      }
      if (entry.kind !== filter.kind) continue;
      if (filter.status && entry.status !== filter.status) continue;
      if (filter.parentId && entry.parentId !== filter.parentId) continue;
      out.push(entryToRecord(entry));
    }
    out.sort((a, b) => a.id.localeCompare(b.id));
    return out;
  }
}
