import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { parseCron } from './cron.ts';

test('matches weekday mornings in the workflow time zone, not in UTC', () => {
  const schedule = parseCron('0 6 * * 1-5', 'Europe/Vilnius');
  // 2026-10-23 is a Friday; 06:00 in Vilnius (UTC+3 in October) is 03:00 UTC.
  assert.equal(schedule.matches(new Date('2026-10-23T03:00:00Z')), true);
  assert.equal(schedule.matches(new Date('2026-10-23T06:00:00Z')), false);
  // Saturday 06:00 Vilnius.
  assert.equal(schedule.matches(new Date('2026-10-24T03:00:00Z')), false);
});

test('supports lists, ranges and steps', () => {
  const schedule = parseCron('*/15 9-17 * * *', 'UTC');
  assert.equal(schedule.matches(new Date('2026-10-23T09:45:00Z')), true);
  assert.equal(schedule.matches(new Date('2026-10-23T09:50:00Z')), false);
  assert.equal(schedule.matches(new Date('2026-10-23T18:00:00Z')), false);
  assert.equal(parseCron('0 0 1,15 * *', 'UTC').matches(new Date('2026-10-15T00:00:00Z')), true);
});

test('treats day-of-week 7 as Sunday', () => {
  assert.equal(parseCron('0 12 * * 7', 'UTC').matches(new Date('2026-10-25T12:00:00Z')), true);
});

test('refuses malformed expressions and unknown time zones by name', () => {
  assert.throws(() => parseCron('0 6 * *', 'UTC'), /expected 5 fields/);
  assert.throws(() => parseCron('61 * * * *', 'UTC'), /minute "61" is outside 0-59/);
  assert.throws(() => parseCron('0 6 * * 1', 'Mars/Olympus'), /unknown time zone/);
});
