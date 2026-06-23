import type { KVMetadata, KVStore } from "@operator/core";
import { kvSchemas, type KVCategory, metadataSchema } from "@operator/core";
import { ZodError, type ZodTypeAny } from "zod";

/**
 * Outcome envelope shared by every `/api/kv/*` write route. Exactly one of
 * `ok: true` + `result` or `ok: false` + `status` + `body` is populated, so
 * the route handler can forward it into `NextResponse.json` without a
 * second branching step.
 */
export type WriteOutcome<T> =
  | { readonly ok: true; readonly result: T }
  | { readonly ok: false; readonly status: number; readonly body: Record<string, unknown> };

export interface WriteAuditDeps {
  /**
   * Emit one `kv:execution-events/config-edit/{seq}` row for a successful
   * mutation. Implementations are expected to capture the full before/after
   * value plus a stringified diff for the audit trail.
   */
  readonly writeAuditEvent: (event: ConfigEditEvent) => Promise<void>;
}

export interface ConfigEditEvent {
  readonly category: string;
  readonly key: string;
  readonly op: "put" | "delete" | "reset";
  readonly editor: "ui";
  readonly connectionId: string;
  readonly before: unknown;
  readonly after: unknown;
  readonly diff: string;
  readonly timestamp: string;
  readonly versionBefore: number;
  readonly versionAfter: number;
}

/**
 * Maximum accepted payload size. Bodies that exceed this threshold are
 * rejected with HTTP 413 — the JSON editor UI shows the same message.
 * Keeping the cap tight (100 KB per row) matches the KV's intended
 * "structured config" role; large blobs belong in a file on disk.
 */
export const MAX_ROW_BYTES = 100 * 1024;

/**
 * Check that `category` is a known KV write surface. Returns the Zod
 * schema for that category or `null` when the category is not listed in
 * `kvSchemas`. Unknown categories produce HTTP 404 at the route level.
 */
export function schemaForCategory(category: string): ZodTypeAny | null {
  return (kvSchemas as Record<string, ZodTypeAny>)[category] ?? null;
}

export function isKnownCategory(category: string): category is KVCategory {
  return category in kvSchemas;
}

/**
 * Extract the existing `version` (default 0) from a KV row's metadata.
 * Step 16 introduces the counter at write time; rows seeded before this
 * step land without `version`, which we treat as 0.
 */
export function currentVersion(meta: KVMetadata | undefined): number {
  return meta?.version ?? 0;
}

/**
 * Compute a compact human-readable diff between two JSON values. The
 * output is suitable for the audit log card and for eyeballing in
 * `sqlite3` — it is NOT machine-parseable. Large diffs are capped at
 * 4 KB so runaway edits cannot blow up the event store.
 */
export function diffJson(before: unknown, after: unknown): string {
  const bStr = pretty(before);
  const aStr = pretty(after);
  if (bStr === aStr) return "(no change)";
  const combined = `--- before\n${bStr}\n+++ after\n${aStr}`;
  return combined.length > 4096 ? `${combined.slice(0, 4093)}...` : combined;
}

