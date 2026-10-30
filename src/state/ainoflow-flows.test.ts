import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { takeClaim } from '../claims.ts';
import { takeQueueItem, updateQueueItem, type QueueItem } from '../queue.ts';
import { createAinoflowBackend } from './ainoflow.ts';

type Answer = { status: number; body?: unknown; etag?: string };

/** An Ainoflow API that answers each call from a script, in order, and records what was asked. */
function scripted(answers: Answer[]): { docs: ReturnType<typeof createAinoflowBackend>['docs']; store: ReturnType<typeof createAinoflowBackend>; calls: string[] } {
  const calls: string[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const answer = answers.shift();
    calls.push(`${init?.method ?? 'GET'} ${new URL(String(input)).pathname.split('/').at(-1)} -> ${answer?.status ?? 'none'}`);
    if (!answer) throw new Error('the script ran out of answers');
    return new Response(answer.body === undefined ? null : JSON.stringify(answer.body), { status: answer.status, headers: answer.etag ? { etag: answer.etag } : {} });
  }) as typeof fetch;
  const store = createAinoflowBackend({ apiKey: 'k', namespace: 'op-demo', fetchImpl });
  return { docs: store.docs, store, calls };
}

const now = new Date('2026-10-30T10:00:00Z');
const HOUR = 3_600_000;
const claim = (run: string, expiresAt: string): Record<string, string> => ({ subject: 'item-7', run, takenAt: '2026-10-30T08:00:00.000Z', renewedAt: '2026-10-30T08:00:00.000Z', expiresAt });

test('claim take over the Ainoflow API: the Shield lock decides, and a loser reports the recorded holder', async () => {
  const won = scripted([
    { status: 201, body: { acquired: true, token: 't1' } },
    { status: 200 },
  ]);
  const taken = await takeClaim(won.store, 'item-7', 'run-a', HOUR, () => now);
  assert.equal(taken.ok && taken.claim.run, 'run-a');
  assert.deepEqual(won.calls, ['POST op-demo.claim.item-7 -> 201', 'PUT item-7 -> 200']);

  const lost = scripted([
    { status: 200, body: { acquired: false, status: 'locked', token: null } },
    { status: 200, body: { ...claim('run-b', '2026-10-30T11:00:00.000Z'), token: 't2' }, etag: '"e2"' },
    { status: 200, body: { ...claim('run-b', '2026-10-30T11:00:00.000Z'), token: 't2' }, etag: '"e2"' },
  ]);
  const held = await takeClaim(lost.store, 'item-7', 'run-a', HOUR, () => now);
  assert.equal(!held.ok && held.reason === 'held' && held.holder?.run, 'run-b');
  assert.equal(!held.ok && held.reason === 'held' && held.holder !== undefined && 'token' in held.holder, false);
});

test('a conditional replace on a key that vanished is a conflict only for callers that ask for it', async () => {
  for (const status of [404, 428]) {
    const api = scripted([{ status }, { status }]);
    assert.equal(await api.store.docs.replace('work-queue', 'q-1', {}, { etag: '"e1"', missingIsConflict: true }), 'conflict');
    // Every other caller keeps the refusal it always had.
    await assert.rejects(api.store.docs.replace('jobs', 'j-1', {}, { etag: '"e1"' }), new RegExp(`answered ${status}`));
  }
  const unconditional = scripted([{ status: 404 }]);
  await assert.rejects(unconditional.store.docs.replace('work-queue', 'q-1', {}, { missingIsConflict: true }), /answered 404/);
});

test('the Shield lock fails closed: an error or a lock without a token takes nothing and records nothing', async () => {
  const down = scripted([{ status: 503 }]);
  await assert.rejects(takeClaim(down.store, 'item-7', 'run-a', HOUR, () => now), /failed after 1 attempt/);
  assert.deepEqual(down.calls, ['POST op-demo.claim.item-7 -> 503']);
  const tokenless = scripted([{ status: 201, body: { acquired: true, token: null } }]);
  await assert.rejects(takeClaim(tokenless.store, 'item-7', 'run-a', HOUR, () => now), /without a token/);
  assert.equal(tokenless.calls.length, 1);
});

const item = (status: string, extra: Partial<QueueItem> = {}): QueueItem => ({
  id: 'q-1', title: 'Fix a lost wait', body: 'spec', priority: 'high', status: status as QueueItem['status'],
  source: { kind: 'owner' }, createdAt: '2026-10-30T08:00:00.000Z', updatedAt: '2026-10-30T08:00:00.000Z', ...extra,
});

test('queue take whose first write landed but whose retry answered 412 is the take that succeeded', async () => {
  const api = scripted([
    { status: 200, body: item('ready'), etag: '"e1"' },
    { status: 500 },
    { status: 412 },
    { status: 200, body: item('taken', { takenBy: { run: 'run-a', ref: 'change-1' }, updatedAt: now.toISOString() }), etag: '"e2"' },
  ]);
  const taken = await takeQueueItem(api.docs, 'q-1', 'run-a', 'change-1', now);
  assert.deepEqual(taken.ok ? { run: taken.item.takenBy?.run, etag: taken.etag } : taken, { run: 'run-a', etag: '"e2"' });

  // Another run's take that landed first is a loss, read from the store.
  const lost = scripted([
    { status: 200, body: item('ready'), etag: '"e1"' },
    { status: 412 },
    { status: 200, body: item('taken', { takenBy: { run: 'run-b' } }), etag: '"e3"' },
  ]);
  const result = await takeQueueItem(lost.docs, 'q-1', 'run-a', undefined, now);
  assert.equal(!result.ok && result.reason === 'conflict' && result.item.takenBy?.run, 'run-b');
});

test('queue update answered 409 by another writer reports the conflict with that writer\'s item', async () => {
  const api = scripted([
    { status: 200, body: item('ready'), etag: '"e1"' },
    { status: 409 },
    { status: 200, body: item('blocked'), etag: '"e4"' },
  ]);
  const result = await updateQueueItem(api.docs, 'q-1', { status: 'cancelled' }, '"e1"', now);
  assert.equal(!result.ok && result.reason === 'conflict' && result.item.status, 'blocked');
});
