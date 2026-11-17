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

test('one request as next and one value or a map of strings as evidence are read as the lists they mean', () => {
  const outcome = parseResult({ contract: 1, status: 'done', evidence: { head: 'abc', pr: 'https://example.test/pr/1' }, next: { operation: 'review', key: 'review:abc', input: { head: 'abc' } } }, 'pr-1');
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.deepEqual(outcome.value.evidence, ['abc', 'https://example.test/pr/1']);
  assert.deepEqual(outcome.value.next, [{ operation: 'review', subject: 'pr-1', input: { head: 'abc' }, key: 'review:abc' }]);
  const single = parseResult({ contract: 1, status: 'done', evidence: 'https://example.test/c/1' }, 'pr-1');
  assert.equal(single.ok && single.value.evidence[0], 'https://example.test/c/1');
  const nested = parseResult({ contract: 1, status: 'done', evidence: { pr: { number: 1 } }, next: 'review' }, 'pr-1');
  assert.equal(nested.ok, false);
  if (!nested.ok) assert.deepEqual(nested.errors, ['evidence: expected an array of strings', 'next: expected an array']);
  for (const notARequest of [{}, { subject: 3, notBefore: 'soon' }]) {
    const refused = parseResult({ contract: 1, status: 'done', next: notARequest }, 'pr-1');
    assert.equal(refused.ok, false);
    if (!refused.ok) assert.deepEqual(refused.errors, ['next: expected an array']);
  }
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

test('a next request and a wait may name the workspace member their operation runs in', () => {
  const outcome = parseResult({ contract: 1, status: 'needs-input', next: [{ operation: 'review', member: 'd1' }], wait: { on: 'answer', resume: 'plan', member: 'd1' } }, 'pr-1');
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.equal(outcome.value.next[0]?.member, 'd1');
  assert.equal(outcome.value.wait?.member, 'd1');
  const bad = parseResult({ contract: 1, status: 'done', next: [{ operation: 'review', member: 'D 1' }] }, 'pr-1');
  assert.equal(bad.ok, false);
  if (bad.ok) return;
  assert.match(bad.errors.join('\n'), /next\[0\]\.member: expected a workspace member name/);
});

test('endSubjects names subjects whose work is over, and a result without it is unchanged', () => {
  const outcome = parseResult({ contract: 1, status: 'done', endSubjects: ['pr-7', 'pr-8', 'pr-7'] }, 's');
  assert.equal(outcome.ok, true);
  if (outcome.ok) assert.deepEqual(outcome.value.endSubjects, ['pr-7', 'pr-8']);
  const plain = parseResult({ contract: 1, status: 'done' }, 's');
  assert.equal(plain.ok && plain.value.endSubjects, undefined);
  const empty = parseResult({ contract: 1, status: 'noop', endSubjects: [] }, 's');
  assert.equal(empty.ok && empty.value.endSubjects, undefined);
  const bad = parseResult({ contract: 1, status: 'done', endSubjects: ['pr-7', ''] }, 's');
  assert.equal(bad.ok, false);
  if (!bad.ok) assert.deepEqual(bad.errors, ['endSubjects: expected an array of non-empty strings']);
});