function pretty(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export interface PutArgs {
  readonly kv: KVStore;
  readonly category: string;
  readonly key: string;
  readonly value: unknown;
  readonly expectedVersion: number | null;
  readonly connectionId: string;
  readonly audit: WriteAuditDeps;
}

export interface PutSuccess {
  readonly category: string;
  readonly key: string;
  readonly metadata: KVMetadata;
  readonly value: unknown;
}

/**
 * Core PUT handler shared by the route at `/api/kv/[category]/[key]`. Pure
 * and route-framework-free so the unit tests can exercise every branch
 * without spinning up Next.js.
 *
 * Returns `{ ok, result }` on success or `{ ok, status, body }` on
 * validation / permission / concurrency failure.
 */
export async function applyPut({
  kv, category, key, value, expectedVersion, connectionId, audit,
}: PutArgs): Promise<WriteOutcome<PutSuccess>> {
  const schema = schemaForCategory(category);
  if (!schema) {
    return { ok: false, status: 404, body: { error: `Unknown category: ${category}` } };
  }

  const payloadSize = Buffer.byteLength(JSON.stringify(value), "utf-8");
  if (payloadSize > MAX_ROW_BYTES) {
    return {
      ok: false,
      status: 413,
      body: { error: `Payload exceeds ${MAX_ROW_BYTES}-byte limit`, bytes: payloadSize },
    };
  }

  let parsed: unknown;
  try {
    parsed = schema.parse(value);
  } catch (err) {
    if (err instanceof ZodError) {
      return {
        ok: false,
        status: 400,
        body: { error: "Validation failed", issues: err.issues },
      };
    }
    throw err;
  }

  const existing = await kv.get(category, key);
  const meta = existing?.metadata;
  if (meta?.readonly) {
    return { ok: false, status: 403, body: { error: `Row ${category}/${key} is readonly` } };
  }

  const versionBefore = currentVersion(meta);
  if (expectedVersion !== null && expectedVersion !== versionBefore) {
    return {
      ok: false,
      status: 409,
      body: {
        error: "Version conflict",
        expectedVersion,
        currentVersion: versionBefore,
      },
    };
  }

  const nextMeta: KVMetadata = buildNextMetadata(meta, versionBefore + 1);
  await kv.put(category, key, parsed, { metadata: nextMeta });

  console.info(
    `kv-write: ${category}/${key} by ${connectionId} version ${versionBefore}→${versionBefore + 1}`,
  );

  await audit.writeAuditEvent({
    category,
    key,
    op: existing ? "put" : "put",
    editor: "ui",
    connectionId,
    before: existing?.value ?? null,
    after: parsed,
    diff: diffJson(existing?.value ?? null, parsed),
    timestamp: new Date().toISOString(),
    versionBefore,
    versionAfter: versionBefore + 1,
  });

  return {
    ok: true,
    result: {
      category, key,
      metadata: nextMeta,
      value: parsed,
    },
  };
}

export interface DeleteArgs {
  readonly kv: KVStore;
  readonly category: string;
  readonly key: string;
  readonly connectionId: string;
  readonly audit: WriteAuditDeps;
}

export async function applyDelete({
  kv, category, key, connectionId, audit,
}: DeleteArgs): Promise<WriteOutcome<{ category: string; key: string }>> {
  if (!isKnownCategory(category)) {
    return { ok: false, status: 404, body: { error: `Unknown category: ${category}` } };
  }
  const existing = await kv.get(category, key);
  if (!existing) {
    return { ok: false, status: 404, body: { error: `Row ${category}/${key} not found` } };
  }
  if (existing.metadata?.readonly) {
    return { ok: false, status: 403, body: { error: `Row ${category}/${key} is readonly` } };
  }
  const versionBefore = currentVersion(existing.metadata);
  await kv.delete(category, key);
  console.info(`kv-delete: ${category}/${key} by ${connectionId} version ${versionBefore}`);
  await audit.writeAuditEvent({
    category,
    key,
    op: "delete",
    editor: "ui",
    connectionId,
    before: existing.value,
    after: null,
    diff: diffJson(existing.value, null),
    timestamp: new Date().toISOString(),
    versionBefore,
    versionAfter: versionBefore,
  });
  return { ok: true, result: { category, key } };
}

/**
 * Build the metadata for the next revision of a row. Preserves `source`
 * (a row authored from the UI keeps `source: "ui"`, a seeded-baseline row
 * switches to `source: "ui"` the moment it is edited through the API so
 * the UI badge tracks authorship), sets `readonly: false` on UI writes
 * (yaml-sourced rows short-circuit earlier), and flips
 * `modifiedFromBaseline: true` for rows that originated from
 * `engine/content/`.
 */
function buildNextMetadata(prev: KVMetadata | undefined, nextVersion: number): KVMetadata {
  const wasBaseline = prev?.source === "content";
  const wasYaml = prev?.source === "yaml";
  return {
    // First UI edit of a YAML-sourced row CLAIMS ownership: source
    // flips to `ui` so subsequent boots' seed-mirror leaves the row
    // alone (relaxed yaml-mirror semantics shipped 2026-05-20 —
    // `config/repos.yaml` becomes a starting template, not the ongoing
    // source of truth, once the UI takes over). Content-sourced rows
    // KEEP `source: "content"` because they live alongside
    // `overwriteContentOnBoot: true` — `modifiedFromBaseline: true`
    // (set just below) plus the seed's `isShippedBaseline` filter is
    // what protects UI edits from re-seed, not source flipping.
    source: wasYaml ? "ui" : prev?.source ?? "ui",
    readonly: false,
    modifiedFromBaseline: wasBaseline ? true : prev?.modifiedFromBaseline,
    version: nextVersion,
  };
}

/**
 * Used by the reset-to-baseline route after the baseline value is loaded
 * from `engine/content/`. Writes the value back, flips
 * `modifiedFromBaseline: false`, and emits an audit event.
 */
export interface ResetArgs {
  readonly kv: KVStore;
  readonly category: string;
  readonly key: string;
  readonly baselineValue: unknown;
  readonly connectionId: string;
  readonly audit: WriteAuditDeps;
}

export async function applyReset({
  kv, category, key, baselineValue, connectionId, audit,
}: ResetArgs): Promise<WriteOutcome<PutSuccess>> {
  const schema = schemaForCategory(category);
  if (!schema) {
    return { ok: false, status: 404, body: { error: `Unknown category: ${category}` } };
  }
  const existing = await kv.get(category, key);
  if (!existing) {
    return { ok: false, status: 404, body: { error: `Row ${category}/${key} not found` } };
  }
  // yaml-sourced rows have no shipped baseline (the yaml file IS the
  // starting template and lives outside `engine/content/`). Reset is
  // therefore not supported — flip the row to `ui` via a normal edit
  // first, then reset against the original yaml content if needed.
  if (existing.metadata?.source === "yaml") {
    return {
      ok: false,
      status: 405,
      body: { error: "Cannot reset a yaml-sourced row; edit it via the UI to claim ownership first, or delete and re-seed from config/repos.yaml" },
    };
  }

  let parsed: unknown;
  try {
    parsed = schema.parse(baselineValue);
  } catch (err) {
    if (err instanceof ZodError) {
      return { ok: false, status: 500, body: { error: "Baseline failed schema validation", issues: err.issues } };
    }
    throw err;
  }

  const versionBefore = currentVersion(existing.metadata);
  const nextMeta: KVMetadata = {
    source: "content",
    readonly: false,
    modifiedFromBaseline: false,
    version: versionBefore + 1,
  };
  await kv.put(category, key, parsed, { metadata: nextMeta });
  console.info(
    `kv-reset: ${category}/${key} by ${connectionId} version ${versionBefore}→${versionBefore + 1}`,
  );
  await audit.writeAuditEvent({
    category,
    key,
    op: "reset",
    editor: "ui",
    connectionId,
    before: existing.value,
    after: parsed,
    diff: diffJson(existing.value, parsed),
    timestamp: new Date().toISOString(),
    versionBefore,
    versionAfter: versionBefore + 1,
  });

  return {
    ok: true,
    result: { category, key, metadata: nextMeta, value: parsed },
  };
}

/**
 * Tiny helper to assert a parsed metadata shape — forwards to
 * {@link metadataSchema}. Exported so route-level composition can use
 * the same validation used inside applyPut.
 */
export function parseMetadata(value: unknown): KVMetadata {
  return metadataSchema.parse(value);
}
