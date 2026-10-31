import { setTimeout as sleep } from 'node:timers/promises';
import type { SlotHold } from './jobs.ts';
import { END_MS, EndingLocks, endOwnedLock } from './locks.ts';
import type { Logger } from './log.ts';
import type { Manifest, WorkspaceMember } from './manifest.ts';
import type { StateBackend } from './state/types.ts';

export type PoolDecision =
  | { granted: true; hold: SlotHold; member?: WorkspaceMember }
  | { granted: false; waitingFor: string; retryAfterMs: number };

const LOCAL_RETRY_MS = 15_000;
const REMOTE_RETRY_MIN_MS = 30_000;

export function memberLockKey(pool: string, member: string): string {
  return `member.${pool}.${member}`;
}

/**
 * Pool limits. A `limit` pool is a Guard semaphore, shared across hosts (and across projects when
 * `shared`). A `workspaces` pool hands out named members, each held by a renewable Shield lease.
 * The host's own holds are counted first, so a pool that is full here costs no remote call.
 */
export class Pools {
  readonly manifest: Manifest;
  readonly backend: StateBackend;
  readonly log: Logger;
  readonly held = new Map<string, Map<string, SlotHold>>();
  // Workspace leases this host gave back by token: the next job waits for one to lapse.
  private readonly ending = new EndingLocks();

  constructor(manifest: Manifest, backend: StateBackend, log: Logger) {
    this.manifest = manifest;
    this.backend = backend;
    this.log = log;
  }

  private holds(pool: string): Map<string, SlotHold> {
    let holds = this.held.get(pool);
    if (!holds) { holds = new Map(); this.held.set(pool, holds); }
    return holds;
  }

  /** Records a hold that already exists, e.g. a running job found again after a restart. */
  adopt(jobId: string, hold: SlotHold): void {
    this.holds(hold.pool).set(jobId, hold);
  }

