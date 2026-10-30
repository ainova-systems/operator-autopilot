import { after, test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addQueueItem, canMove, getQueueItem, listQueue, takeQueueItem, updateQueueItem } from './queue.ts';
import { createFileBackend } from './state/file.ts';
import type { DocStore } from './state/types.ts';

const dirs: string[] = [];
after(async () => { for (const dir of dirs) await rm(dir, { recursive: true, force: true }); });

async function store(): Promise<DocStore> {
  const dir = await mkdtemp(join(tmpdir(), 'operator-queue-'));
  dirs.push(dir);
  return createFileBackend(dir, 'demo').docs;
}

const at = (iso: string): Date => new Date(iso);

test('an added item has the full shape and the list puts the most urgent and oldest first', async () => {
  const docs = await store();
  const low = await addQueueItem(docs, { title: 'Tidy logs', body: 'spec', priority: 'low' }, at('2026-10-30T09:00:00Z'));
  const high = await addQueueItem(docs, { title: 'Fix a lost wait', body: 'spec', priority: 'high', source: { kind: 'project-session', ref: 'finding-12' } }, at('2026-10-30T10:00:00Z'));
  const highOlder = await addQueueItem(docs, { title: 'Fix a stale claim', body: 'spec', priority: 'high' }, at('2026-10-30T08:00:00Z'));
  assert.match(high.id, /^q-20261030100000-[0-9a-f]{12}$/);
  assert.deepEqual({ ...high, id: 'x' }, {
    id: 'x', title: 'Fix a lost wait', body: 'spec', priority: 'high', status: 'ready',
    source: { kind: 'project-session', ref: 'finding-12' }, createdAt: '2026-10-30T10:00:00.000Z', updatedAt: '2026-10-30T10:00:00.000Z',
  });
  assert.deepEqual((await listQueue(docs)).map((item) => item.id), [highOlder.id, high.id, low.id]);
  assert.deepEqual((await listQueue(docs, 'ready')).length, 3);
  await assert.rejects(addQueueItem(docs, { title: 'x', body: 'spec', status: 'taken' }), /starts ready, needs-decision or blocked/);
  await assert.rejects(addQueueItem(docs, { title: '  ', body: 'spec' }), /title cannot be empty/);
  await assert.rejects(addQueueItem(docs, { title: 'Fix it', body: ' \n' }), /body cannot be empty/);
});

test('two runs taking the same item: exactly one wins, and only ready or needs-decision items can be taken', async () => {
  const docs = await store();
  const item = await addQueueItem(docs, { title: 'Fix a lost wait', body: 'spec' });
  const results = await Promise.all(['run-a', 'run-b', 'run-c'].map((run) => takeQueueItem(docs, item.id, run, `change-${run}`)));
  const winners = results.filter((result) => result.ok);
  assert.equal(winners.length, 1);
  const stored = (await getQueueItem(docs, item.id)).value;
  assert.equal(stored.status, 'taken');
  assert.equal(stored.takenBy?.run, winners[0]?.item.takenBy?.run);
  for (const lost of results.filter((result) => !result.ok)) assert.ok(!lost.ok && ['conflict', 'not-takeable'].includes(lost.reason));
  // Taking a taken item is refused without a write.
  const again = await takeQueueItem(docs, item.id, 'run-z');
  assert.equal(!again.ok && again.reason, 'not-takeable');
  const decision = await addQueueItem(docs, { title: 'Decide a label', body: 'spec', status: 'needs-decision' });
  assert.equal((await takeQueueItem(docs, decision.id, 'run-q')).ok, true);
});

