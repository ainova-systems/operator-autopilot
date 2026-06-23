import { z } from "zod";
import type { KVStore } from "@operator/core";
import type { ConfigEditEvent, WriteAuditDeps } from "./kv-write";

const CATEGORY = "execution-events";
const KEY_PREFIX = "config-edit/";

/**
 * Zod schema for the `execution-events/config-edit/{seq}` row shape. Used
 * at the read boundary in {@link listAuditLog} so a malformed row surfaces
 * as a typed error instead of silently leaking `unknown`-cast garbage into
 * the UI. The same schema drives the exported {@link AuditLogRow} type.
 */
export const auditLogRowSchema = z.object({
  op: z.literal("config-edit"),
  subOp: z.enum(["put", "delete", "reset"]),
  category: z.string().min(1),
  key: z.string().min(1),
  editor: z.literal("ui"),
  connectionId: z.string().min(1),
  timestamp: z.string().min(1),
  before: z.unknown(),
  after: z.unknown(),
  diff: z.string(),
  versionBefore: z.number().int().nonnegative(),
  versionAfter: z.number().int().nonnegative(),
});

/**
 * Shape persisted under `kv:execution-events/config-edit/{seq}`. Matches
 * the architecture spec: every successful PUT / DELETE / reset on
 * `/api/kv/*` writes one row carrying the before/after payloads plus a
 * stringified diff. Pre-existing execution-event rows written by the
 * engine use a different `op` vocabulary (`stage.completed`, etc.) so
 * `op: "config-edit"` is the unique marker for UI-authored mutations.
 */
export type AuditLogRow = z.infer<typeof auditLogRowSchema>;

/**
 * Typed error raised when a stored audit row fails Zod validation at
 * read time. Surfaces the Zod issues and the offending KV key so the
 * caller (API route, Next.js page) can render a specific diagnostic
 * without inspecting raw zod internals.
 */
export class AuditLogRowInvalidError extends Error {
  readonly code = "AUDIT_LOG_ROW_INVALID";
  constructor(
    readonly key: string,
    readonly issues: z.core.$ZodIssue[],
  ) {
    super(`Audit row ${key} failed validation: ${issues.map((i) => i.message).join("; ")}`);
    this.name = "AuditLogRowInvalidError";
  }
}

/**
 * Create an {@link WriteAuditDeps} bound to the given KVStore. The writer
 * generates monotonically-increasing sequence numbers using the row key
 * `{timestamp}-{random}` — equivalent to a ULID but without adding a dep;
 * ordering by `updated_at` in the UI still works.
 */
export function createAuditWriter(kv: KVStore): WriteAuditDeps {
  return {
    async writeAuditEvent(event: ConfigEditEvent): Promise<void> {
      const seq = `${event.timestamp}-${randomSuffix()}`;
      const key = `${KEY_PREFIX}${seq}`;
      const row: AuditLogRow = {
        op: "config-edit",
        subOp: event.op,
        category: event.category,
        key: event.key,
        editor: event.editor,
        connectionId: event.connectionId,
        timestamp: event.timestamp,
        before: event.before,
        after: event.after,
        diff: event.diff,
        versionBefore: event.versionBefore,
        versionAfter: event.versionAfter,
      };
      await kv.put(CATEGORY, key, row, { metadata: { source: "ui", readonly: false } });
    },
  };
}

function randomSuffix(): string {
  // 6 hex chars — collision-free for human-scale edit rates and avoids a
  // dep on `crypto.randomUUID` (imported by node:crypto) in the audit
  // writer. The timestamp prefix carries the temporal ordering.
  return Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, "0");
}

/**
 * Fetch every config-edit row for UI rendering. Paginates via the KV
 * filter to keep the page responsive when edit volume grows. The result
 * is newest-first (ordered by `updated_at DESC`) and filtered to rows
 * carrying the `config-edit` marker so future `execution-events` kinds
 * (engine-authored `stage.completed` etc.) do not leak into the audit UI.
 */
export interface ListAuditFilter {
  readonly category?: string;
  readonly key?: string;
  readonly limit?: number;
  readonly offset?: number;
}

export async function listAuditLog(kv: KVStore, filter?: ListAuditFilter): Promise<AuditLogRow[]> {
  const entries = await kv.list(CATEGORY, {
    keyPrefix: KEY_PREFIX,
    orderBy: "updated_at",
    order: "desc",
    limit: filter?.limit ?? 100,
    offset: filter?.offset ?? 0,
  });
  // Re-parse at the read boundary — malformed rows (hand-edited SQLite,
  // schema drift across engine versions) produce a typed error instead
  // of silently casting `unknown` into the UI layer.
  const rows: AuditLogRow[] = [];
  for (const entry of entries) {
    const candidate = entry.value;
    if (!isConfigEditMarker(candidate)) {
      // Non-audit rows (engine-authored `stage.completed` etc.) live in
      // the same category. Skip silently — they are expected noise.
      continue;
    }
    const parsed = auditLogRowSchema.safeParse(candidate);
    if (!parsed.success) {
      throw new AuditLogRowInvalidError(entry.key, parsed.error.issues);
    }
    rows.push(parsed.data);
  }
  return rows.filter((r) => {
    if (filter?.category && r.category !== filter.category) return false;
    if (filter?.key && r.key !== filter.key) return false;
    return true;
  });
}

function isConfigEditMarker(candidate: unknown): boolean {
  return (
    typeof candidate === "object" &&
    candidate !== null &&
    (candidate as { op?: unknown }).op === "config-edit"
  );
}
