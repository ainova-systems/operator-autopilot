import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { nextTarget } from './align-next.mjs';

const script = fileURLToPath(new URL('./align-next.mjs', import.meta.url));
const { name } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

// Runs the script against a fake npm on PATH that answers `npm view` with `tags` (or fails when it
// is null) and logs every call; returns the exit status and the logged calls.
function align(version, tags) {
  const dir = mkdtempSync(join(tmpdir(), 'align-next-'));
  try {
    const log = join(dir, 'calls.log');
    writeFileSync(join(dir, 'tags.json'), tags === null ? '' : JSON.stringify(tags));
    writeFileSync(join(dir, 'npm'), [
      '#!/bin/sh',
      `echo "$*" >> '${log}'`,
      'if [ "$1" = view ]; then',
      `  [ -s '${join(dir, 'tags.json')}' ] || { echo 'npm error code E500' >&2; exit 1; }`,
      `  cat '${join(dir, 'tags.json')}'`,
      'fi',
      '',
    ].join('\n'));
    chmodSync(join(dir, 'npm'), 0o755);
    let status = 0;
    try {
      execFileSync(process.execPath, [script, version], { env: { ...process.env, PATH: `${dir}:${process.env.PATH}` }, stdio: 'pipe' });
    } catch (error) {
      status = error.status;
    }
    const calls = readFileSync(log, { encoding: 'utf8', flag: 'a+' }).split('\n').filter(Boolean);
    return { status, calls };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('next moves to a final release from an older version or its own release candidate, and stays on a newer one', () => {
  assert.equal(nextTarget('0.7.0-rc.1', '0.10.2'), '0.10.2');
  assert.equal(nextTarget('0.10.2-rc.3', '0.10.2'), '0.10.2');
  assert.equal(nextTarget('0.10.1', '0.10.2'), '0.10.2');
  assert.equal(nextTarget(undefined, '0.10.2'), '0.10.2');
  assert.equal(nextTarget('0.10.2', '0.10.2'), undefined);
  assert.equal(nextTarget('0.11.0-rc.1', '0.10.2'), undefined);
  assert.equal(nextTarget('1.0.0-rc.1', '0.10.2'), undefined);
});

test('a final release points a stale next at itself through npm dist-tag', () => {
  const { status, calls } = align('0.10.2', { latest: '0.10.2', next: '0.7.0-rc.1' });
  assert.equal(status, 0);
  assert.deepEqual(calls, [`view ${name} dist-tags --json`, `dist-tag add ${name}@0.10.2 next`]);
});

test('an unset next is pointed at the final release', () => {
  const { status, calls } = align('0.10.2', { latest: '0.10.2' });
  assert.equal(status, 0);
  assert.deepEqual(calls.slice(1), [`dist-tag add ${name}@0.10.2 next`]);
});

test('a next holding a newer release candidate is left alone', () => {
  const { status, calls } = align('0.10.2', { latest: '0.10.2', next: '0.11.0-rc.1' });
  assert.equal(status, 0);
  assert.deepEqual(calls, [`view ${name} dist-tags --json`]);
});

test('a failed dist-tag read fails the step and moves no tag', () => {
  const { status, calls } = align('0.10.2', null);
  assert.notEqual(status, 0);
  assert.deepEqual(calls, [`view ${name} dist-tags --json`]);
});

test('a version that is not a final release is refused before npm is called', () => {
  const { status, calls } = align('0.10.2-rc.1', { latest: '0.10.1' });
  assert.equal(status, 2);
  assert.deepEqual(calls, []);
});
