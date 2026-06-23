import type { OperationContext } from "../types/context.js";

export interface LockHandle {
  readonly key: string;
  readonly lockId: string;
  readonly acquiredAt: string;
}

/**
 * Deduplication guard backing `runStage` work-item locks and the dedup window
 * for terminal decisions. Implementations must be atomic: concurrent
 * {@link acquire} calls on the same key must produce at most one non-null
 * handle. See architecture-v5.md §5.1.
 */
export interface IdempotencyGuard {
  acquire(key: string, ttlMs: number, ctx: OperationContext): Promise<LockHandle | null>;
  complete(handle: LockHandle, ctx: OperationContext): Promise<void>;
  release(handle: LockHandle, ctx: OperationContext): Promise<void>;
  /**
   * Drop every active (non-completed) lock unconditionally. Called at
   * daemon boot — a process termination mid-acquire leaves stale rows
   * with future `expires_at` that block future runs until the TTL
   * passes (agents can have 3h TTL, so without this rule the daemon
   * stalls until naturally expiring). Returns the count of cleared
   * locks for observability.
   */
  clearActiveLocks(ctx: OperationContext): Promise<number>;
}
