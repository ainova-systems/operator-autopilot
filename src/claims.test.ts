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

type FakeLocks = LockStore & { held(key: string): string | undefined; ttlOf(key: string): number | undefined };

/**
 * An atomic lock on a clock the test moves, as the backend's lock is: acquire and renew are
 * decided in one step, so two simultaneous acquirers never both win. It has no token-checked
 * delete, like the real one, and a claim must never delete a lock by key.
 */
function fakeLocks(clock: { now: Date }): FakeLocks {
  const locks = new Map<string, { token: string; expiresAt: number; acquiredAt: number; ttlMs: number }>();
  const live = (key: string): { token: string; expiresAt: number; acquiredAt: number; ttlMs: number } | undefined => {
    const lock = locks.get(key);
    return lock && lock.expiresAt > clock.now.getTime() ? lock : undefined;
  };
  return {
    async acquire(key, ttlMs) {
      await Promise.resolve();
      if (live(key)) return { acquired: false };
      const token = randomBytes(8).toString('hex');
      const at = clock.now.getTime();
      locks.set(key, { token, acquiredAt: at, ttlMs, expiresAt: at + Math.min(ttlMs, LIFETIME) });
      return { acquired: true, token };
    },
    async renew(key, token, ttlMs) {
      const lock = live(key);
      if (!lock || lock.token !== token) return 'lost';
      if (clock.now.getTime() + ttlMs > lock.acquiredAt + LIFETIME) return 'lifetime-exceeded';
      lock.expiresAt = clock.now.getTime() + ttlMs;
      lock.ttlMs = ttlMs;
      return 'renewed';
    },
    async complete() { throw new Error('claims never complete a lock'); },
    async exists(key) { return live(key) !== undefined; },
    async release() { throw new Error('claims never delete a lock by key'); },
    held: (key) => live(key)?.token,
    ttlOf: (key) => live(key)?.ttlMs,
  };
}

async function setup(at: string): Promise<{ store: ClaimStore; clock: { now: Date }; locks: FakeLocks; docs: DocStore }> {
  const dir = await mkdtemp(join(tmpdir(), 'operator-claims-'));
  dirs.push(dir);
  const clock = { now: new Date(at) };
  const locks = fakeLocks(clock);
  const docs = createFileBackend(dir, 'demo').docs;
  return { store: { docs, locks }, clock, locks, docs };
}

/** Moves the test's clock and answers it as the clock the claim functions read. */
function tick(clock: { now: Date }, at: string): () => Date {
  clock.now = new Date(at);
  return () => clock.now;
}

test('a subject is held by one run until its lease runs out, and the holder can take it again', async () => {
  const { store, clock } = await setup('2026-10-30T10:00:00Z');
  assert.equal((await takeClaim(store, 'item-7', 'run-a', HOUR, () => clock.now)).ok, true);
  const second = await takeClaim(store, 'item-7', 'run-b', HOUR, tick(clock, '2026-10-30T10:30:00Z'));
  assert.equal(!second.ok && second.reason === 'held' && second.holder?.run, 'run-a');
  // The holder taking it again renews it and keeps when it was first taken.
  const again = await takeClaim(store, 'item-7', 'run-a', HOUR, tick(clock, '2026-10-30T10:40:00Z'));
  assert.equal(again.ok && again.claim.takenAt, '2026-10-30T10:00:00.000Z');
  assert.equal(again.ok && again.claim.expiresAt, '2026-10-30T11:40:00.000Z');
  // Once the lease has run out, another run takes the subject.
  const later = await takeClaim(store, 'item-7', 'run-b', HOUR, tick(clock, '2026-10-30T11:41:00Z'));
  assert.equal(later.ok && later.claim.run, 'run-b');
});

test('simultaneous takers: the lock lets exactly one win, and the others name it as the holder', async () => {
  const { store, clock } = await setup('2026-10-30T10:00:00Z');
  const runs = ['run-a', 'run-b', 'run-c', 'run-d', 'run-e', 'run-f'];
  const results = await Promise.all(runs.map((run) => takeClaim(store, 'item-8', run, HOUR, () => clock.now)));
  const winners = results.filter((result) => result.ok);
  assert.equal(winners.length, 1);
  const winner = winners[0]?.ok ? winners[0].claim.run : undefined;
  for (const lost of results.filter((result) => !result.ok)) assert.equal(!lost.ok && lost.reason === 'held' && lost.holder?.run, winner);
  assert.equal((await showClaim(store, 'item-8', () => clock.now)).claim?.run, winner);
});

