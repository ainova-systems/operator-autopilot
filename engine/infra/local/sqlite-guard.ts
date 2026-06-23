import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import type { OperationContext } from "@operator/core";
import type { IdempotencyGuard, LockHandle } from "@operator/core";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS locks (
  key        TEXT PRIMARY KEY,
  lock_id    TEXT NOT NULL,
  acquired_at TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  completed   INTEGER NOT NULL DEFAULT 0
);
`;

/**
 * SQLite-based IdempotencyGuard for standalone mode.
 *
 * Single-instance only — locks are not distributed.
 * For multi-instance, use a cloud lock plugin.
 */
export class LocalIdempotencyGuard implements IdempotencyGuard {
  private readonly db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(SCHEMA);
  }

  async acquire(key: string, ttlMs: number, _ctx: OperationContext): Promise<LockHandle | null> {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + ttlMs).toISOString();

    // Clean all expired locks (active and completed)
    this.db.prepare("DELETE FROM locks WHERE expires_at < ?").run(now.toISOString());

    // Check if lock exists (active or completed)
    const existing = this.db.prepare("SELECT * FROM locks WHERE key = ?").get(key) as
      | { lock_id: string; completed: number; expires_at: string }
      | undefined;

    if (existing) {
      // Completed lock within dedup window — already done
      if (existing.completed === 1) return null;
      // Active lock still valid
      if (new Date(existing.expires_at) > now) return null;
      // Expired active lock — remove and allow re-acquire
      this.db.prepare("DELETE FROM locks WHERE key = ?").run(key);
    }

    const lockId = randomUUID();
    const acquiredAt = now.toISOString();

    this.db.prepare(
      "INSERT INTO locks (key, lock_id, acquired_at, expires_at, completed) VALUES (?, ?, ?, ?, 0)",
    ).run(key, lockId, acquiredAt, expiresAt);

    return { key, lockId, acquiredAt };
  }

  async complete(handle: LockHandle, _ctx: OperationContext): Promise<void> {
    // Mark as completed, extend expiry for dedup window (30 days like Shield)
    const completedExpiry = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    this.db.prepare(
      "UPDATE locks SET completed = 1, expires_at = ? WHERE key = ? AND lock_id = ?",
    ).run(completedExpiry, handle.key, handle.lockId);
  }

  async release(handle: LockHandle, _ctx: OperationContext): Promise<void> {
    this.db.prepare("DELETE FROM locks WHERE key = ? AND lock_id = ?").run(handle.key, handle.lockId);
  }

  async clearActiveLocks(_ctx: OperationContext): Promise<number> {
    const result = this.db.prepare("DELETE FROM locks WHERE completed = 0").run();
    return result.changes;
  }

  close(): void {
    this.db.close();
  }
}
