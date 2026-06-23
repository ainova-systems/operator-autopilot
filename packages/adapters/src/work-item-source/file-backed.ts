import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { dump as yamlDump, load as yamlLoad } from "js-yaml";
import {
  WorkItemSourceError,
  type BodyMergeStrategy,
  type KindRegistry,
  type OperationContext,
  type Priority,
  type WorkItemKind,
  type WorkItemListFilter,
  type WorkItemRecord,
  type WorkItemRef,
  type WorkItemSource,
  type WorkItemStatus,
} from "@operator/core";

/**
 * File-backed implementation of `WorkItemSource`.
 *
 * Translates between the kind-agnostic {@link WorkItemRecord} shape and
 * a per-kind directory of `{idPrefix}{date}-{seq}.md` files with YAML
 * frontmatter. Honours the kind registry's storage policy: every method
 * resolves the directory through `registry.dataDirFor(kind)`, never
 * hard-codes paths.
 *
 * No consumer is wired in F2b — this primitive lands gated until the
 * per-stage AOP appliers (F4 onward) and `WorkItemSourceRouter` (F9)
 * compose it. The colocated test exercises the full surface so
 * ts-prune treats every method as reachable.
 *
 * Boundary clarifications (Phase 5.0 §3.5 hard contract):
 *
 *   - Frontmatter authorship belongs to the orchestrator; this adapter
 *     IS that orchestrator's writer. Stages call `create` /
 *     `updateStatus` / `updateBody` after applying an EMIT record —
 *     never agents directly.
 *   - The adapter never mutates branches or commits. The caller (a
 *     primitive in `engine/pipeline/primitives/`) wraps each call in
 *     a `WorkspaceScope` + commit/push pair so the diff lands in a PR.
 *   - The adapter is stateless beyond its constructor args; constructing
 *     a fresh instance per cycle is cheap and correct.
 */

/** Frontmatter fields written by the adapter. Drives both the
 *  serialiser (`recordToFrontmatter`) and the parser (`parseFrontmatter`)
 *  so the round-trip is symmetric. */
const FRONTMATTER_KEYS = [
  "id",
  "kind",
  "title",
  "status",
  "priority",
  "source",
  "created_at",
  "started_at",
  "completed_at",
  "failed_at",
  "rejected_at",
  "parent_id",
  "depends_on",
  "previous_prs",
  "issue_number",
  "path",
  "status_reason",
] as const;

const TERMINAL_TIMESTAMP_FIELDS: Partial<Record<WorkItemStatus, "completedAt" | "failedAt" | "rejectedAt">> = {
  completed: "completedAt",
  failed: "failedAt",
  rejected: "rejectedAt",
  duplicate: "completedAt",
  merged: "completedAt",
};

interface FrontmatterShape {
  [key: string]: string | number | undefined;
}

export interface FileBackedWorkItemSourceDeps {
  /** Kind registry — drives per-kind data directory + idPrefix lookup. */
  readonly registry: KindRegistry;
  /** Workspace root (e.g. `workspace/repos/<repo-id>`). The adapter
   *  joins `registry.dataDirFor(kind)` against this path. */
  readonly workspacePath: string;
  /** Optional clock injection so tests pin timestamps deterministically. */
  readonly now?: () => Date;
}

/** Translate the typed record into the verbose frontmatter shape we
 *  serialise to YAML. Undefined fields are dropped so files stay clean. */
function recordToFrontmatter(record: WorkItemRecord, statusReason?: string): FrontmatterShape {
  const fm: FrontmatterShape = {};
  fm.id = record.id;
  fm.kind = record.kind;
  fm.title = record.title;
  fm.status = record.status;
  fm.priority = record.priority;
  if (record.source !== undefined) fm.source = record.source;
  if (record.createdAt) fm.created_at = record.createdAt;
  if (record.startedAt) fm.started_at = record.startedAt;
  if (record.completedAt) fm.completed_at = record.completedAt;
  if (record.failedAt) fm.failed_at = record.failedAt;
  if (record.rejectedAt) fm.rejected_at = record.rejectedAt;
  if (record.parentId) fm.parent_id = record.parentId;
  if (record.dependsOn && record.dependsOn.length > 0) fm.depends_on = record.dependsOn.join(",");
  if (record.previousPrs) fm.previous_prs = record.previousPrs;
  if (record.issueNumber !== undefined) fm.issue_number = record.issueNumber;
  if (record.path) fm.path = record.path;
  if (statusReason) fm.status_reason = statusReason;
  // Carry forward any extra fields verbatim.
  if (record.extra) {
    for (const [k, v] of Object.entries(record.extra)) {
      if (!FRONTMATTER_KEYS.includes(k as typeof FRONTMATTER_KEYS[number])) fm[k] = v;
    }
  }
  return fm;
}