test('renew extends only the holder\'s lease; release ends the lock by its token and never by key', async () => {
  const { store, clock, locks } = await setup('2026-10-30T10:00:00Z');
  await takeClaim(store, 'item-9', 'run-a', HOUR, () => clock.now);
  const renewed = await renewClaim(store, 'item-9', 'run-a', 2 * HOUR, tick(clock, '2026-10-30T10:50:00Z'));
  assert.equal(renewed.ok && renewed.claim.expiresAt, '2026-10-30T12:50:00.000Z');
  const foreign = await renewClaim(store, 'item-9', 'run-b', HOUR, tick(clock, '2026-10-30T10:55:00Z'));
  assert.equal(!foreign.ok && foreign.reason, 'held');
  assert.equal(!(await releaseClaim(store, 'item-9', 'run-b', () => clock.now)).ok, true);
  const released = await releaseClaim(store, 'item-9', 'run-a', tick(clock, '2026-10-30T11:00:00Z'));
  assert.equal(released.ok && released.claim.releasedAt, '2026-10-30T11:00:00.000Z');
  // The lock was shortened to a second by its token, and lapses on its own.
  assert.equal(locks.ttlOf('claim.item-9'), 1000);
  tick(clock, '2026-10-30T11:00:02Z');
  assert.equal(locks.held('claim.item-9'), undefined);
  // A second release finds nothing, and the late holder cannot renew.
  assert.deepEqual(await releaseClaim(store, 'item-9', 'run-a', () => clock.now), { ok: false, reason: 'absent' });
  assert.deepEqual(await renewClaim(store, 'item-9', 'run-a', HOUR, () => clock.now), { ok: false, reason: 'absent' });
  assert.equal((await takeClaim(store, 'item-9', 'run-b', HOUR, tick(clock, '2026-10-30T11:02:00Z'))).ok, true);
  const newLock = locks.held('claim.item-9');
  // A run whose lease passed on cannot release the new holder's claim or lock.
  const stale = await releaseClaim(store, 'item-9', 'run-a', tick(clock, '2026-10-30T11:03:00Z'));
  assert.equal(!stale.ok && stale.reason, 'not-holder');
  assert.equal(locks.held('claim.item-9'), newLock);
});

test('a release racing a new holder\'s take leaves the new holder\'s lock alone', async () => {
  const { store, clock, locks } = await setup('2026-10-30T10:00:00Z');
  await takeClaim(store, 'race', 'run-a', HOUR, () => clock.now);
  // run-a's lease ran out; run-b has just acquired the lock but not yet written its record.
  tick(clock, '2026-10-30T11:30:00Z');
  const lease = await locks.acquire('claim.race', HOUR, 'run-b');
  assert.equal(lease.acquired, true);
  await releaseClaim(store, 'race', 'run-a', () => clock.now);
  assert.equal(locks.held('claim.race'), lease.acquired ? lease.token : 'none');
  assert.equal(locks.ttlOf('claim.race'), HOUR);
});

test('a holder whose lease ran out takes it back only while nobody else took it', async () => {
  const { store, clock } = await setup('2026-10-30T10:00:00Z');
  await takeClaim(store, 'a', 'run-a', HOUR, () => clock.now);
  const back = await renewClaim(store, 'a', 'run-a', HOUR, tick(clock, '2026-10-30T11:30:00Z'));
  assert.equal(back.ok && back.claim.takenAt, '2026-10-30T10:00:00.000Z');
  tick(clock, '2026-10-30T13:00:00Z');
  assert.equal((await takeClaim(store, 'a', 'run-b', HOUR, () => clock.now)).ok, true);
  const lost = await renewClaim(store, 'a', 'run-a', HOUR, () => clock.now);
  assert.equal(!lost.ok && lost.reason, 'held');
});

test('a lease never outlives its lock\'s day; past it the holder takes the subject again', async () => {
  const { store, clock, locks } = await setup('2026-10-30T00:00:00Z');
  await takeClaim(store, 'long', 'run-a', 12 * HOUR, () => clock.now);
  await renewClaim(store, 'long', 'run-a', 13 * HOUR, tick(clock, '2026-10-30T11:00:00Z'));
  const first = locks.held('claim.long');
  // Near the end of the lock's life, a renewal gets only what is left, and the record says so.
  const near = await renewClaim(store, 'long', 'run-a', 12 * HOUR, tick(clock, '2026-10-30T23:59:00Z'));
  assert.equal(near.ok && near.claim.expiresAt, '2026-10-30T23:59:55.000Z');
  // Past it the lock lapsed, and the holder acquires it again under a new token.
  const again = await renewClaim(store, 'long', 'run-a', 12 * HOUR, tick(clock, '2026-10-31T00:00:30Z'));
  assert.equal(again.ok && again.claim.takenAt, '2026-10-30T00:00:00.000Z');
  assert.notEqual(locks.held('claim.long'), first);
});

