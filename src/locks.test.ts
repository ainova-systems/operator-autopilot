import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { END_MS, EndingLocks, endOwnedLock, retakeLock } from './locks.ts';
import type { LockStore } from './state/types.ts';

function locksAnswering(answers: { renew?: Awaited<ReturnType<LockStore['renew']>>; acquired?: boolean[] }): LockStore & { renewals: number[] } {
  const acquired = [...(answers.acquired ?? [])];
  const renewals: number[] = [];
  return {
    renewals,
    acquire: async () => (acquired.shift() ? { acquired: true, token: 'new-token' } : { acquired: false }),
    renew: async (_key, _token, ttlMs) => { renewals.push(ttlMs); return answers.renew ?? 'renewed'; },
    complete: async () => undefined,
    exists: async () => true,
    release: async () => { throw new Error('no lock is deleted by key'); },
  };
}

test('a lock is given back by shortening it with its token, and the answer says how that went', async () => {
  const ended = locksAnswering({ renew: 'renewed' });
  assert.equal(await endOwnedLock(ended, 'k', 't'), 'ended');
  assert.deepEqual(ended.renewals, [END_MS]);
  assert.equal(await endOwnedLock(locksAnswering({ renew: 'lifetime-exceeded' }), 'k', 't'), 'lifetime-exceeded');
  assert.equal(await endOwnedLock(locksAnswering({ renew: 'lost' }), 'k', 't'), 'lost');
});

test('a lock is taken again as soon as its old lease lapsed, and given up when another holder keeps it', async () => {
  assert.equal(await retakeLock(locksAnswering({ acquired: [false, false, true] }), 'k', 60_000, 'r', 5000), 'new-token');
  assert.equal(await retakeLock(locksAnswering({ acquired: [] }), 'k', 60_000, 'r', 300), undefined);
});

test('an ended lock is waited out for its last second only, and lapsed entries are forgotten', () => {
  let now = 1_000_000;
  const ending = new EndingLocks(() => now);
  ending.ended('a');
  assert.equal(ending.remaining('a'), END_MS + 100);
  assert.equal(ending.remaining('other'), 0);
  now += 600;
  assert.equal(ending.remaining('a'), END_MS + 100 - 600);
  now += 600;
  assert.equal(ending.remaining('a'), 0);
  // A daemon that ends a lock per finished job keeps only the ones still lapsing.
  for (let job = 0; job < 50; job += 1) { ending.ended(`run.${job}`); now += 2000; }
  assert.equal(ending.size, 1);
});

test('no runtime code deletes a lock by key', async () => {
  const src = fileURLToPath(new URL('.', import.meta.url));
  const offenders: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) { if (entry.name !== 'state' && entry.name !== 'test-support') await walk(path); continue; }
      if (!entry.name.endsWith('.ts') || entry.name.endsWith('.test.ts')) continue;
      if (/locks\.release\(/.test(await readFile(path, 'utf8'))) offenders.push(path);
    }
  };
  await walk(src);
  assert.deepEqual(offenders, []);
});