  /**
   * `member` asks for that workspace member only, e.g. the slot holding the job's subject; a job
   * waits for it rather than taking another. `read` places the job in the member without its lease.
   */
  async acquire(poolName: string, jobId: string, options: { member?: string; read?: boolean } = {}): Promise<PoolDecision> {
    const pool = this.manifest.pools.get(poolName);
    if (!pool) return { granted: false, waitingFor: `pool ${poolName} is not configured`, retryAfterMs: LOCAL_RETRY_MS };
    const holds = this.holds(poolName);
    const existing = holds.get(jobId);
    if (existing) return { granted: true, hold: existing };
    if (pool.kind === 'workspaces' && (options.member !== undefined || options.read)) {
      const member = pool.members.find((m) => m.name === options.member);
      if (!member) return { granted: false, waitingFor: options.member === undefined ? `read access to pool ${poolName} needs a member named by the request` : `pool ${poolName} has no member ${options.member}`, retryAfterMs: LOCAL_RETRY_MS };
      const key = memberLockKey(poolName, member.name);
      if (options.read) {
        const hold: SlotHold = { pool: poolName, kind: 'workspaces', key, token: '', global: false, member: member.name, read: true };
        holds.set(jobId, hold);
        return { granted: true, hold, member };
      }
      if ([...holds.values()].some((hold) => hold.member === member.name && !hold.read)) {
        return { granted: false, waitingFor: `workspace ${member.name} of pool ${poolName} is busy`, retryAfterMs: LOCAL_RETRY_MS };
      }
      const lapsing = this.ending.remaining(key);
      if (lapsing > 0) return { granted: false, waitingFor: `workspace ${member.name} of pool ${poolName} is being given back`, retryAfterMs: lapsing };
      if (await this.backend.locks.exists(key)) {
        return { granted: false, waitingFor: `workspace ${member.name} of pool ${poolName} is busy`, retryAfterMs: LOCAL_RETRY_MS };
      }
      const lease = await this.backend.locks.acquire(key, this.manifest.runtime.leaseTtlMs, jobId);
      if (!lease.acquired) return { granted: false, waitingFor: `workspace ${member.name} of pool ${poolName} is busy`, retryAfterMs: LOCAL_RETRY_MS };
      const hold: SlotHold = { pool: poolName, kind: 'workspaces', key, token: lease.token, global: false, member: member.name };
      holds.set(jobId, hold);
      return { granted: true, hold, member };
    }
    if (pool.kind === 'limit') {
      if (holds.size >= pool.limit) return { granted: false, waitingFor: `pool ${poolName} full (${holds.size}/${pool.limit} held by this host)`, retryAfterMs: LOCAL_RETRY_MS };
      const key = `pool.${poolName}`;
      const grant = await this.backend.slots.acquire(key, pool.limit, pool.slotTtlMs, { global: pool.shared });
      if (!grant.granted) return { granted: false, waitingFor: `pool ${poolName} full (limit ${pool.limit}${pool.shared ? ', shared' : ''})`, retryAfterMs: Math.max(REMOTE_RETRY_MIN_MS, grant.retryAfterMs) };
      const hold: SlotHold = { pool: poolName, kind: 'limit', key, token: grant.token, global: pool.shared };
      holds.set(jobId, hold);
      return { granted: true, hold };
    }
    const busy = new Set([...holds.values()].filter((hold) => !hold.read).map((hold) => hold.member));
    let lapsing = 0;
    for (const member of pool.members) {
      if (busy.has(member.name)) continue;
      const key = memberLockKey(poolName, member.name);
      const left = this.ending.remaining(key);
      if (left > 0) { lapsing = lapsing === 0 ? left : Math.min(lapsing, left); continue; }
      // Reading a lease is free; acquiring one is metered, so a held member is skipped unread.
      if (await this.backend.locks.exists(key)) continue;
      const lease = await this.backend.locks.acquire(key, this.manifest.runtime.leaseTtlMs, jobId);
      if (!lease.acquired) continue;
      const hold: SlotHold = { pool: poolName, kind: 'workspaces', key, token: lease.token, global: false, member: member.name };
      holds.set(jobId, hold);
      return { granted: true, hold, member };
    }
    return { granted: false, waitingFor: `every workspace of pool ${poolName} is busy (${pool.members.map((m) => m.name).join(', ')})`, retryAfterMs: lapsing > 0 ? lapsing : LOCAL_RETRY_MS };
  }

  member(hold: SlotHold): WorkspaceMember | undefined {
    const pool = this.manifest.pools.get(hold.pool);
    return pool?.kind === 'workspaces' ? pool.members.find((m) => m.name === hold.member) : undefined;
  }

  /** Keeps a workspace lease alive; a lease that expired meanwhile is taken again if it is free. */
  async renew(jobId: string, hold: SlotHold): Promise<SlotHold> {
    if (hold.kind !== 'workspaces' || hold.read) return hold;
    const outcome = await this.backend.locks.renew(hold.key, hold.token, this.manifest.runtime.leaseTtlMs);
    if (outcome === 'renewed') return hold;
    // A lease past its lifetime cannot be renewed: end it by token and take the workspace again once
    // it lapsed, never by deleting the key, which could remove a lease another holder took meanwhile.
    if (outcome === 'lifetime-exceeded') {
      await endOwnedLock(this.backend.locks, hold.key, hold.token);
      await sleep(END_MS + 100);
    }
    const lease = await this.backend.locks.acquire(hold.key, this.manifest.runtime.leaseTtlMs, jobId);
    if (!lease.acquired) {
      this.log.warn('workspace lease lost to another holder; the running job keeps its workspace', { job: jobId, pool: hold.pool, member: hold.member });
      return hold;
    }
    const renewed = { ...hold, token: lease.token };
    this.holds(hold.pool).set(jobId, renewed);
    return renewed;
  }

  async release(jobId: string, hold: SlotHold): Promise<void> {
    this.holds(hold.pool).delete(jobId);
    if (hold.kind === 'limit') { await this.backend.slots.release(hold.key, hold.token, { global: hold.global }); return; }
    if (hold.read) return;
    if (await endOwnedLock(this.backend.locks, hold.key, hold.token)) this.ending.ended(hold.key);
  }
}