test('a lease is whole seconds on both the lock and the record', async () => {
  const { store, clock, locks } = await setup('2026-10-30T10:00:00Z');
  const taken = await takeClaim(store, 's', 'run-a', 1500, () => clock.now);
  assert.equal(taken.ok && taken.claim.expiresAt, '2026-10-30T10:00:02.000Z');
  assert.equal(locks.ttlOf('claim.s'), 2000);
});

test('a record that cannot be written after the lock was won ends that lock and reports the error', async () => {
  const { store, clock, locks, docs } = await setup('2026-10-30T10:00:00Z');
  const failing: DocStore = { ...docs, async replace() { throw new Error('store unreachable'); } };
  await assert.rejects(takeClaim({ docs: failing, locks }, 'w', 'run-a', HOUR, () => clock.now), /store unreachable/);
  assert.equal(locks.ttlOf('claim.w'), 1000);
  // A lock error fails closed: nothing is held and nothing is recorded.
  const broken: LockStore = { ...locks, async acquire() { throw new Error('lock service down'); } };
  await assert.rejects(takeClaim({ docs, locks: broken }, 'x', 'run-a', HOUR, () => clock.now), /lock service down/);
  assert.deepEqual(await showClaim(store, 'x', () => clock.now), { live: false, locked: false });
});

test('held with no live record names no holder; show says when the record and the lock disagree', async () => {
  const { store, clock, locks } = await setup('2026-10-30T10:00:00Z');
  await locks.acquire('claim.ghost', HOUR, 'run-z');
  const held = await takeClaim(store, 'ghost', 'run-a', HOUR, () => clock.now);
  assert.deepEqual(held, { ok: false, reason: 'held' });
  assert.deepEqual(await showClaim(store, 'ghost', () => clock.now), { live: false, locked: true });
  await takeClaim(store, 'b', 'run-b', HOUR, () => clock.now);
  const shown = await showClaim(store, 'b', () => clock.now);
  assert.deepEqual([shown.live, shown.locked, 'token' in (shown.claim ?? {})], [true, true, false]);
});

test('show lists live claims only; a release is the run\'s once its lock end succeeded, whatever the record write says', async () => {
  const { store, clock, docs } = await setup('2026-10-30T10:00:00Z');
  await takeClaim(store, 'a', 'run-a', HOUR, () => clock.now);
  await takeClaim(store, 'b', 'run-b', HOUR, () => clock.now);
  const conflicting: DocStore = { ...docs, async replace(collection, key, value, options) { return options?.etag ? 'conflict' : docs.replace(collection, key, value, options); } };
  const released = await releaseClaim({ docs: conflicting, locks: store.locks }, 'b', 'run-b', tick(clock, '2026-10-30T10:10:00Z'));
  assert.equal(released.ok, true);
  await releaseClaim(store, 'b', 'run-b', () => clock.now);
  assert.deepEqual((await liveClaims(store, tick(clock, '2026-10-30T10:20:00Z'))).map((claim) => claim.subject), ['a']);
  assert.deepEqual(await liveClaims(store, tick(clock, '2026-10-30T11:20:00Z')), []);
});

test('a subject outside the key charset and a lease over a day are refused before anything is written', async () => {
  const { store, clock, locks } = await setup('2026-10-30T10:00:00Z');
  for (const subject of ['a/b', 'a b', '..', '', 'x'.repeat(121)]) await assert.rejects(takeClaim(store, subject, 'run-a', HOUR, () => clock.now), /subject .* may only use/, subject);
  await assert.rejects(takeClaim(store, 'a', 'run with spaces', HOUR, () => clock.now), /run id/);
  await assert.rejects(takeClaim(store, 'item-21', 'run-a', 25 * HOUR, () => clock.now), /at most 24h/);
  await assert.rejects(renewClaim(store, 'item-21', 'run-a', 0, () => clock.now), /at most 24h/);
  assert.equal(locks.held('claim.item-21'), undefined);
  assert.deepEqual(await liveClaims(store, () => clock.now), []);
});

