import { after, test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { claudeSessionExists } from './claude-session.ts';

const dirs: string[] = [];
after(async () => { for (const dir of dirs) await rm(dir, { recursive: true, force: true }); });

test('a claude session exists when its transcript does, under the project dir claude derives from the cwd', async () => {
  const config = await mkdtemp(join(tmpdir(), 'operator-claude-'));
  dirs.push(config);
  const env = { CLAUDE_CONFIG_DIR: config };
  await mkdir(join(config, 'projects', '-work-my-repo-d1'), { recursive: true });
  await writeFile(join(config, 'projects', '-work-my-repo-d1', 's-1.jsonl'), '');
  assert.equal(claudeSessionExists('/work/my.repo_d1', 's-1', env), true);
  assert.equal(claudeSessionExists('/work/my.repo_d1', 's-2', env), false);
  assert.equal(claudeSessionExists('/work/other', 's-1', env), false);
  // A long path is cut at 200 characters and given claude's own hash, so it is found by its prefix.
  const long = `/work/${'x'.repeat(250)}`;
  const dir = `${long.replace(/[^a-zA-Z0-9]/g, '-').slice(0, 200)}-1abc`;
  await mkdir(join(config, 'projects', dir), { recursive: true });
  await writeFile(join(config, 'projects', dir, 's-3.jsonl'), '');
  assert.equal(claudeSessionExists(long, 's-3', env), true);
  assert.equal(claudeSessionExists(long, 's-4', env), false);
});