test('an update with a stale etag changes nothing, and status changes follow the transitions', async () => {
  const docs = await store();
  const item = await addQueueItem(docs, { title: 'Fix a lost wait', body: 'spec' });
  const read = await getQueueItem(docs, item.id);
  assert.equal((await updateQueueItem(docs, item.id, { priority: 'critical' }, read.etag)).ok, true);
  const stale = await updateQueueItem(docs, item.id, { status: 'cancelled' }, read.etag);
  assert.equal(!stale.ok && stale.reason, 'conflict');
  assert.equal((await getQueueItem(docs, item.id)).value.status, 'ready');
  // Taking goes through take, which records who took it; done is reached only from taken, and is final.
  const fresh = await getQueueItem(docs, item.id);
  await assert.rejects(updateQueueItem(docs, item.id, { status: 'taken' }, fresh.etag), /queue take/);
  await assert.rejects(updateQueueItem(docs, item.id, { status: 'done' }, fresh.etag), /cannot move from ready to done/);
  await takeQueueItem(docs, item.id, 'run-a', 'change-1');
  const taken = await getQueueItem(docs, item.id);
  const done = await updateQueueItem(docs, item.id, { status: 'done' }, taken.etag);
  assert.deepEqual(done.ok && done.item.takenBy, { run: 'run-a', ref: 'change-1' });
  const closed = await getQueueItem(docs, item.id);
  await assert.rejects(updateQueueItem(docs, item.id, { status: 'ready' }, closed.etag), /is done, which is final/);
});

test('an item handed back to the queue forgets who took it', async () => {
  const docs = await store();
  const item = await addQueueItem(docs, { title: 'Fix a lost wait', body: 'spec' });
  await takeQueueItem(docs, item.id, 'run-a');
  const taken = await getQueueItem(docs, item.id);
  const back = await updateQueueItem(docs, item.id, { status: 'needs-decision', body: 'spec\n\nWhich label?' }, taken.etag);
  assert.equal(back.ok && back.item.takenBy, undefined);
  assert.equal(back.ok && back.item.body, 'spec\n\nWhich label?');
  assert.equal(canMove('cancelled', 'ready'), false);
  assert.equal(canMove('blocked', 'ready'), true);
});

test('an add the store answers with an error is kept when it landed, and fails when nothing did', async () => {
  const docs = await store();
  const outage = new Error('store answered 500');
  const landedThenErrored: DocStore = { ...docs, async create(collection, key, value, ttlMs) { await docs.create(collection, key, value, ttlMs); throw outage; } };
  const item = await addQueueItem(landedThenErrored, { title: 'Fix a lost wait', body: 'spec' });
  assert.equal((await getQueueItem(docs, item.id)).value.title, 'Fix a lost wait');
  const failing: DocStore = { ...docs, async create() { throw outage; } };
  await assert.rejects(addQueueItem(failing, { title: 'Fix a stale claim', body: 'spec' }), /store answered 500/);
});

test('a take or update the store made but reported lost succeeds, and every success carries the item\'s new etag', async () => {
  const docs = await store();
  const lying: DocStore = { ...docs, async replace(collection, key, value, options) { await docs.replace(collection, key, value, options); return 'conflict'; } };
  const item = await addQueueItem(docs, { title: 'Fix a lost wait', body: 'spec' });
  const taken = await takeQueueItem(lying, item.id, 'run-a', 'change-1');
  assert.equal(taken.ok && taken.etag, (await getQueueItem(docs, item.id)).etag);
  const read = await getQueueItem(docs, item.id);
  const done = await updateQueueItem(lying, item.id, { status: 'done' }, read.etag);
  assert.equal(done.ok && done.item.status, 'done');
  assert.equal(done.ok && done.etag, (await getQueueItem(docs, item.id)).etag);
});

test('a done or cancelled item no longer changes, not even its title, body or priority', async () => {
  const docs = await store();
  const item = await addQueueItem(docs, { title: 'Fix a lost wait', body: 'spec' });
  const read = await getQueueItem(docs, item.id);
  await updateQueueItem(docs, item.id, { status: 'cancelled' }, read.etag);
  const closed = await getQueueItem(docs, item.id);
  for (const change of [{ title: 'Renamed' }, { body: 'new spec' }, { priority: 'low' as const }, { status: 'cancelled' as const }]) {
    await assert.rejects(updateQueueItem(docs, item.id, change, closed.etag), /is cancelled, which is final/);
  }
  assert.equal((await getQueueItem(docs, item.id)).value.title, 'Fix a lost wait');
  await assert.rejects(updateQueueItem(docs, item.id, { title: ' ' }, closed.etag), /title cannot be empty/);
  await assert.rejects(takeQueueItem(docs, item.id, 'run with space'), /run id/);
});
