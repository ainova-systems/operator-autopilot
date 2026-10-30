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
  assert.match(high.id, /^q-20261030100000-[0-9a-f]{6}$/);
  assert.deepEqual({ ...high, id: 'x' }, {
    id: 'x', title: 'Fix a lost wait', body: 'spec', priority: 'high', status: 'ready',
    source: { kind: 'project-session', ref: 'finding-12' }, createdAt: '2026-10-30T10:00:00.000Z', updatedAt: '2026-10-30T10:00:00.000Z',
  });
  assert.deepEqual((await listQueue(docs)).map((item) => item.id), [highOlder.id, high.id, low.id]);
  assert.deepEqual((await listQueue(docs, 'ready')).length, 3);
  await assert.rejects(addQueueItem(docs, { title: 'x', body: '', status: 'taken' }), /starts ready, needs-decision or blocked/);
  await assert.rejects(addQueueItem(docs, { title: '  ', body: '' }), /needs a title/);
});

test('two runs taking the same item: exactly one wins, and only ready or needs-decision items can be taken', async () => {
  const docs = await store();
  const item = await addQueueItem(docs, { title: 'Fix a lost wait', body: 'spec' });
  const results = await Promise.all(['run-a', 'run-b', 'run-c'].map((run) => takeQueueItem(docs, item.id, run, `pr-${run}`)));
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
  await takeQueueItem(docs, item.id, 'run-a', 'pr-1');
  const taken = await getQueueItem(docs, item.id);
  const done = await updateQueueItem(docs, item.id, { status: 'done' }, taken.etag);
  assert.deepEqual(done.ok && done.item.takenBy, { run: 'run-a', pr: 'pr-1' });
  const closed = await getQueueItem(docs, item.id);
  await assert.rejects(updateQueueItem(docs, item.id, { status: 'ready' }, closed.etag), /cannot move from done to ready/);
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