function parseFrontmatter(content: string, filePath: string): { fm: Record<string, unknown>; body: string } {
  // Match the v3-era split — first `---\n` opens, second closes.
  const parts = content.split(/^---\s*$/m);
  if (parts.length < 3) {
    throw new WorkItemSourceError(
      "WI_INVALID_FRONTMATTER",
      `Missing YAML frontmatter delimiters in ${filePath}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = yamlLoad(parts[1]);
  } catch (err) {
    throw new WorkItemSourceError(
      "WI_INVALID_FRONTMATTER",
      `YAML parse error in ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new WorkItemSourceError(
      "WI_INVALID_FRONTMATTER",
      `Frontmatter in ${filePath} must be a YAML mapping (got ${Array.isArray(parsed) ? "array" : typeof parsed})`,
    );
  }
  const body = parts.slice(2).join("---").trim();
  return { fm: parsed as Record<string, unknown>, body };
}

function fmToRecord(fm: Record<string, unknown>, body: string, filePath: string): WorkItemRecord {
  const id = String(fm.id ?? basename(filePath, ".md"));
  const kind = (fm.kind ?? fm.type) as WorkItemKind | undefined;
  if (!kind) {
    throw new WorkItemSourceError(
      "WI_INVALID_FRONTMATTER",
      `${filePath}: frontmatter missing required \`kind\` field`,
    );
  }
  const priorityRaw = Number(fm.priority);
  const priority: Priority = Number.isFinite(priorityRaw) && priorityRaw >= 1 && priorityRaw <= 8
    ? (priorityRaw as Priority)
    : 3;
  const status = (fm.status as WorkItemStatus | undefined) ?? "pending";
  const dependsOnRaw = fm.depends_on;
  const dependsOn = typeof dependsOnRaw === "string" && dependsOnRaw.trim()
    ? dependsOnRaw.split(",").map((s) => s.trim()).filter(Boolean)
    : undefined;

  const extra: Record<string, string> = {};
  for (const [k, v] of Object.entries(fm)) {
    if (FRONTMATTER_KEYS.includes(k as typeof FRONTMATTER_KEYS[number])) continue;
    if (k === "type") continue; // legacy alias for `kind`
    if (v === undefined || v === null) continue;
    extra[k] = String(v);
  }

  return {
    id, kind, status, priority, body,
    title: String(fm.title ?? "untitled"),
    source: fm.source !== undefined ? String(fm.source) : undefined,
    createdAt: typeof fm.created_at === "string" ? fm.created_at : "",
    startedAt: typeof fm.started_at === "string" ? fm.started_at : undefined,
    completedAt: typeof fm.completed_at === "string" ? fm.completed_at : undefined,
    failedAt: typeof fm.failed_at === "string" ? fm.failed_at : undefined,
    rejectedAt: typeof fm.rejected_at === "string" ? fm.rejected_at : undefined,
    parentId: typeof fm.parent_id === "string" && fm.parent_id ? fm.parent_id : undefined,
    dependsOn,
    previousPrs: typeof fm.previous_prs === "string" ? fm.previous_prs : undefined,
    issueNumber: typeof fm.issue_number === "number" ? fm.issue_number : (
      typeof fm.issue_number === "string" && /^\d+$/.test(fm.issue_number) ? parseInt(fm.issue_number, 10) : undefined
    ),
    path: typeof fm.path === "string" ? fm.path : undefined,
    extra: Object.keys(extra).length > 0 ? extra : undefined,
  };
}

function serialise(record: WorkItemRecord, statusReason?: string): string {
  const fm = recordToFrontmatter(record, statusReason);
  // js-yaml double-quotes strings with leading digits / colons /
  // slashes; for the work-item shape we tolerate its defaults so the
  // round-trip is stable.
  const yaml = yamlDump(fm, { lineWidth: 200, noRefs: true });
  return `---\n${yaml}---\n\n${record.body.replace(/^\n+/, "")}\n`;
}

export class FileBackedWorkItemSource implements WorkItemSource {
  private readonly registry: KindRegistry;
  private readonly workspacePath: string;
  private readonly now: () => Date;

  constructor(deps: FileBackedWorkItemSourceDeps) {
    this.registry = deps.registry;
    this.workspacePath = deps.workspacePath;
    this.now = deps.now ?? ((): Date => new Date());
  }

  private dirFor(kind: WorkItemKind): string {
    const def = this.registry.get(kind);
    if (!def) {
      throw new WorkItemSourceError("WI_KIND_UNKNOWN", `Kind "${kind}" not registered`);
    }
    return join(this.workspacePath, def.dataDir);
  }

  private filePathFor(kind: WorkItemKind, id: string): string {
    return join(this.dirFor(kind), `${id}.md`);
  }

  async create(item: WorkItemRecord, _ctx: OperationContext): Promise<WorkItemRecord> {
    const dir = this.dirFor(item.kind);
    await mkdir(dir, { recursive: true });
    const path = join(dir, `${item.id}.md`);

    // Idempotency: if a file already exists with the same content hash,
    // return the existing record rather than overwriting. Different
    // content under the same id is a hard error (`WI_DUPLICATE`).
    let existingRecord: WorkItemRecord | null = null;
    try {
      const existing = await readFile(path, "utf-8");
      const { fm, body } = parseFrontmatter(existing, path);
      existingRecord = fmToRecord(fm, body, path);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }

    const stamped: WorkItemRecord = item.createdAt
      ? item
      : { ...item, createdAt: this.now().toISOString() };

    if (existingRecord) {
      if (existingRecord.body.trim() === stamped.body.trim() && existingRecord.title === stamped.title) {
        return existingRecord;
      }
      throw new WorkItemSourceError(
        "WI_DUPLICATE",
        `Work item ${item.id} already exists at ${path} with different content`,
      );
    }

    await writeFile(path, serialise(stamped), "utf-8");
    return { ...stamped, path };
  }

  async read(ref: WorkItemRef, _ctx: OperationContext): Promise<WorkItemRecord | null> {
    const path = this.filePathFor(ref.kind, ref.id);
    try {
      const content = await readFile(path, "utf-8");
      const { fm, body } = parseFrontmatter(content, path);
      return { ...fmToRecord(fm, body, path), path };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
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
        `Work item ${ref.kind}/${ref.id} not found at ${this.filePathFor(ref.kind, ref.id)}`,
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
    const path = this.filePathFor(ref.kind, ref.id);
    await writeFile(path, serialise(next, reason), "utf-8");
    return { ...next, path };
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
        `Work item ${ref.kind}/${ref.id} not found at ${this.filePathFor(ref.kind, ref.id)}`,
      );
    }
    let nextBody: string;
    if (mergeStrategy === "replace") {
      nextBody = body.trim();
    } else {
      // append-section
      const header = sectionHeader && sectionHeader.trim()
        ? `## ${sectionHeader.replace(/^#+\s*/, "")}`
        : "## Update";
      nextBody = `${current.body.trim()}\n\n${header}\n\n${body.trim()}`;
    }
    const next: WorkItemRecord = { ...current, body: nextBody };
    const path = this.filePathFor(ref.kind, ref.id);
    await writeFile(path, serialise(next), "utf-8");
    return { ...next, path };
  }

  async list(filter: WorkItemListFilter, _ctx: OperationContext): Promise<ReadonlyArray<WorkItemRecord>> {
    const def = this.registry.get(filter.kind);
    if (!def) {
      throw new WorkItemSourceError("WI_KIND_UNKNOWN", `Kind "${filter.kind}" not registered`);
    }
    const dir = this.dirFor(filter.kind);
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
    const out: WorkItemRecord[] = [];
    for (const name of entries) {
      if (!name.endsWith(".md")) continue;
      if (!name.startsWith(def.idPrefix)) continue;
      const path = join(dir, name);
      try {
        const content = await readFile(path, "utf-8");
        const { fm, body } = parseFrontmatter(content, path);
        const record = fmToRecord(fm, body, path);
        if (record.kind !== filter.kind) continue;
        if (filter.status && record.status !== filter.status) continue;
        if (filter.parentId && record.parentId !== filter.parentId) continue;
        out.push({ ...record, path });
      } catch (err) {
        if (err instanceof WorkItemSourceError) continue; // skip unparseable file
        throw err;
      }
    }
    out.sort((a, b) => a.id.localeCompare(b.id));
    return out;
  }
}
