import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectUsageLimit, parseReset } from './usage-limit.ts';

const NOW = new Date('2026-11-04T09:30:00Z');

test('claude\'s limit prompt with a dated UTC reset is a limit until that moment', () => {
  const pane = [
    '● Usage limit reached · continuing automatically at 12pm',
    "  ⎿  You've hit your weekly limit · resets Nov 5, 12pm (UTC)",
    '   What do you want to do?',
    '   ❯ 1. Stop and wait for limit to reset',
    '     2. Wait here, then continue automatically shortly',
    '     3. Switch to usage credits',
  ].join('\n');
  assert.deepEqual(detectUsageLimit('claude', pane, NOW), { engine: 'claude', resetsAt: new Date('2026-11-05T12:00:00Z') });
});

test('a UTC reset without a date is the next time that hour comes round', () => {
  const text = "You've hit your weekly limit · resets 12pm (UTC)";
  assert.equal(detectUsageLimit('claude', text, NOW)?.resetsAt?.toISOString(), '2026-11-04T12:00:00.000Z');
  assert.equal(detectUsageLimit('claude', text, new Date('2026-11-04T13:00:00Z'))?.resetsAt?.toISOString(), '2026-11-05T12:00:00.000Z');
  assert.equal(parseReset('resets 7:30am (UTC)', NOW)?.toISOString(), '2026-11-05T07:30:00.000Z');
});

test('a limit whose reset is unreadable is still a limit, with no reset', () => {
  assert.deepEqual(detectUsageLimit('claude', 'Usage limit reached again · continuing automatically at 12pm', NOW), { engine: 'claude' });
  assert.deepEqual(detectUsageLimit('claude', "You've hit your weekly limit · resets 12pm (Europe/Helsinki)", NOW), { engine: 'claude' });
});

test('a headless claude limit names its reset as an epoch', () => {
  assert.equal(detectUsageLimit('claude', 'Claude AI usage limit reached|1762344000', NOW)?.resetsAt?.toISOString(), new Date(1762344000 * 1000).toISOString());
});

test('codex\'s limit message names its reset as a duration', () => {
  const text = "■ You've hit your usage limit. Upgrade to Pro or try again in 4 days 18 hours 33 minutes.";
  assert.equal(detectUsageLimit('codex', text, NOW)?.resetsAt?.getTime(), NOW.getTime() + ((4 * 24 + 18) * 60 + 33) * 60_000);
});

test('a permission prompt, ordinary output or an engine with no wording of its own is no limit', () => {
  assert.equal(detectUsageLimit('claude', 'Do you want to make this edit to src/a.ts?\n ❯ 1. Yes\n   2. No, and tell Claude what to do differently', NOW), undefined);
  assert.equal(detectUsageLimit('claude', 'Running the tests; the rate limit of the API is 10 requests a second.', NOW), undefined);
  assert.equal(detectUsageLimit('command', "You've hit your weekly limit · resets 12pm (UTC)", NOW), undefined);
  assert.equal(detectUsageLimit('codex', 'Usage limit reached|1762344000', NOW), undefined);
});
