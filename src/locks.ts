import { setTimeout as sleep } from 'node:timers/promises';
import type { LockStore } from './state/types.ts';

/** The lease a lock is shortened to when the runtime gives it back. */
export const END_MS = 1000;
/** How long a holder waits for a lock it ended to lapse before it takes the lock again. */
export const RETAKE_WITHIN_MS = 5000;
const RETAKE_EVERY_MS = 200;

/**
 * How giving a lock back went: `ended` - shortened to END_MS by its token, it lapses within that
 * second; `lifetime-exceeded` - the lock is past its lifetime, so the backend would not shorten it
 * and it lapses at its own end; `lost` - the token no longer held it.
 */
export type LockEnd = 'ended' | 'lifetime-exceeded' | 'lost';

/**
 * Gives a lock back through its token. Shield deletes a lock by key without a token, so a delete
 * that lands late could remove the successor's lock; a token-checked shortening can only touch this
 * holder's lease. The runtime never calls LockStore.release.
 */
export async function endOwnedLock(locks: LockStore, key: string, token: string): Promise<LockEnd> {
  const outcome = await locks.renew(key, token, END_MS);
  return outcome === 'renewed' ? 'ended' : outcome;
}

/**
 * Takes a lock again after this holder ended it: tries every RETAKE_EVERY_MS until the old lease
 * lapsed and a new one is granted, for at most `withinMs`. Undefined when another holder took the
 * key meanwhile, or the old lease did not lapse in time.
 */
export async function retakeLock(locks: LockStore, key: string, ttlMs: number, reference: string, withinMs = RETAKE_WITHIN_MS): Promise<string | undefined> {
  const deadline = Date.now() + withinMs;
  for (;;) {
    const lease = await locks.acquire(key, ttlMs, reference);
    if (lease.acquired) return lease.token;
    if (Date.now() >= deadline) return undefined;
    await sleep(RETAKE_EVERY_MS);
  }
}

/**
 * Locks this process ended through endOwnedLock, until each lapses. Such a lock is free once it
 * lapsed, so a caller that wants it again retries after that second instead of reading it as held
 * elsewhere and backing off for long.
 */
export class EndingLocks {
  private readonly until = new Map<string, number>();
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  ended(key: string): void {
    const now = this.now();
    // Forget the ones that lapsed already, so a long-running daemon keeps no entry per finished job.
    for (const [other, until] of this.until) if (until <= now) this.until.delete(other);
    this.until.set(key, now + END_MS + 100);
  }

  /** How long until a lock this process ended has lapsed; 0 once it has, or for any other key. */
  remaining(key: string): number {
    const until = this.until.get(key);
    if (until === undefined) return 0;
    const left = until - this.now();
    if (left <= 0) this.until.delete(key);
    return Math.max(0, left);
  }

  /** How many ended locks are still being waited out. */
  get size(): number {
    return this.until.size;
  }
}
