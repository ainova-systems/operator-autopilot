import type { LockStore } from './state/types.ts';

/** The lease a lock is shortened to when the runtime gives it back. */
export const END_MS = 1000;

/**
 * Gives a lock back through its token: the lease is shortened to END_MS and lapses by itself.
 * Shield deletes a lock by key without a token, so a delete that lands late could remove the
 * successor's lock; a token-checked shortening can only touch this holder's lease. A lock past its
 * lifetime cannot be renewed, but then it lapses by itself too. Answers whether the token still
 * held the lock.
 */
export async function endOwnedLock(locks: LockStore, key: string, token: string): Promise<boolean> {
  return (await locks.renew(key, token, END_MS)) !== 'lost';
}

/**
 * Locks this process ended through endOwnedLock, until each lapses. Such a lock is free once it
 * lapsed, so a caller that wants it again retries after that second instead of reading it as held
 * elsewhere and backing off for long.
 */
export class EndingLocks {
  private readonly until = new Map<string, number>();

  ended(key: string): void {
    this.until.set(key, Date.now() + END_MS + 100);
  }

  /** How long until a lock this process ended has lapsed; 0 once it has, or for any other key. */
  remaining(key: string): number {
    const until = this.until.get(key);
    if (until === undefined) return 0;
    const left = until - Date.now();
    if (left <= 0) this.until.delete(key);
    return Math.max(0, left);
  }
}
