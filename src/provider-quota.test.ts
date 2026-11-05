import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_QUOTA_WAIT_MS, coolingProvider, quotaFromEvent, quotaFromLines, rememberQuota } from './provider-quota.ts';
import { createFileBackend } from './state/file.ts';

const now = Date.parse('2026-11-04T12:00:00Z');
const rejected = (info: Record<string, unknown> = {}) => ({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', ...info } });

test('Claude reset time takes precedence, without a minimum or four-hour cap', () => {
  for (const hours of [1, 10]) {
    const reset = now + hours * 3_600_000;
    assert.equal(quotaFromEvent(rejected({ resetsAt: reset / 1000 }), 'claude', now)?.until, new Date(reset).toISOString());
  }
  const quota = quotaFromEvent(rejected(), 'claude', now);
  assert.equal(Date.parse(quota!.until) - now, DEFAULT_QUOTA_WAIT_MS);
  assert.equal(quota?.explicitReset, false);
  assert.equal(quotaFromEvent(rejected({ resetsAt: (now - 1_000) / 1000 }), 'claude', now), undefined);
});

test('only rejected provider events and usage errors count, never warnings or task text', () => {
  for (const status of ['allowed', 'allowed_warning']) assert.equal(quotaFromEvent(rejected({ status }), 'claude', now), undefined);
  for (const value of [
    { type: 'user', message: { content: "You've hit your limit" } },
    { type: 'assistant', message: { content: [{ type: 'text', text: "You've hit your limit" }] } },
    { type: 'assistant', isApiErrorMessage: true, error: 'authentication_failed', message: { content: [{ type: 'text', text: 'Invalid API key' }] } },
    { type: 'assistant', isApiErrorMessage: true, error: 'rate_limit', message: { content: [{ type: 'text', text: 'Too many requests per minute' }] } },
    { type: 'tool_result', content: JSON.stringify(rejected()) },
  ]) assert.equal(quotaFromEvent(value, 'claude', now), undefined);
  assert.equal(quotaFromEvent({ type: 'error', message: 'Context window exceeded' }, 'codex', now), undefined);
  assert.equal(quotaFromEvent({ type: 'item.completed', item: { text: "You've hit your usage limit" } }, 'codex', now), undefined);
});

test('Claude transcript API error resolves timezone-qualified reset clocks', () => {
  const event = { type: 'assistant', isApiErrorMessage: true, error: 'rate_limit', message: { content: [{ type: 'text', text: "You've hit your weekly limit · resets 3pm (Europe/Vilnius)" }] } };
  assert.equal(quotaFromEvent(event, 'claude', now)?.until, '2026-11-04T13:00:00.000Z');
  event.message.content[0]!.text = "You've hit your weekly limit · resets Nov 5, 12pm (UTC)";
  assert.equal(quotaFromEvent(event, 'claude', now)?.until, '2026-11-05T12:00:00.000Z');
});

test('Codex usage errors read structured, ISO and canonical rendered reset times', () => {
  const until = '2026-11-04T13:00:00.000Z';
  assert.equal(quotaFromEvent({ type: 'turn.failed', error: { code: 'usage_limit_reached', resets_at: Date.parse(until) / 1000 } }, 'codex', now)?.until, until);
  assert.equal(quotaFromEvent({ type: 'error', message: `You've hit your usage limit. Try again at ${until}` }, 'codex', now)?.until, until);
  const local = new Date('Nov 5, 2026 7:01 AM').toISOString();
  assert.equal(quotaFromEvent({ type: 'error', message: "You've hit your usage limit. To get more access now, try again at Nov 5th, 2026 7:01 AM." }, 'codex', now)?.until, local);
  assert.equal(quotaFromLines('ordinary output\n' + JSON.stringify({ type: 'error', message: "You've hit your usage limit" }) + '\n', 'codex', now)?.explicitReset, false);
});

test('Codex rendered reset uses the child timezone instead of the daemon timezone', () => {
  const event = { type: 'error', message: "You've hit your usage limit. Try again at Nov 5th, 2026 7:01 AM." };
  assert.equal(quotaFromEvent(event, 'codex', now, 'America/New_York')?.until, '2026-11-05T12:01:00.000Z');
  assert.equal(quotaFromEvent(event, 'codex', now, 'Europe/Vilnius')?.until, '2026-11-05T05:01:00.000Z');
});

test('persisted cooldown survives a new backend and repeated watchdog events do not slide it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'operator-quota-'));
  try {
    const first = createFileBackend(root, 'test');
    const detected = Date.now();
    const original = await rememberQuota(first.docs, quotaFromEvent(rejected(), 'claude', detected)!);
    const repeated = await rememberQuota(first.docs, quotaFromEvent(rejected(), 'claude', detected + 30_000)!);
    assert.equal(repeated.until, original.until);
    const restarted = createFileBackend(root, 'test');
    assert.equal((await coolingProvider(restarted.docs, 'claude', detected + 60_000))?.until, original.until);
    assert.equal(await coolingProvider(restarted.docs, 'claude', Date.parse(original.until)), undefined);
  } finally { await rm(root, { recursive: true, force: true }); }
});


test('a delayed unspecified rejection cannot replace a still-valid explicit reset', async () => {
  const root = await mkdtemp(join(tmpdir(), 'operator-quota-'));
  try {
    const backend = createFileBackend(root, 'test');
    const detected = Date.now();
    const reset = detected + 8 * 3_600_000;
    const explicit = await rememberQuota(backend.docs, quotaFromEvent(rejected({ resetsAt: reset / 1000 }), 'claude', detected)!);
    const later = await rememberQuota(backend.docs, quotaFromEvent(rejected(), 'claude', detected + 30_000)!);
    assert.deepEqual(later, explicit);
  } finally { await rm(root, { recursive: true, force: true }); }
});


test('replayed older explicit evidence cannot shorten a newer cooldown', async () => {
  const root = await mkdtemp(join(tmpdir(), 'operator-quota-'));
  try {
    const backend = createFileBackend(root, 'test');
    const detected = Date.now();
    const older = quotaFromEvent(rejected({ resetsAt: (detected + 60_000) / 1000 }), 'claude', detected)!;
    const newer = quotaFromEvent(rejected({ resetsAt: (detected + 8 * 3_600_000) / 1000 }), 'claude', detected + 1_000)!;
    await rememberQuota(backend.docs, { ...newer, detectedAt: new Date(detected - 1_000).toISOString() });
    // Re-observing the same reset must advance authority even though its window ID is unchanged.
    await rememberQuota(backend.docs, newer);
    assert.deepEqual(await rememberQuota(backend.docs, older), newer);
    assert.equal((await coolingProvider(backend.docs, 'claude', detected + 120_000))?.until, newer.until);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('concurrent live observations atomically keep the newest reset', async () => {
  const root = await mkdtemp(join(tmpdir(), 'operator-quota-'));
  try {
    const backend = createFileBackend(root, 'test');
    const detected = Date.now();
    await rememberQuota(backend.docs, quotaFromEvent(rejected({ resetsAt: (detected + 30_000) / 1000 }), 'claude', detected)!);
    const older = quotaFromEvent(rejected({ resetsAt: (detected + 60_000) / 1000 }), 'claude', detected + 1_000)!;
    const newer = quotaFromEvent(rejected({ resetsAt: (detected + 8 * 3_600_000) / 1000 }), 'claude', detected + 2_000)!;
    let releaseOlder!: () => void;
    const newerWritten = new Promise<void>((resolve) => { releaseOlder = resolve; });
    const docs = { ...backend.docs, replace: async <T>(collection: string, key: string, value: T, options?: Parameters<typeof backend.docs.replace>[3]) => {
      if ((value as { id?: string }).id === older.id) await newerWritten;
      const result = await backend.docs.replace(collection, key, value, options);
      if ((value as { id?: string }).id === newer.id) releaseOlder();
      return result;
    } };
    await Promise.all([rememberQuota(docs, older), rememberQuota(docs, newer)]);
    assert.equal((await coolingProvider(backend.docs, 'claude', detected + 120_000))?.until, newer.until);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a later unspecified event in one batch cannot erase an explicit reset', () => {
  const reset = now + 3_600_000;
  const lines = [rejected({ resetsAt: reset / 1000 }), rejected()].map((event) => JSON.stringify(event)).join('\n');
  assert.equal(quotaFromLines(lines, 'claude', now)?.until, new Date(reset).toISOString());
});

test('at equal observation times explicit reset wins over a longer default in either order', async () => {
  const root = await mkdtemp(join(tmpdir(), 'operator-quota-'));
  try {
    const detected = Date.now();
    const defaultWait = quotaFromEvent(rejected(), 'claude', detected)!;
    const explicit = quotaFromEvent(rejected({ resetsAt: (detected + 3_600_000) / 1000 }), 'claude', detected)!;
    for (const order of [[defaultWait, explicit], [explicit, defaultWait]]) {
      const backend = createFileBackend(root, order[0]!.explicitReset ? 'explicit-first' : 'default-first');
      for (const quota of order) await rememberQuota(backend.docs, quota!);
      assert.equal((await coolingProvider(backend.docs, 'claude', detected))?.until, explicit.until);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
