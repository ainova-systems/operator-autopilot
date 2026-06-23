import type { KVMetadata } from "../schemas/_metadata.schema.js";

/**
 * Single row returned by {@link KVStore} queries. `value` is the JSON-decoded
 * payload stored under `(category, key)`. `metadata` is the common envelope
 * (source, readonly, modifiedFromBaseline, version) — see {@link KVMetadata}.
 */
export interface KVEntry {
  readonly key: string;
  readonly value: unknown;
  readonly metadata?: KVMetadata;
}

/**
 * Filter applied by {@link KVStore.list}. All fields are optional.
 *
 * - `keyPrefix` — SQL `key LIKE prefix%` match.
 * - `where` — JSON field equality on the stored value (in-memory filter).
 * - `orderBy` — one of `"key"` or `"updated_at"`. Other values are ignored.
 * - `order` — `"asc"` (default) or `"desc"`.
 * - `limit` / `offset` — pagination.
 */
export interface KVListFilter {
  readonly keyPrefix?: string;
  readonly where?: Record<string, unknown>;
  readonly orderBy?: string;
  readonly order?: "asc" | "desc";
  readonly limit?: number;
  readonly offset?: number;
}

export interface KVPutOptions {
  readonly metadata?: KVMetadata;
  readonly ttlMs?: number;
}

/**
 * Generic key-value store backing all runtime config and execution history.
 *
 * Categories are logical namespaces — `prompts`, `workflow-stages`, `repos`,
 * `executions`, ... Each `(category, key)` pair stores one JSON payload plus
 * an optional {@link KVMetadata} envelope. See architecture-v5.md §5.1.
 */
export interface KVStore {
  get(category: string, key: string): Promise<KVEntry | null>;
  put(category: string, key: string, value: unknown, opts?: KVPutOptions): Promise<void>;
  delete(category: string, key: string): Promise<void>;
  list(category: string, filter?: KVListFilter): Promise<KVEntry[]>;
  close(): void;
}

export type { KVMetadata };
