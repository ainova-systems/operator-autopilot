import type { IdempotencyGuard, LockHandle, OperationContext } from "@operator/core";

/**
 * In-memory IdempotencyGuard for testing.
 *
 * Enforces real mutual exclusion: a second `acquire` on a held key returns
 * `null` until the holder releases it. Tests that assert concurrency
 * invariants (workspace lock, stage lock) need that, not a `vi.fn()` that
 * always hands out a handle.
 *
 * TTL is recorded but never expires — tests drive time by acquiring and
 * releasing explicitly.
 */
export class TestIdempotencyGuard implements IdempotencyGuard {
  /** Keys currently held. Exposed so tests can assert the lock was released. */
  readonly held = new Set<string>();
  /** Every key ever acquired successfully, in order. */
  readonly acquired: string[] = [];
  /** TTL passed to the last successful `acquire` per key. */
  readonly ttls = new Map<string, number>();

  private lockCounter = 0;

  async acquire(key: string, ttlMs: number, _ctx: OperationContext): Promise<LockHandle | null> {
    if (this.held.has(key)) return null;
    this.held.add(key);
    this.acquired.push(key);
    this.ttls.set(key, ttlMs);
    return { key, lockId: `lock-${++this.lockCounter}`, acquiredAt: new Date().toISOString() };
  }

  async complete(handle: LockHandle, _ctx: OperationContext): Promise<void> {
    this.held.delete(handle.key);
  }

  async release(handle: LockHandle, _ctx: OperationContext): Promise<void> {
    this.held.delete(handle.key);
  }

  async clearActiveLocks(_ctx: OperationContext): Promise<number> {
    const cleared = this.held.size;
    this.held.clear();
    return cleared;
  }
}
