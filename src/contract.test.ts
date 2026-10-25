import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { parseResult } from './contract.ts';

test('accepts a done result and defaults next subjects to the job subject', () => {
  const outcome = parseResult({ contract: 1, status: 'done', evidence: ['https://example.test/c/1'], next: [{ operation: 'review', input: { head: 'abc' } }] }, 'pr-1');
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.deepEqual(outcome.value.next, [{ operation: 'review', subject: 'pr-1', input: { head: 'abc' } }]);
  assert.deepEqual(outcome.value.evidence, ['https://example.test/c/1']);
});

test('requires a wait descriptor for needs-input and fills its defaults', () => {
  const missing = parseResult({ contract: 1, status: 'needs-input' }, 'pr-1');
  assert.equal(missing.ok, false);
  const outcome = parseResult({ contract: 1, status: 'needs-input', wait: { on: 'answer', key: 'q-1', resume: 'plan' } }, 'pr-1');
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.deepEqual(outcome.value.wait, { on: 'answer', subject: 'pr-1', key: 'q-1', resume: 'plan', input: {} });
});

test('requires a reason for failed and reads retryable strictly', () => {
  assert.equal(parseResult({ contract: 1, status: 'failed' }, 's').ok, false);
  const outcome = parseResult({ contract: 1, status: 'failed', failure: { reason: 'CI red', retryable: 'yes' } }, 's');
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.deepEqual(outcome.value.failure, { reason: 'CI red', retryable: false });
});

test('an empty wait key is refused rather than turning into a wait anyone can answer', () => {
  const outcome = parseResult({ contract: 1, status: 'needs-input', wait: { on: 'answer', key: '', resume: 'plan' } }, 's');
  assert.equal(outcome.ok, false);
});

test('reports every problem of a malformed result at once', () => {
  const outcome = parseResult({ contract: 2, status: 'finished', next: [{ subject: 3, notBefore: 'soon' }] }, 's');
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.equal(outcome.errors.length, 5);
  assert.match(outcome.errors.join('\n'), /contract: expected 1/);
  assert.match(outcome.errors.join('\n'), /next\[0\]\.notBefore/);
});

test('a next request may carry the key that makes repeating it one job', () => {
  const outcome = parseResult({ contract: 1, status: 'done', next: [{ operation: 'review', key: 'head:abc1234' }] }, 'pr-1');
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.deepEqual(outcome.value.next, [{ operation: 'review', subject: 'pr-1', input: {}, key: 'head:abc1234' }]);
  assert.equal(parseResult({ contract: 1, status: 'done', next: [{ operation: 'review', key: '' }] }, 'pr-1').ok, false);
  assert.equal(parseResult({ contract: 1, status: 'done', next: [{ operation: 'review', key: 7 }] }, 'pr-1').ok, false);
  assert.equal(parseResult({ contract: 1, status: 'done', next: [{ operation: 'review', key: 'x'.repeat(201) }] }, 'pr-1').ok, false);
});
