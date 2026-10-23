import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { createAinoflowBackend } from './ainoflow.ts';

interface Recorded { method: string; url: URL; headers: Record<string, string>; body?: string }

function fakeFetch(answers: { status: number; body?: unknown; headers?: Record<string, string> }[]): { fetch: typeof fetch; calls: Recorded[] } {
  const calls: Recorded[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const answer = answers.shift() ?? { status: 500 };
    calls.push({ method: init?.method ?? 'GET', url: new URL(String(input)), headers: init?.headers as Record<string, string>, ...(typeof init?.body === 'string' ? { body: init.body } : {}) });
    return new Response(answer.body === undefined ? null : JSON.stringify(answer.body), { status: answer.status, headers: answer.headers ?? {} });
  }) as typeof fetch;
  return { fetch: impl, calls };
}

test('storage writes are namespaced, conditional and carry their TTL', async () => {
  const fake = fakeFetch([{ status: 201, body: {} }, { status: 409, body: {} }, { status: 412, body: {} }, { status: 200, body: {} }]);
  const backend = createAinoflowBackend({ apiKey: 'k', namespace: 'op-demo', fetchImpl: fake.fetch });
  assert.equal(await backend.docs.create('jobs', 'j1', { a: 1 }, 60_000), 'created');
  assert.equal(await backend.docs.create('jobs', 'j1', { a: 1 }), 'exists');
  assert.equal(await backend.docs.replace('jobs', 'j1', { a: 2 }, { etag: 'abc' }), 'conflict');
  assert.equal(await backend.docs.replace('jobs', 'j1', { a: 2 }, { etag: '"abc"', ttlMs: 1000 }), 'written');
  assert.equal(fake.calls[0]?.url.pathname, '/api/v1/storage/json/op-demo.jobs/j1');
  assert.equal(fake.calls[0]?.url.searchParams.get('expiresMs'), '60000');
  assert.equal(fake.calls[0]?.headers['Authorization'], 'Bearer k');
  assert.equal(fake.calls[2]?.headers['If-Match'], '"abc"');
  assert.equal(fake.calls[3]?.headers['If-Match'], '"abc"');
});

test('a read carries the ETag and a list pages through where filters', async () => {
  const page = Array.from({ length: 500 }, (_, i) => ({ key: `k${i}`, value: { i } }));
  const fake = fakeFetch([{ status: 200, body: { x: 1 }, headers: { etag: '"e1"' } }, { status: 404 }, { status: 200, body: page }, { status: 200, body: [{ key: 'last', value: {} }] }]);
  const backend = createAinoflowBackend({ apiKey: 'k', namespace: 'op-demo', fetchImpl: fake.fetch });
  assert.deepEqual(await backend.docs.get('jobs', 'j1'), { key: 'j1', value: { x: 1 }, etag: '"e1"' });
  assert.equal(await backend.docs.get('jobs', 'missing'), undefined);
  const items = await backend.docs.list('jobs', { where: { status: 'queued', workflow: 'demo' } });
  assert.equal(items.length, 501);
  assert.deepEqual(fake.calls[2]?.url.searchParams.getAll('where'), ['status:queued', 'workflow:demo']);
  assert.equal(fake.calls[3]?.url.searchParams.get('page'), '2');
});

test('shield and guard answers become plain outcomes', async () => {
  const fake = fakeFetch([
    { status: 201, body: { acquired: true, token: 't1' } },
    { status: 200, body: { acquired: false, status: 'duplicate', token: null } },
    { status: 409, body: { title: 'Lock has exceeded maximum lifetime' } },
    { status: 409, body: { title: 'Provided token does not match lock owner' } },
    { status: 200, body: { allowed: true, concurrency: { slotToken: 's1' } } },
    { status: 200, body: { allowed: false, verdict: 'queued', retryAfter: 17, concurrency: { slotToken: null } } },
  ]);
  const backend = createAinoflowBackend({ apiKey: 'k', namespace: 'op-demo', fetchImpl: fake.fetch });
  assert.deepEqual(await backend.locks.acquire('leader', 60_000), { acquired: true, token: 't1' });
  assert.deepEqual(await backend.locks.acquire('leader', 60_000), { acquired: false });
  assert.equal(await backend.locks.renew('leader', 't1', 60_000), 'lifetime-exceeded');
  assert.equal(await backend.locks.renew('leader', 'tX', 60_000), 'lost');
  assert.deepEqual(await backend.slots.acquire('pool.codex-review', 3, 3_600_000, { global: true }), { granted: true, token: 's1' });
  assert.deepEqual(await backend.slots.acquire('pool.codex-review', 3, 3_600_000), { granted: false, retryAfterMs: 17_000 });
  assert.equal(fake.calls[0]?.url.pathname, '/api/v1/shield/op-demo.leader');
  assert.equal(fake.calls[0]?.url.searchParams.get('returnSuccess'), 'true');
  assert.equal(fake.calls[4]?.url.pathname, '/api/v1/guard/operator.pool.codex-review/counter');
  assert.equal(fake.calls[4]?.url.searchParams.get('allowPolicyOverwrite'), 'true');
  assert.equal(fake.calls[5]?.url.pathname, '/api/v1/guard/op-demo.pool.codex-review/counter');
});

test('server errors are retried and a refusal names its status', async () => {
  const fake = fakeFetch([{ status: 502 }, { status: 200, body: { storageIfMatch: true, limits: { shieldLocksMonthly: 20000 } } }, { status: 401, body: { title: 'Unauthorized' } }]);
  const backend = createAinoflowBackend({ apiKey: 'k', namespace: 'op-demo', fetchImpl: fake.fetch });
  const capabilities = await backend.capabilities();
  assert.equal(capabilities.features['storageIfMatch'], true);
  assert.equal(capabilities.limits['shieldLocksMonthly'], 20000);
  await assert.rejects(backend.docs.get('jobs', 'j1'), /answered 401: Unauthorized/);
});

test('keys that would not survive a URL path are refused before any call', async () => {
  const fake = fakeFetch([]);
  const backend = createAinoflowBackend({ apiKey: 'k', namespace: 'op-demo', fetchImpl: fake.fetch });
  await assert.rejects(backend.docs.get('jobs', 'a/b'), /may only use letters/);
  await assert.rejects(backend.docs.get('jobs', '..'), /may only use letters/);
  assert.equal(fake.calls.length, 0);
});

test('a lost answer to an acquisition is not repeated', async () => {
  const fake = fakeFetch([{ status: 503 }]);
  const backend = createAinoflowBackend({ apiKey: 'k', namespace: 'op-demo', fetchImpl: fake.fetch });
  await assert.rejects(backend.slots.acquire('pool.p', 1, 60_000), /failed after 1 attempt/);
  assert.equal(fake.calls.length, 1);
});
