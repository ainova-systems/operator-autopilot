import { after, test } from 'node:test';
import { strict as assert } from 'node:assert';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
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
  for (const collection of ['jobs', 'waits', 'threads', 'deliveries', 'tabs', 'control', 'subject-claims', 'work-queue']) {
    const refused = await cli(['state', 'delete', collection, 'x', '--manifest', manifest]);
    assert.equal(refused.code, 2, collection);
    assert.match(refused.stderr, /belongs to the runtime/);
  }
});

test('no command prints a lock, lease or slot token from a job or from state', async () => {
  const p = await createTestProject();
  projects.push(p);
  const manifest = join(p.root, 'operator.yaml');
  const job: JobRecord = {
    id: 'j-token', project: 'demo', workflow: 'demo', operation: 'finish', subject: 'item-1', input: {}, trigger: { id: 't', name: 'test', kind: 'manual' },
    status: 'running', attempt: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), history: [],
    run: { attempt: 1, host: 'h', runDir: '', startedAt: new Date().toISOString(), placement: { kind: 'headless' }, lease: { key: 'run.j-token', token: 'secret-lease' }, slot: { pool: 'p', kind: 'workspaces', key: 'k', token: 'secret-slot', global: false, member: 'm' } },
  } as JobRecord;
  await p.backend.docs.replace('jobs', job.id, job);
  const outputs = [
    await cli(['job', 'j-token', '--manifest', manifest]),
    await cli(['jobs', '--json', '--manifest', manifest]),
    await cli(['state', 'get', 'jobs', 'j-token', '--json', '--manifest', manifest]),
    await cli(['state', 'list', 'jobs', '--manifest', manifest]),
  ];
  for (const output of outputs) {
    assert.equal(output.code, 0, output.stderr);
    assert.match(output.stdout, /run\.j-token/);
    assert.doesNotMatch(output.stdout, /secret-|"token"/);
  }
});

test('claims and the work queue answer 0 when the write took effect and 3 when another run won', async () => {
  const p = await createTestProject();
  projects.push(p);
  const manifest = join(p.root, 'operator.yaml');
  const taken = await cli(['claim', 'take', 'item-7', '--run', 'run-a', '--ttl', '10m', '--manifest', manifest, '--json']);
  assert.equal(taken.code, 0, taken.stderr);
  assert.equal(JSON.parse(taken.stdout).claim.run, 'run-a');
  const held = await cli(['claim', 'take', 'item-7', '--run', 'run-b', '--manifest', manifest]);
  assert.equal(held.code, 3);
  assert.match(held.stdout, /^held: item-7 is held by run-a until /);
  assert.equal((await cli(['claim', 'take', 'item-7', '--manifest', manifest])).code, 2);
  // The lock token stays inside the runtime, whichever command reads the claims.
  const got = await cli(['state', 'get', 'subject-claims', 'item-7', '--manifest', manifest, '--json']);
  assert.equal(got.code, 0, got.stderr);
  assert.equal(JSON.parse(got.stdout).value.run, 'run-a');
  assert.doesNotMatch(got.stdout + (await cli(['state', 'list', 'subject-claims', '--manifest', manifest])).stdout, /token/);
  assert.match((await cli(['claim', 'show', 'item-7', '--manifest', manifest])).stdout, /^held: item-7 - record: run-a until /);
  assert.equal((await cli(['claim', 'release', 'item-7', '--run', 'run-a', '--manifest', manifest])).code, 0);
  assert.match((await cli(['claim', 'show', '--manifest', manifest])).stdout, /^no live claims/);

  const body = join(p.root, 'spec.md');
  await writeFile(body, 'The wait is lost after a restart.');
  const added = await cli(['queue', 'add', '--title', 'Fix a lost wait', '--body-file', body, '--priority', 'high', '--manifest', manifest, '--json']);
  assert.equal(added.code, 0, added.stderr);
  const id = JSON.parse(added.stdout).id as string;
  assert.equal(JSON.parse((await cli(['queue', 'list', '--status', 'ready', '--manifest', manifest, '--json'])).stdout)[0].body, 'The wait is lost after a restart.');
  const read = JSON.parse((await cli(['queue', 'get', id, '--manifest', manifest, '--json'])).stdout) as { etag: string };
  assert.equal((await cli(['queue', 'take', id, '--run', 'run-a', '--ref', 'change-3', '--manifest', manifest])).code, 0);
  assert.equal((await cli(['queue', 'take', id, '--run', 'run-b', '--manifest', manifest])).code, 3);
  const stale = await cli(['queue', 'update', id, '--status', 'done', '--if-match', read.etag, '--manifest', manifest]);
  assert.equal(stale.code, 3);
  assert.match(stale.stdout, /^conflict: /);
  assert.equal((await cli(['queue', 'update', id, '--status', 'done', '--manifest', manifest])).code, 2);
  assert.equal((await cli(['queue', 'add', '--title', 'x', '--body-file', body, '--priority', 'urgent', '--manifest', manifest])).code, 1);
});

test('claim and queue misuse is refused before anything is written', async () => {
  const p = await createTestProject();
  projects.push(p);
  const manifest = join(p.root, 'operator.yaml');
  const help = (await cli(['--help'])).stdout;
  // The global options read as one block; the claim and queue usage follows them.
  assert.ok(help.indexOf('--log-level') < help.indexOf('Claims and queue:') && help.indexOf('-v, --version') < help.indexOf('Claims and queue:'));
  assert.equal((await cli(['claim', 'take', 'a/b', '--run', 'run-a', '--manifest', manifest])).code, 2);
  assert.equal((await cli(['claim', 'take', 'item-1', '--run', 'run a', '--manifest', manifest])).code, 2);
  const tooLong = await cli(['claim', 'take', 'item-1', '--run', 'run-a', '--ttl', '400d', '--manifest', manifest]);
  assert.equal(tooLong.code, 1);
  assert.match(tooLong.stderr, /at most 24h/);
  const empty = join(p.root, 'empty.md');
  await writeFile(empty, '  \n');
  assert.equal((await cli(['queue', 'add', '--title', 'Fix it', '--body-file', empty, '--manifest', manifest])).code, 2);
  assert.equal((await cli(['queue', 'add', '--title', 'Fix it', '--body-file', '', '--manifest', manifest])).code, 2);
  assert.equal((await cli(['queue', 'add', '--title', ' ', '--body-file', empty, '--manifest', manifest])).code, 2);
  const spec = join(p.root, 'spec.md');
  await writeFile(spec, 'spec');
  const id = JSON.parse((await cli(['queue', 'add', '--title', 'Fix it', '--body-file', spec, '--manifest', manifest, '--json'])).stdout).id as string;
  const read = JSON.parse((await cli(['queue', 'get', id, '--manifest', manifest, '--json'])).stdout) as { etag: string };
  assert.equal((await cli(['queue', 'update', id, '--title', '', '--if-match', read.etag, '--manifest', manifest])).code, 2);
  assert.equal((await cli(['queue', 'take', id, '--run', 'run a', '--manifest', manifest])).code, 2);
  assert.equal(JSON.parse((await cli(['queue', 'get', id, '--manifest', manifest, '--json'])).stdout).status, 'ready');
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
