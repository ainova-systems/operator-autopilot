import { after, test } from 'node:test';
import { strict as assert } from 'node:assert';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { promisify } from 'node:util';
import { JobStore, type JobRecord } from './jobs.ts';
import { CLI_ENTRY } from './launch.ts';
import { createTestProject, type TestProject } from './test-support/project.ts';

const run = promisify(execFile);
// The CLI under test must never reach the herdr of the session running the suite: a daemon placing a
// run there opens a real tab, and one killed mid-test leaves it open. An unreachable socket makes
// every herdr placement degrade to headless, exactly as on a host without herdr.
const env = { ...process.env, HERDR_SOCKET_PATH: join(tmpdir(), 'operator-cli-test-no-herdr.sock') };
const projects: TestProject[] = [];
const children: ChildProcess[] = [];
after(async () => {
  for (const child of children) if (child.exitCode === null) child.kill('SIGKILL');
  for (const p of projects) await p.cleanup();
});

async function cli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await run(process.execPath, [CLI_ENTRY, ...args], { env });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failed = error as { code: number; stdout: string; stderr: string };
    return { code: failed.code, stdout: failed.stdout, stderr: failed.stderr };
  }
}

test('help, version and usage errors answer with the right exit codes', async () => {
  assert.equal((await cli(['--help'])).code, 0);
  assert.match((await cli(['--version'])).stdout, /^\d+\.\d+\.\d+\n$/);
  assert.equal((await cli(['frobnicate'])).code, 2);
  assert.equal((await cli(['trigger', 'only-workflow'])).code, 2);
});

test('validate and trigger work against a project', async () => {
  const p = await createTestProject();
  projects.push(p);
  const manifest = join(p.root, 'operator.yaml');
  const validated = await cli(['validate', '--manifest', manifest, '--describe']);
  assert.equal(validated.code, 0, validated.stderr + validated.stdout);
  assert.match(validated.stdout, /ok: .* project demo, 1 workflow\(s\), 6 operation\(s\), 2 pool\(s\), state file ready/);
  const first = await cli(['trigger', 'demo', 'poke', '--manifest', manifest, '--id', 'hook-1']);
  const second = await cli(['trigger', 'demo', 'poke', '--manifest', manifest, '--id', 'hook-1']);
  assert.match(first.stdout, /^queued job j/);
  assert.match(second.stdout, /^duplicate, dropped: job j/);
});

async function waitFor(store: JobStore, predicate: (jobs: JobRecord[]) => boolean, timeoutMs = 30_000): Promise<JobRecord[]> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const jobs = await store.list();
    if (predicate(jobs)) return jobs;
    await sleep(200);
  }
  throw new Error('condition not reached');
}

test('kill -9 of the daemon mid-job: the restart adopts the run and launches nothing twice', async () => {
  const p = await createTestProject();
  projects.push(p);
  const manifest = join(p.root, 'operator.yaml');
  const store = new JobStore(p.backend.docs, p.manifest.runtime.retentionMs);
  await p.drop('slow.work', '4');
  const output: string[] = [];
  const start = (): ChildProcess => {
    const child = spawn(process.execPath, [CLI_ENTRY, 'run', '--manifest', manifest, '--allow-file-state'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout?.on('data', (chunk: Buffer) => output.push(chunk.toString()));
    child.stderr?.on('data', (chunk: Buffer) => output.push(chunk.toString()));
    children.push(child);
    return child;
  };

  const first = start();
  await waitFor(store, (jobs) => jobs.some((job) => job.operation === 'work' && job.status === 'running'));
  first.kill('SIGKILL');
  await new Promise((resolve) => first.once('exit', resolve));

  const second = start();
  const jobs = await waitFor(store, (all) => all.some((job) => job.operation === 'finish' && job.status === 'done'));
  second.kill('SIGTERM');
  await new Promise((resolve) => second.once('exit', resolve));

  assert.deepEqual((await p.launches()).map((line) => line.split(' ')[0]), ['slow']);
  assert.equal(jobs.find((job) => job.operation === 'work')?.attempt, 1);
  const log = output.join('');
  assert.match(log, /adopted the leader lease of a daemon that stopped without releasing it/);
  assert.match(log, /resumed observing a running job/);
  assert.match(log, /daemon stopped/);
});

test('scripts cannot change the collections the runtime keeps its own records in', async () => {
  const p = await createTestProject();
  projects.push(p);
  const manifest = join(p.root, 'operator.yaml');
  for (const collection of ['jobs', 'waits', 'threads', 'deliveries', 'tabs', 'control']) {
    const refused = await cli(['state', 'delete', collection, 'x', '--manifest', manifest]);
    assert.equal(refused.code, 2, collection);
    assert.match(refused.stderr, /belongs to the runtime/);
  }
});

test('pause waits until no job runs, says so, and resume ends it', async () => {
  const p = await createTestProject();
  projects.push(p);
  const manifest = join(p.root, 'operator.yaml');
  const paused = await cli(['pause', '--manifest', manifest, '--reason', 'host restart', '--wait', '--timeout', '30s']);
  assert.equal(paused.code, 0);
  assert.match(paused.stdout, /pausing: no new job starts; 0 running job\(s\) finish first/);
  assert.match(paused.stdout, /paused: no job running/);
  assert.match((await cli(['pause', '--manifest', manifest])).stdout, /already paused since .* by /);
  assert.match((await cli(['resume', '--manifest', manifest])).stdout, /resumed/);
  assert.match((await cli(['resume', '--manifest', manifest])).stdout, /not paused/);
});
