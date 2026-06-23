import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import type {
  IdempotencyGuard,
  KVEntry,
  KVListFilter,
  KVMetadata,
  KVPutOptions,
  KVStore,
  LockHandle,
  OperationContext,
  RateLimiter,
  RateLimiterDecision,
} from "@operator/core";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS kv (
  category   TEXT NOT NULL,
  key        TEXT NOT NULL,
  value      TEXT NOT NULL,
  metadata   TEXT,
  updated_at TEXT NOT NULL,
  expires_at TEXT,
  PRIMARY KEY (category, key)
);
CREATE INDEX IF NOT EXISTS idx_kv_category ON kv(category);

CREATE TABLE IF NOT EXISTS locks (
  lock_key    TEXT PRIMARY KEY,
  owner       TEXT NOT NULL,
  acquired_at TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  completed   INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS rate_buckets (
  bucket_key       TEXT PRIMARY KEY,
  tokens           REAL NOT NULL,
  updated_at       TEXT NOT NULL,
  limit_per_window REAL NOT NULL,
  window_ms        INTEGER NOT NULL
);
`;

export interface LocalStorageBundleOptions {
  readonly dbPath: string;
}

const DEFAULT_RATE_LIMIT_TOKENS = 60;
const DEFAULT_RATE_LIMIT_WINDOW_MS = 60_000;
const COMPLETED_LOCK_DEDUP_MS = 30 * 24 * 60 * 60 * 1000;
const SAFE_ORDER_BY_COLUMNS = new Set(["key", "updated_at"]);

interface KVRow {
  readonly key: string;
  readonly value: string;
  readonly metadata: string | null;
  readonly expires_at: string | null;
}

interface LockRow {
  readonly owner: string;
  readonly completed: number;
  readonly expires_at: string;
}

interface RateBucketRow {
  readonly tokens: number;
  readonly updated_at: string;
  readonly limit_per_window: number;
  readonly window_ms: number;
}

/**
 * SQLite-backed bundle implementing {@link KVStore}, {@link IdempotencyGuard},
 * and {@link RateLimiter} against a single SQLite file with three tables.
 * Ships the default local backend for the operator engine and the app.
 *
 * See architecture-v5.md §5.2 for the schema.
 */
export class LocalStorageBundle implements KVStore, IdempotencyGuard, RateLimiter {
  private readonly db: Database.Database;

  constructor(opts: LocalStorageBundleOptions) {
    this.db = new Database(opts.dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(SCHEMA);
  }

  // ── KVStore ─────────────────────────────────────────────────────────

  async get(category: string, key: string): Promise<KVEntry | null> {
    const row = this.db
      .prepare("SELECT key, value, metadata, expires_at FROM kv WHERE category = ? AND key = ?")
      .get(category, key) as KVRow | undefined;
    if (!row) return null;
    if (row.expires_at && new Date(row.expires_at) < new Date()) {
      this.db.prepare("DELETE FROM kv WHERE category = ? AND key = ?").run(category, key);
      return null;
    }
    return rowToEntry(row);
  }

  async put(category: string, key: string, value: unknown, opts?: KVPutOptions): Promise<void> {
    const now = new Date().toISOString();
    const expiresAt = opts?.ttlMs != null ? new Date(Date.now() + opts.ttlMs).toISOString() : null;
    const metadata = opts?.metadata ? JSON.stringify(opts.metadata) : null;
    this.db
      .prepare(`
        INSERT INTO kv (category, key, value, metadata, updated_at, expires_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(category, key) DO UPDATE SET
          value      = excluded.value,
          metadata   = excluded.metadata,
          updated_at = excluded.updated_at,
          expires_at = excluded.expires_at
      `)
      .run(category, key, JSON.stringify(value), metadata, now, expiresAt);
  }

  async delete(category: string, key: string): Promise<void> {
    this.db.prepare("DELETE FROM kv WHERE category = ? AND key = ?").run(category, key);
  }

  async list(category: string, filter?: KVListFilter): Promise<KVEntry[]> {
    const clauses: string[] = ["category = ?"];
    const params: unknown[] = [category];

    if (filter?.keyPrefix != null) {
      clauses.push("key LIKE ?");
      params.push(`${filter.keyPrefix}%`);
    }
    clauses.push("(expires_at IS NULL OR expires_at > ?)");
    params.push(new Date().toISOString());

    let sql = `SELECT key, value, metadata, expires_at FROM kv WHERE ${clauses.join(" AND ")}`;

    if (filter?.orderBy && SAFE_ORDER_BY_COLUMNS.has(filter.orderBy)) {
      sql += ` ORDER BY ${filter.orderBy}${filter.order === "desc" ? " DESC" : " ASC"}`;
    } else {
      sql += " ORDER BY key ASC";
    }
    if (filter?.limit != null) {
      sql += " LIMIT ?";
      params.push(filter.limit);
    }
    if (filter?.offset != null) {
      sql += " OFFSET ?";
      params.push(filter.offset);
    }

    const rows = this.db.prepare(sql).all(...params) as KVRow[];
    let entries = rows.map(rowToEntry);

    if (filter?.where) {
      const expected = Object.entries(filter.where);
      entries = entries.filter((e) => {
        if (!e.value || typeof e.value !== "object") return false;
        const obj = e.value as Record<string, unknown>;
        return expected.every(([k, v]) => obj[k] === v);
      });
    }

    return entries;
  }

  // ── IdempotencyGuard ────────────────────────────────────────────────

  async acquire(key: string, ttlMs: number, _ctx: OperationContext): Promise<LockHandle | null> {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + ttlMs).toISOString();

    this.db
      .prepare("DELETE FROM locks WHERE completed = 0 AND expires_at < ?")
      .run(now.toISOString());

    const existing = this.db
      .prepare("SELECT owner, completed, expires_at FROM locks WHERE lock_key = ?")
      .get(key) as LockRow | undefined;

    if (existing) {
      if (existing.completed === 1 && new Date(existing.expires_at) > now) return null;
      if (new Date(existing.expires_at) > now) return null;
      this.db.prepare("DELETE FROM locks WHERE lock_key = ?").run(key);
    }

    const lockId = randomUUID();
    const acquiredAt = now.toISOString();
    this.db
      .prepare(
        "INSERT INTO locks (lock_key, owner, acquired_at, expires_at, completed) VALUES (?, ?, ?, ?, 0)",
      )
      .run(key, lockId, acquiredAt, expiresAt);

    return { key, lockId, acquiredAt };
  }

  async complete(handle: LockHandle, _ctx: OperationContext): Promise<void> {
    const expiry = new Date(Date.now() + COMPLETED_LOCK_DEDUP_MS).toISOString();
    this.db
      .prepare("UPDATE locks SET completed = 1, expires_at = ? WHERE lock_key = ? AND owner = ?")
      .run(expiry, handle.key, handle.lockId);
  }

  async release(handle: LockHandle, _ctx: OperationContext): Promise<void> {
    this.db
      .prepare("DELETE FROM locks WHERE lock_key = ? AND owner = ?")
      .run(handle.key, handle.lockId);
  }

  async clearActiveLocks(_ctx: OperationContext): Promise<number> {
    const result = this.db
      .prepare("DELETE FROM locks WHERE completed = 0")
      .run();
    return result.changes;
  }

  // ── RateLimiter ─────────────────────────────────────────────────────

  async allow(key: string, cost: number, _ctx: OperationContext): Promise<RateLimiterDecision> {
    const now = Date.now();
    const row = this.db
      .prepare(
        "SELECT tokens, updated_at, limit_per_window, window_ms FROM rate_buckets WHERE bucket_key = ?",
      )
      .get(key) as RateBucketRow | undefined;

    const limitPerWindow = row?.limit_per_window ?? DEFAULT_RATE_LIMIT_TOKENS;
    const windowMs = row?.window_ms ?? DEFAULT_RATE_LIMIT_WINDOW_MS;

    let tokens: number;
    if (!row) {
      tokens = limitPerWindow;
    } else {
      const elapsed = Math.max(0, now - new Date(row.updated_at).getTime());
      const refill = (elapsed / windowMs) * limitPerWindow;
      tokens = Math.min(limitPerWindow, row.tokens + refill);
    }

    if (tokens < cost) {
      const deficit = cost - tokens;
      const retryAfterMs = Math.max(1, Math.ceil((deficit / limitPerWindow) * windowMs));
      return { allowed: false, retryAfterMs };
    }

    const remaining = tokens - cost;
    this.db
      .prepare(`
        INSERT INTO rate_buckets (bucket_key, tokens, updated_at, limit_per_window, window_ms)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(bucket_key) DO UPDATE SET
          tokens     = excluded.tokens,
          updated_at = excluded.updated_at
      `)
      .run(key, remaining, new Date(now).toISOString(), limitPerWindow, windowMs);

    return { allowed: true };
  }

  async reset(key: string): Promise<void> {
    this.db.prepare("DELETE FROM rate_buckets WHERE bucket_key = ?").run(key);
  }

  // ── Lifecycle ───────────────────────────────────────────────────────

  close(): void {
    this.db.close();
  }
}

function rowToEntry(row: KVRow): KVEntry {
  return {
    key: row.key,
    value: JSON.parse(row.value),
    metadata: row.metadata ? (JSON.parse(row.metadata) as KVMetadata) : undefined,
  };
}
