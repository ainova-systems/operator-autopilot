import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { parseDuration } from './duration.ts';

test('parses every supported unit into milliseconds', () => {
  assert.equal(parseDuration('250ms', 'x'), 250);
  assert.equal(parseDuration('30s', 'x'), 30_000);
  assert.equal(parseDuration('5m', 'x'), 300_000);
  assert.equal(parseDuration('2h', 'x'), 7_200_000);
  assert.equal(parseDuration('1d', 'x'), 86_400_000);
  assert.equal(parseDuration(90, 'x'), 90_000);
});

test('refuses a duration it cannot read and names the field', () => {
  assert.throws(() => parseDuration('5 minutes', 'workflows.dev.triggers[0].every'), /workflows\.dev\.triggers\[0\]\.every/);
  assert.throws(() => parseDuration('0s', 'x'), /expected a duration/);
  assert.throws(() => parseDuration(-1, 'x'), /expected a duration/);
});
