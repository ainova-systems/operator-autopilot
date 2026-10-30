import { after, test } from 'node:test';
import { strict as assert } from 'node:assert';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { liveClaims, releaseClaim, renewClaim, showClaim, takeClaim, type ClaimStore } from './claims.ts';
import { createFileBackend } from './state/file.ts';
import type { DocStore, LockStore } from './state/types.ts';

const dirs: string[] = [];
after(async () => { for (const dir of dirs) await rm(dir, { recursive: true, force: true }); });

const HOUR = 3_600_000;
const LIFETIME = 24 * HOUR;

/**
 * An atomic lock on a clock the test moves, as the backend's lock is: acquire, renew and release
 * are decided in one step, so two simultaneous acquirers never both win.
 */
function fakeLocks(clock: { now: Date }): LockStore & { held(key: string): string | undefined } {
  const locks = new Map<string, { token: string; expiresAt: number; acquiredAt: number }>();
  const live = (key: string): { token: string; expiresAt: number; acquiredAt: number } | undefined => {
    const lock = locks.get(key);
    return lock && lock.expiresAt > clock.now.getTime() ? lock : undefined;
  };
  return {
    async acquire(key, ttlMs) {
      await Promise.resolve();
      if (live(key)) return { acquired: false };
      const token = randomBytes(8).toString('hex');
      const at = clock.now.getTime();
      locks.set(key, { token, acquiredAt: at, expiresAt: at + Math.min(ttlMs, LIFETIME) });
      return { acquired: true, token };
    },
    async renew(key, token, ttlMs) {
      const lock = live(key);
      if (!lock || lock.token !== token) return 'lost';
      if (clock.now.getTime() >= lock.acquiredAt + LIFETIME) return 'lifetime-exceeded';
      lock.expiresAt = Math.min(clock.now.getTime() + ttlMs, lock.acquiredAt + LIFETIME);
      return 'renewed';
    },
    async complete() { throw new Error('claims never complete a lock'); },
    async exists(key) { return live(key) !== undefined; },
    async release(key) { locks.delete(key); },
    held: (key) => live(key)?.token,
  };
}

async function setup(at: string): Promise<{ store: ClaimStore; clock: { now: Date }; locks: ReturnType<typeof fakeLocks>; docs: DocStore }> {
  const dir = await mkdtemp(join(tmpdir(), 'operator-claims-'));
  dirs.push(dir);
  const clock = { now: new Date(at) };
  const locks = fakeLocks(clock);
  const docs = createFileBackend(dir, 'demo').docs;
  return { store: { docs, locks }, clock, locks, docs };
}

function tick(clock: { now: Date }, at: string): Date {
  clock.now = new Date(at);
  return clock.now;
}

test('a subject is held by one run until its lease runs out, and the holder can take it again', async () => {
  const { store, clock } = await setup('2026-10-30T10:00:00Z');
  assert.equal((await takeClaim(store, 'item-7', 'run-a', HOUR, clock.now)).ok, true);
  const second = await takeClaim(store, 'item-7', 'run-b', HOUR, tick(clock, '2026-10-30T10:30:00Z'));
  assert.equal(!second.ok && second.reason === 'held' && second.holder.run, 'run-a');
  // The holder taking it again renews it and keeps when it was first taken.
  const again = await takeClaim(store, 'item-7', 'run-a', HOUR, tick(clock, '2026-10-30T10:40:00Z'));
  assert.equal(again.ok && again.claim.takenAt, '2026-10-30T10:00:00.000Z');
  assert.equal(again.ok && again.claim.expiresAt, '2026-10-30T11:40:00.000Z');
  // Once the lease has run out, another run takes the subject.
  const later = await takeClaim(store, 'item-7', 'run-b', HOUR, tick(clock, '2026-10-30T11:41:00Z'));
  assert.equal(later.ok && later.claim.run, 'run-b');
});

test('simultaneous takers: exactly one wins even when the document store lets every create through', async () => {
  const { store, clock, docs } = await setup('2026-10-30T10:00:00Z');
  // A store that is not linearizable on create: every create "succeeds" and overwrites.
  const racy: DocStore = { ...docs, async create(collection, key, value, ttlMs) { await docs.replace(collection, key, value, ttlMs ? { ttlMs } : {}); return 'created'; } };
  const runs = ['run-a', 'run-b', 'run-c', 'run-d', 'run-e', 'run-f'];
  const results = await Promise.all(runs.map((run) => takeClaim({ docs: racy, locks: store.locks }, 'item-8', run, HOUR, clock.now)));
  const winners = results.filter((result) => result.ok);
  assert.equal(winners.length, 1);
  const winner = winners[0]?.ok ? winners[0].claim.run : undefined;
  for (const lost of results.filter((result) => !result.ok)) assert.equal(!lost.ok && lost.reason === 'held' && lost.holder.run, winner);
  assert.equal((await showClaim(store, 'item-8', clock.now))?.claim.run, winner);
});

