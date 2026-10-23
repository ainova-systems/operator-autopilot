import type { SlotHold } from './jobs.ts';
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

  async acquire(poolName: string, jobId: string): Promise<PoolDecision> {
    const pool = this.manifest.pools.get(poolName);
    if (!pool) return { granted: false, waitingFor: `pool ${poolName} is not configured`, retryAfterMs: LOCAL_RETRY_MS };
    const holds = this.holds(poolName);
    const existing = holds.get(jobId);
    if (existing) return { granted: true, hold: existing };
    if (pool.kind === 'limit') {
      if (holds.size >= pool.limit) return { granted: false, waitingFor: `pool ${poolName} full (${holds.size}/${pool.limit} held by this host)`, retryAfterMs: LOCAL_RETRY_MS };
      const key = `pool.${poolName}`;
      const grant = await this.backend.slots.acquire(key, pool.limit, pool.slotTtlMs, { global: pool.shared });
      if (!grant.granted) return { granted: false, waitingFor: `pool ${poolName} full (limit ${pool.limit}${pool.shared ? ', shared' : ''})`, retryAfterMs: Math.max(REMOTE_RETRY_MIN_MS, grant.retryAfterMs) };
      const hold: SlotHold = { pool: poolName, kind: 'limit', key, token: grant.token, global: pool.shared };
      holds.set(jobId, hold);
      return { granted: true, hold };
    }
    const busy = new Set([...holds.values()].map((hold) => hold.member));
    for (const member of pool.members) {
      if (busy.has(member.name)) continue;
      const key = memberLockKey(poolName, member.name);
      // Reading a lease is free; acquiring one is metered, so a held member is skipped unread.
      if (await this.backend.locks.exists(key)) continue;
      const lease = await this.backend.locks.acquire(key, this.manifest.runtime.leaseTtlMs, jobId);
      if (!lease.acquired) continue;
      const hold: SlotHold = { pool: poolName, kind: 'workspaces', key, token: lease.token, global: false, member: member.name };
      holds.set(jobId, hold);
      return { granted: true, hold, member };
    }
    return { granted: false, waitingFor: `every workspace of pool ${poolName} is busy (${pool.members.map((m) => m.name).join(', ')})`, retryAfterMs: LOCAL_RETRY_MS };
  }

  member(hold: SlotHold): WorkspaceMember | undefined {
    const pool = this.manifest.pools.get(hold.pool);
    return pool?.kind === 'workspaces' ? pool.members.find((m) => m.name === hold.member) : undefined;
  }

  /** Keeps a workspace lease alive; a lease that expired meanwhile is taken again if it is free. */
  async renew(jobId: string, hold: SlotHold): Promise<SlotHold> {
    if (hold.kind !== 'workspaces') return hold;
    const outcome = await this.backend.locks.renew(hold.key, hold.token, this.manifest.runtime.leaseTtlMs);
    if (outcome === 'renewed') return hold;
    if (outcome === 'lifetime-exceeded') await this.backend.locks.release(hold.key);
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
    if (hold.kind === 'limit') await this.backend.slots.release(hold.key, hold.token, { global: hold.global });
    else await this.backend.locks.release(hold.key);
  }
}
