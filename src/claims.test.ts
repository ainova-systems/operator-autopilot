import { after, test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CLAIMS_COLLECTION, liveClaims, releaseClaim, renewClaim, showClaim, takeClaim, type ClaimRecord } from './claims.ts';
import { createFileBackend } from './state/file.ts';
import type { DocStore } from './state/types.ts';

const dirs: string[] = [];
after(async () => { for (const dir of dirs) await rm(dir, { recursive: true, force: true }); });

async function store(): Promise<DocStore> {
  const dir = await mkdtemp(join(tmpdir(), 'operator-claims-'));
  dirs.push(dir);
  return createFileBackend(dir, 'demo').docs;
}

const at = (iso: string): Date => new Date(iso);
const HOUR = 3_600_000;

test('a subject is held by one run until its lease runs out, and the holder can take it again', async () => {
  const docs = await store();
  const first = await takeClaim(docs, 'item-7', 'run-a', HOUR, at('2026-10-30T10:00:00Z'));
  assert.equal(first.ok, true);
  const second = await takeClaim(docs, 'item-7', 'run-b', HOUR, at('2026-10-30T10:30:00Z'));
  assert.deepEqual(second.ok ? null : { reason: second.reason, run: 'holder' in second ? second.holder.run : undefined }, { reason: 'held', run: 'run-a' });
  // The holder taking it again renews it and keeps when it was first taken.
  const again = await takeClaim(docs, 'item-7', 'run-a', HOUR, at('2026-10-30T10:40:00Z'));
  assert.equal(again.ok && again.claim.takenAt, '2026-10-30T10:00:00.000Z');
  assert.equal(again.ok && again.claim.expiresAt, '2026-10-30T11:40:00.000Z');
  // Once the lease has run out, another run takes the subject.
  const later = await takeClaim(docs, 'item-7', 'run-b', HOUR, at('2026-10-30T11:41:00Z'));
  assert.equal(later.ok && later.claim.run, 'run-b');
});

test('two runs taking a free subject at once: exactly one wins', async () => {
  const docs = await store();
  const now = at('2026-10-30T10:00:00Z');
  const results = await Promise.all(['run-a', 'run-b', 'run-c', 'run-d'].map((run) => takeClaim(docs, 'item-8', run, HOUR, now)));
  assert.equal(results.filter((result) => result.ok).length, 1);
  const winner = results.find((result) => result.ok);
  for (const lost of results.filter((result) => !result.ok)) assert.equal(!lost.ok && lost.reason === 'held' && lost.holder.run, winner?.ok && winner.claim.run);
});

test('renew extends only the holder\'s lease; release ends it without removing a newer holder\'s', async () => {
  const docs = await store();
  await takeClaim(docs, 'item-9', 'run-a', HOUR, at('2026-10-30T10:00:00Z'));
  const renewed = await renewClaim(docs, 'item-9', 'run-a', 2 * HOUR, at('2026-10-30T10:50:00Z'));
  assert.equal(renewed.ok && renewed.claim.expiresAt, '2026-10-30T12:50:00.000Z');
  const foreign = await renewClaim(docs, 'item-9', 'run-b', HOUR, at('2026-10-30T10:55:00Z'));
  assert.equal(!foreign.ok && foreign.reason, 'held');
  assert.equal(!(await releaseClaim(docs, 'item-9', 'run-b', at('2026-10-30T11:00:00Z'))).ok, true);
  const released = await releaseClaim(docs, 'item-9', 'run-a', at('2026-10-30T11:00:00Z'));
  assert.equal(released.ok && released.claim.releasedAt, '2026-10-30T11:00:00.000Z');
  // Released means free at once; a second release finds nothing, and the late holder cannot renew.
  assert.deepEqual(await releaseClaim(docs, 'item-9', 'run-a', at('2026-10-30T11:01:00Z')), { ok: false, reason: 'absent' });
  assert.deepEqual(await renewClaim(docs, 'item-9', 'run-a', HOUR, at('2026-10-30T11:01:00Z')), { ok: false, reason: 'absent' });
  const next = await takeClaim(docs, 'item-9', 'run-b', HOUR, at('2026-10-30T11:02:00Z'));
  assert.equal(next.ok, true);
  // A run whose lease passed on cannot release the new holder's claim.
  const stale = await releaseClaim(docs, 'item-9', 'run-a', at('2026-10-30T11:03:00Z'));
  assert.equal(!stale.ok && stale.reason, 'not-holder');
  assert.equal((await showClaim(docs, 'item-9', at('2026-10-30T11:03:00Z')))?.claim.run, 'run-b');
});

test('show lists live claims only, and a lost compare-and-set is retried, never overwritten', async () => {
  const docs = await store();
  await takeClaim(docs, 'a', 'run-a', HOUR, at('2026-10-30T10:00:00Z'));
  await takeClaim(docs, 'b', 'run-b', HOUR, at('2026-10-30T10:00:00Z'));
  await releaseClaim(docs, 'b', 'run-b', at('2026-10-30T10:10:00Z'));
  assert.deepEqual((await liveClaims(docs, at('2026-10-30T10:20:00Z'))).map((claim) => claim.subject), ['a']);
  assert.deepEqual(await liveClaims(docs, at('2026-10-30T11:20:00Z')), []);
  // A writer that changes the record between the read and the write makes the taker read again.
  let raced = false;
  const racing: DocStore = {
    ...docs,
    async replace(collection, key, value, options) {
      if (!raced && collection === CLAIMS_COLLECTION) {
        raced = true;
        const current = await docs.get<ClaimRecord>(collection, key);
        await docs.replace(collection, key, { ...current?.value, run: 'run-x', expiresAt: '2026-10-30T13:00:00.000Z' });
      }
      return docs.replace(collection, key, value, options);
    },
  };
  const taken = await takeClaim(racing, 'a', 'run-z', HOUR, at('2026-10-30T11:30:00Z'));
  assert.equal(!taken.ok && taken.reason === 'held' && taken.holder.run, 'run-x');
});

test('a run id is checked before anything is written', async () => {
  const docs = await store();
  await assert.rejects(takeClaim(docs, 'a', 'run with spaces', HOUR), /run id/);
  assert.equal(await showClaim(docs, 'a'), undefined);
});

test('a create the store answers with an error is read again: a record another taker wrote is a holder, none is a failure', async () => {
  const docs = await store();
  const now = at('2026-10-30T10:00:00Z');
  const outage = new Error('store answered 500');
  // The losing side of two simultaneous creates: the winner's record lands, this create errors.
  const losing: DocStore = {
    ...docs,
    async create(collection, key, value, ttlMs) {
      await docs.create(collection, key, { ...(value as ClaimRecord), run: 'run-winner' }, ttlMs);
      throw outage;
    },
  };
  const lost = await takeClaim(losing, 'item-10', 'run-loser', HOUR, now);
  assert.equal(!lost.ok && lost.reason === 'held' && lost.holder.run, 'run-winner');
  // An error with nothing written is a genuine failure, and so is a re-read that fails too.
  const failing: DocStore = { ...docs, async create() { throw outage; } };
  await assert.rejects(takeClaim(failing, 'item-11', 'run-a', HOUR, now), /store answered 500/);
  let reads = 0;
  const unreachable: DocStore = { ...docs, async get(collection, key) { reads += 1; if (reads > 1) throw new Error('store unreachable'); return docs.get(collection, key); }, async create() { throw outage; } };
  await assert.rejects(takeClaim(unreachable, 'item-12', 'run-a', HOUR, now), /store unreachable/);
});