test('renew extends only the holder\'s lease; release ends it and never removes a newer holder\'s lock', async () => {
  const { store, clock, locks } = await setup('2026-10-30T10:00:00Z');
  await takeClaim(store, 'item-9', 'run-a', HOUR, clock.now);
  const renewed = await renewClaim(store, 'item-9', 'run-a', 2 * HOUR, tick(clock, '2026-10-30T10:50:00Z'));
  assert.equal(renewed.ok && renewed.claim.expiresAt, '2026-10-30T12:50:00.000Z');
  const foreign = await renewClaim(store, 'item-9', 'run-b', HOUR, tick(clock, '2026-10-30T10:55:00Z'));
  assert.equal(!foreign.ok && foreign.reason, 'held');
  assert.equal(!(await releaseClaim(store, 'item-9', 'run-b', clock.now)).ok, true);
  const released = await releaseClaim(store, 'item-9', 'run-a', tick(clock, '2026-10-30T11:00:00Z'));
  assert.equal(released.ok && released.claim.releasedAt, '2026-10-30T11:00:00.000Z');
  assert.equal(locks.held('claim.item-9'), undefined);
  // Released means free at once; a second release finds nothing, and the late holder cannot renew.
  assert.deepEqual(await releaseClaim(store, 'item-9', 'run-a', clock.now), { ok: false, reason: 'absent' });
  assert.deepEqual(await renewClaim(store, 'item-9', 'run-a', HOUR, clock.now), { ok: false, reason: 'absent' });
  assert.equal((await takeClaim(store, 'item-9', 'run-b', HOUR, tick(clock, '2026-10-30T11:02:00Z'))).ok, true);
  const newLock = locks.held('claim.item-9');
  // A run whose lease passed on cannot release the new holder's claim or lock.
  const stale = await releaseClaim(store, 'item-9', 'run-a', tick(clock, '2026-10-30T11:03:00Z'));
  assert.equal(!stale.ok && stale.reason, 'not-holder');
  assert.equal(locks.held('claim.item-9'), newLock);
});

test('a holder whose lease ran out takes it back only while nobody else took it', async () => {
  const { store, clock } = await setup('2026-10-30T10:00:00Z');
  await takeClaim(store, 'a', 'run-a', HOUR, clock.now);
  const back = await renewClaim(store, 'a', 'run-a', HOUR, tick(clock, '2026-10-30T11:30:00Z'));
  assert.equal(back.ok && back.claim.takenAt, '2026-10-30T10:00:00.000Z');
  tick(clock, '2026-10-30T13:00:00Z');
  assert.equal((await takeClaim(store, 'a', 'run-b', HOUR, clock.now)).ok, true);
  const lost = await renewClaim(store, 'a', 'run-a', HOUR, clock.now);
  assert.equal(!lost.ok && lost.reason, 'held');
});

test('a lease kept past the lock\'s one-day lifetime is taken again by its holder', async () => {
  const { store, clock, locks } = await setup('2026-10-30T00:00:00Z');
  await takeClaim(store, 'long', 'run-a', 12 * HOUR, clock.now);
  await renewClaim(store, 'long', 'run-a', 12 * HOUR, tick(clock, '2026-10-30T11:00:00Z'));
  const first = locks.held('claim.long');
  const kept = await renewClaim(store, 'long', 'run-a', 12 * HOUR, tick(clock, '2026-10-30T23:59:00Z'));
  assert.equal(kept.ok && kept.claim.run, 'run-a');
  // Past the lifetime the lock is let go and acquired again under a new token.
  const renewedPast = await renewClaim(store, 'long', 'run-a', 12 * HOUR, tick(clock, '2026-10-31T00:00:30Z'));
  assert.equal(renewedPast.ok && renewedPast.claim.takenAt, '2026-10-30T00:00:00.000Z');
  assert.notEqual(locks.held('claim.long'), first);
});

test('show lists live claims only; a release whose answer was lost is still this run\'s release', async () => {
  const { store, clock, docs } = await setup('2026-10-30T10:00:00Z');
  await takeClaim(store, 'a', 'run-a', HOUR, clock.now);
  await takeClaim(store, 'b', 'run-b', HOUR, clock.now);
  let lied = false;
  const lossy: DocStore = { ...docs, async replace(collection, key, value, options) { const outcome = await docs.replace(collection, key, value, options); if (lied || !options?.etag) return outcome; lied = true; return 'conflict'; } };
  const released = await releaseClaim({ docs: lossy, locks: store.locks }, 'b', 'run-b', tick(clock, '2026-10-30T10:10:00Z'));
  assert.equal(released.ok, true);
  assert.deepEqual((await liveClaims(store, tick(clock, '2026-10-30T10:20:00Z'))).map((claim) => claim.subject), ['a']);
  assert.deepEqual(await liveClaims(store, tick(clock, '2026-10-30T11:20:00Z')), []);
  // The lock token stays inside the runtime.
  assert.equal('token' in ((await showClaim(store, 'a', clock.now))?.claim ?? {}), false);
});

test('a subject outside the key charset and a lease over a day are refused before anything is written', async () => {
  const { store, clock, locks } = await setup('2026-10-30T10:00:00Z');
  for (const subject of ['a/b', 'a b', '..', '', 'x'.repeat(121)]) await assert.rejects(takeClaim(store, subject, 'run-a', HOUR, clock.now), /subject .* may only use/, subject);
  await assert.rejects(takeClaim(store, 'a', 'run with spaces', HOUR, clock.now), /run id/);
  await assert.rejects(takeClaim(store, 'item-21', 'run-a', 25 * HOUR, clock.now), /at most 24h/);
  await assert.rejects(renewClaim(store, 'item-21', 'run-a', 0, clock.now), /at most 24h/);
  assert.equal(locks.held('claim.item-21'), undefined);
  assert.deepEqual(await liveClaims(store, clock.now), []);
});
