import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { takeClaim } from '../claims.ts';
import { takeQueueItem, updateQueueItem, type QueueItem } from '../queue.ts';
import { createAinoflowBackend } from './ainoflow.ts';

type Answer = { status: number; body?: unknown; etag?: string };

/** An Ainoflow API that answers each call from a script, in order, and records what was asked. */
function scripted(answers: Answer[]): { docs: ReturnType<typeof createAinoflowBackend>['docs']; calls: string[] } {
  const calls: string[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const answer = answers.shift();
    calls.push(`${init?.method ?? 'GET'} ${new URL(String(input)).pathname.split('/').at(-1)} -> ${answer?.status ?? 'none'}`);
    if (!answer) throw new Error('the script ran out of answers');
    return new Response(answer.body === undefined ? null : JSON.stringify(answer.body), { status: answer.status, headers: answer.etag ? { etag: answer.etag } : {} });
  }) as typeof fetch;
  return { docs: createAinoflowBackend({ apiKey: 'k', namespace: 'op-demo', fetchImpl }).docs, calls };
}

const now = new Date('2026-10-30T10:00:00Z');
const HOUR = 3_600_000;
const claim = (run: string, expiresAt: string): Record<string, string> => ({ subject: 'item-7', run, takenAt: '2026-10-30T08:00:00.000Z', renewedAt: '2026-10-30T08:00:00.000Z', expiresAt });

test('claim take over the Ainoflow API: a 409 create and a 412 replace are both read again as the new holder', async () => {
  const lostCreate = scripted([
    { status: 404 },
    { status: 409 },
    { status: 200, body: claim('run-b', '2026-10-30T11:00:00.000Z'), etag: '"e2"' },
  ]);
  const held = await takeClaim(lostCreate.docs, 'item-7', 'run-a', HOUR, now);
  assert.equal(!held.ok && held.reason === 'held' && held.holder.run, 'run-b');

  const lostReplace = scripted([
    { status: 200, body: claim('run-x', '2026-10-30T09:00:00.000Z'), etag: '"e1"' },
    { status: 412 },
    { status: 200, body: claim('run-b', '2026-10-30T11:00:00.000Z'), etag: '"e2"' },
  ]);
  const held2 = await takeClaim(lostReplace.docs, 'item-7', 'run-a', HOUR, now);
  assert.equal(!held2.ok && held2.reason === 'held' && held2.holder.run, 'run-b');
});

test('a conditional replace on a key that vanished is a conflict that is read again, not a crash', async () => {
  const vanished = scripted([
    { status: 200, body: claim('run-x', '2026-10-30T09:00:00.000Z'), etag: '"e1"' },
    { status: 404 },
    { status: 404 },
    { status: 201 },
  ]);
  const taken = await takeClaim(vanished.docs, 'item-7', 'run-a', HOUR, now);
  assert.equal(taken.ok && taken.claim.run, 'run-a');
  assert.deepEqual(vanished.calls.map((call) => call.split(' ')[0]), ['GET', 'PUT', 'GET', 'POST']);
  const precondition = scripted([{ status: 200, body: claim('run-x', '2026-10-30T09:00:00.000Z'), etag: '"e1"' }, { status: 428 }, { status: 404 }, { status: 201 }]);
  assert.equal((await takeClaim(precondition.docs, 'item-7', 'run-a', HOUR, now)).ok, true);
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
