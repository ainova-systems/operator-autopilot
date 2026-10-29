import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { randomBytes } from 'node:crypto';
import { createAinoflowBackend } from './ainoflow.ts';

// Runs against the real API only when a key is present; everything it writes expires by itself.
const apiKey = process.env['AINOFLOW_API_KEY'];
const skip = apiKey ? false : 'AINOFLOW_API_KEY is not set';
const namespace = `op-test-${randomBytes(4).toString('hex')}`;

test('live Ainoflow: storage create-only, CAS and where listing', { skip }, async () => {
  const backend = createAinoflowBackend({ apiKey: apiKey ?? '', namespace });
  assert.equal(await backend.docs.create('jobs', 'j1', { status: 'queued', n: 1 }, 600_000), 'created');
  assert.equal(await backend.docs.create('jobs', 'j1', { status: 'queued', n: 1 }, 600_000), 'exists');
  const read = await backend.docs.get<{ status: string; n: number }>('jobs', 'j1');
  assert.ok(read);
  assert.equal(await backend.docs.replace('jobs', 'j1', { status: 'running', n: 2 }, { etag: read.etag, ttlMs: 600_000 }), 'written');
  assert.equal(await backend.docs.replace('jobs', 'j1', { status: 'done', n: 3 }, { etag: read.etag, ttlMs: 600_000 }), 'conflict');
  await backend.docs.create('jobs', 'j2', { status: 'queued', n: 1 }, 600_000);
  assert.deepEqual((await backend.docs.list('jobs', { where: { status: 'running' } })).map((item) => item.key), ['j1']);
  assert.equal(await backend.docs.delete('jobs', 'j1'), true);
  assert.equal(await backend.docs.delete('jobs', 'j2'), true);
  assert.equal(await backend.docs.get('jobs', 'j1'), undefined);
});

test('live Ainoflow: shield lease acquire, renew and release', { skip }, async () => {
  const backend = createAinoflowBackend({ apiKey: apiKey ?? '', namespace });
  const lease = await backend.locks.acquire('leader', 60_000);
  assert.equal(lease.acquired, true);
  if (!lease.acquired) return;
  assert.deepEqual(await backend.locks.acquire('leader', 60_000), { acquired: false });
  assert.equal(await backend.locks.exists('leader'), true);
  assert.equal(await backend.locks.renew('leader', lease.token, 60_000), 'renewed');
  assert.equal(await backend.locks.renew('leader', 'not-the-token', 60_000), 'lost');
  await backend.locks.release('leader');
  assert.equal(await backend.locks.exists('leader'), false);
});

test('live Ainoflow: guard pool grants up to its limit and frees on release', { skip }, async () => {
  const backend = createAinoflowBackend({ apiKey: apiKey ?? '', namespace });
  const first = await backend.slots.acquire('pool.test', 1, 120_000);
  assert.equal(first.granted, true);
  const second = await backend.slots.acquire('pool.test', 1, 120_000);
  assert.equal(second.granted, false);
  if (first.granted) await backend.slots.release('pool.test', first.token);
  const third = await backend.slots.acquire('pool.test', 1, 120_000);
  assert.equal(third.granted, true);
  if (third.granted) await backend.slots.release('pool.test', third.token);
  // Leave no policy behind for this disposable key.
  await fetch(`https://api.ainoflow.io/api/v1/guard/${namespace}.pool.test/policies`, { method: 'DELETE', headers: { Authorization: `Bearer ${apiKey}` } });
});
