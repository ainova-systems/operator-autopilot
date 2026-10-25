import { after, test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadEnvFile } from './env.ts';

const dir = mkdtempSync(join(tmpdir(), 'operator-env-'));
after(() => rmSync(dir, { recursive: true, force: true }));
const restore = (names: string[]) => { for (const name of names) delete process.env[name]; };

test('an env file adds only the named keys and never overrides the environment', () => {
  const file = join(dir, 'a.env');
  writeFileSync(file, 'OP_TEST_A=from-file\nOP_TEST_B=from-file\nOP_TEST_OTHER=x\n');
  process.env['OP_TEST_B'] = 'from-env';
  try {
    assert.deepEqual(loadEnvFile(file, ['OP_TEST_A', 'OP_TEST_B']), ['OP_TEST_A']);
    assert.equal(process.env['OP_TEST_A'], 'from-file');
    assert.equal(process.env['OP_TEST_B'], 'from-env');
    assert.equal(process.env['OP_TEST_OTHER'], undefined);
  } finally {
    restore(['OP_TEST_A', 'OP_TEST_B']);
  }
});

test('a missing env file is fine when the environment already holds every named key', () => {
  process.env['OP_TEST_KEY'] = 'set';
  try {
    assert.deepEqual(loadEnvFile(join(dir, 'missing.env'), ['OP_TEST_KEY']), []);
  } finally {
    restore(['OP_TEST_KEY']);
  }
  assert.throws(() => loadEnvFile(join(dir, 'missing.env'), ['OP_TEST_KEY']), /cannot read env file/);
  assert.throws(() => loadEnvFile(join(dir, 'missing.env')), /cannot read env file/);
});