test('a take right after a release waits the second the released lock needs to lapse', async () => {
  // A clock that runs with real time from a fixed start, so the released lock lapses while the take waits.
  const started = Date.now();
  const clock = { get now(): Date { return new Date(Date.parse('2026-10-30T10:00:00Z') + Date.now() - started); } };
  const dir = await mkdtemp(join(tmpdir(), 'operator-claims-'));
  dirs.push(dir);
  const store: ClaimStore = { docs: createFileBackend(dir, 'demo').docs, locks: fakeLocks(clock) };
  await takeClaim(store, 'next', 'run-a', HOUR, () => clock.now);
  await releaseClaim(store, 'next', 'run-a', () => clock.now);
  const taken = await takeClaim(store, 'next', 'run-b', HOUR, () => clock.now);
  assert.equal(taken.ok && taken.claim.run, 'run-b');
});

test('renewals stay inside the lock\'s real day, which began a moment before the record says', async () => {
  const { store, clock, docs } = await setup('2026-10-30T00:00:00Z');
  // The backend stamps its lock three seconds before this host stamps the record.
  const early: LockStore = { ...store.locks, async acquire(key, ttlMs, reference) {
    const real = clock.now;
    clock.now = new Date(real.getTime() - 3000);
    try { return await store.locks.acquire(key, ttlMs, reference); } finally { clock.now = real; }
  } };
  const claims: ClaimStore = { docs, locks: early };
  await takeClaim(claims, 'edge', 'run-a', 13 * HOUR, () => clock.now);
  await renewClaim(claims, 'edge', 'run-a', 11 * HOUR, tick(clock, '2026-10-30T12:00:00Z'));
  await renewClaim(claims, 'edge', 'run-a', HOUR, tick(clock, '2026-10-30T22:59:00Z'));
  // Seventy seconds before the record's day ends, the lock's real day has sixty-seven left.
  const near = await renewClaim(claims, 'edge', 'run-a', HOUR, tick(clock, '2026-10-30T23:58:50Z'));
  assert.equal(near.ok && near.claim.expiresAt, '2026-10-30T23:59:55.000Z');
});

test('a renewal racing its own run\'s release does not bring the claim back', async () => {
  const { store, clock, locks, docs } = await setup('2026-10-30T10:00:00Z');
  await takeClaim(store, 'r', 'run-a', HOUR, () => clock.now);
  // The release lands between the renewal's lock extension and its record write.
  const racing: LockStore = { ...locks, async renew(key, token, ttlMs) {
    const outcome = await locks.renew(key, token, ttlMs);
    if (ttlMs > 1000) await releaseClaim(store, 'r', 'run-a', () => clock.now);
    return outcome;
  } };
  const renewed = await renewClaim({ docs, locks: racing }, 'r', 'run-a', HOUR, () => clock.now);
  assert.deepEqual(renewed, { ok: false, reason: 'absent' });
  assert.equal((await showClaim(store, 'r', () => clock.now)).claim?.releasedAt !== undefined, true);
  assert.equal(locks.ttlOf('claim.r'), 1000);
});

test('a renewal whose record vanished meanwhile ends the lock it just extended', async () => {
  const { store, clock, locks, docs } = await setup('2026-10-30T10:00:00Z');
  await takeClaim(store, 'v', 'run-a', HOUR, () => clock.now);
  const vanishing: LockStore = { ...locks, async renew(key, token, ttlMs) {
    const outcome = await locks.renew(key, token, ttlMs);
    if (ttlMs > 1000) await docs.delete('subject-claims', 'v');
    return outcome;
  } };
  const renewed = await renewClaim({ docs, locks: vanishing }, 'v', 'run-a', HOUR, () => clock.now);
  assert.deepEqual(renewed, { ok: false, reason: 'held' });
  assert.equal(locks.ttlOf('claim.v'), 1000);
});

test('a take racing its own run\'s release waits for the released lock and takes it again', async () => {
  const started = Date.now();
  const clock = { get now(): Date { return new Date(Date.parse('2026-10-30T10:00:00Z') + Date.now() - started); } };
  const dir = await mkdtemp(join(tmpdir(), 'operator-claims-'));
  dirs.push(dir);
  const locks = fakeLocks(clock);
  const store: ClaimStore = { docs: createFileBackend(dir, 'demo').docs, locks };
  await takeClaim(store, 'own', 'run-a', HOUR, () => clock.now);
  // The release lands between the take's lock extension and its record write.
  let raced = false;
  const racing: LockStore = { ...locks, async renew(key, token, ttlMs) {
    const outcome = await locks.renew(key, token, ttlMs);
    if (!raced && ttlMs > 1000) { raced = true; await releaseClaim(store, 'own', 'run-a', () => clock.now); }
    return outcome;
  } };
  const taken = await takeClaim({ docs: store.docs, locks: racing }, 'own', 'run-a', HOUR, () => clock.now);
  assert.equal(taken.ok && taken.claim.run, 'run-a');
  assert.equal(taken.ok && taken.claim.releasedAt, undefined);
});
