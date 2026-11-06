import { after, test } from 'node:test';
import { strict as assert } from 'node:assert';
import { enqueue } from './jobs.ts';
import { readJsonFile, runPath, type WrapperInfo } from './runfiles.ts';
import { parseManifest } from './manifest.ts';
import { requestPause } from './pause.ts';
import { coolingProvider, rememberQuota } from './provider-quota.ts';
import { jobsBy, pollUntil, createTestProject, type TestProject } from './test-support/project.ts';

const projects: TestProject[] = [];
after(async () => { for (const p of projects) await p.cleanup(); });

// Two hosts share one state: vm1 runs h1 and h2, vm2 runs r1.
const HOSTED = {
  pools: '  host-slot:\n    workspaces:\n      h: { count: 2, host: vm1, cwd: . }\n      r: { count: 1, host: vm2, cwd: . }\n  per: { limit: 1, perHost: true }\n',
  extraOperations: '      hosted: { kind: agent, engine: command, command: node scripts/fake-agent.mjs, pool: host-slot, timeout: 30m }\n      counted: { kind: agent, engine: command, command: node scripts/fake-agent.mjs, pool: per, timeout: 30m }',
};

async function hosted(): Promise<TestProject> {
  const p = await createTestProject(HOSTED);
  projects.push(p);
  return p;
}

function hostedJob(p: TestProject, subject: string, member?: string) {
  return enqueue(p.daemon().jobs, { project: 'demo', workflow: 'demo', operation: 'hosted', subject, input: { seconds: 1 }, trigger: { id: subject, name: 'test', kind: 'manual' }, ...(member ? { member } : {}) });
}

test('a counted group names its members and fills {name}; each member keeps its host', () => {
  const { manifest } = parseManifest(`
contract: 1
project: p
state: { provider: ainoflow }
pools:
  slots:
    workspaces:
      d: { count: 2, host: vm1, cwd: '../repo-{name}', herdr: 'repo-{name}' }
      a1: { host: vm2 }
  codex: { limit: 2, perHost: true }
workflows:
  w:
    triggers: [{ on: poke, run: s }]
    operations:
      s: { kind: script, command: node s.mjs }
`, '/work/control/operator.yaml');
  assert.deepEqual(manifest.pools.get('slots'), { kind: 'workspaces', name: 'slots', members: [
    { name: 'd1', cwd: '/work/repo-d1', herdr: 'repo-d1', host: 'vm1' },
    { name: 'd2', cwd: '/work/repo-d2', herdr: 'repo-d2', host: 'vm1' },
    { name: 'a1', cwd: '/work/control', herdr: 'a1', host: 'vm2' },
  ] });
  assert.equal((manifest.pools.get('codex') as { perHost: boolean }).perHost, true);
});

test('a member named twice, or a limit both shared and per host, is refused', () => {
  assert.throws(() => parseManifest('contract: 1\nproject: p\nstate: { provider: ainoflow }\npools:\n  s: { workspaces: { d: { count: 2 }, d1: {} } }\n  c: { limit: 1, shared: true, perHost: true }\nworkflows:\n  w:\n    triggers: [{ on: poke, run: s }]\n    operations:\n      s: { kind: script, command: node s.mjs }\n', '/r/operator.yaml'),
    (error: Error) => /workspace d1 is declared twice/.test(error.message) && /set at most one of shared or perHost/.test(error.message));
});

test('each host runs its own daemon and starts only the jobs of its own workspaces', async () => {
  const p = await hosted();
  const vm1 = p.daemon({ host: 'vm1' });
  const vm2 = p.daemon({ host: 'vm2' });
  assert.equal(await vm1.acquireLeader(), true);
  assert.equal(await vm2.acquireLeader(), true, 'a second host is not a standby');
  await hostedJob(p, 'remote', 'r1');
  await vm1.poll();
  const left = (await jobsBy(vm1, 'hosted', 'remote'))[0];
  assert.equal(left?.status, 'queued', 'vm1 leaves a job for vm2\'s workspace');
  assert.equal(left?.waitingFor, undefined, 'and writes nothing on it');
  await vm2.poll();
  const taken = (await jobsBy(vm2, 'hosted', 'remote'))[0];
  assert.equal(taken?.status, 'running');
  assert.equal(taken?.run?.host, 'vm2');
  await hostedJob(p, 'any');
  await vm1.poll();
  const any = (await jobsBy(vm1, 'hosted', 'any'))[0];
  assert.equal(any?.run?.host, 'vm1');
  assert.equal(any?.member, 'h1');
  await pollUntil(vm2, async () => (await jobsBy(vm2, 'hosted', 'remote'))[0]?.status === 'done');
  await pollUntil(vm1, async () => (await jobsBy(vm1, 'hosted', 'any'))[0]?.status === 'done');
});

test('a pause holds only the host it was asked on', async () => {
  const p = await hosted();
  const vm1 = p.daemon({ host: 'vm1' });
  const vm2 = p.daemon({ host: 'vm2' });
  await vm1.acquireLeader();
  await vm2.acquireLeader();
  await requestPause(p.backend.docs, 'test', 'restart vm1', new Date(), 'vm1');
  await hostedJob(p, 'mine', 'h1');
  await hostedJob(p, 'theirs', 'r1');
  await vm1.poll();
  await vm2.poll();
  assert.equal((await jobsBy(vm1, 'hosted', 'mine'))[0]?.status, 'queued');
  assert.equal((await jobsBy(vm2, 'hosted', 'theirs'))[0]?.status, 'running');
  await pollUntil(vm2, async () => (await jobsBy(vm2, 'hosted', 'theirs'))[0]?.status === 'done');
});

test('a provider cooldown is kept per host', async () => {
  const p = await hosted();
  const now = Date.now();
  const until = new Date(now + 3_600_000).toISOString();
  await rememberQuota(p.backend.docs, { id: 'q1', provider: 'claude', until, detectedAt: new Date(now).toISOString(), explicitReset: true, reason: 'test' }, 'vm1');
  assert.equal((await coolingProvider(p.backend.docs, 'claude', now, 'vm1'))?.until, until);
  assert.equal(await coolingProvider(p.backend.docs, 'claude', now, 'vm2'), undefined);
  assert.equal(await coolingProvider(p.backend.docs, 'claude', now), undefined);
});

test('an exclusive operation runs once across hosts polling at the same moment', async () => {
  const p = await hosted();
  const vm1 = p.daemon({ host: 'vm1' });
  const vm2 = p.daemon({ host: 'vm2' });
  await vm1.acquireLeader();
  await vm2.acquireLeader();
  for (const id of ['x', 'y']) await enqueue(vm1.jobs, { project: 'demo', workflow: 'demo', operation: 'discover', subject: '', input: {}, trigger: { id, name: 'test', kind: 'manual' } });
  await Promise.all([vm1.poll(), vm2.poll()]);
  const statuses = (await jobsBy(vm1, 'discover')).map((job) => job.status).sort();
  assert.deepEqual(statuses, ['queued', 'running']);
  await pollUntil(vm1, async () => (await jobsBy(vm1, 'discover')).every((job) => job.status !== 'running' && job.status !== 'queued'));
});

test('a perHost limit pool counts each host on its own', async () => {
  const p = await hosted();
  const vm1 = p.daemon({ host: 'vm1' });
  const vm2 = p.daemon({ host: 'vm2' });
  await vm1.acquireLeader();
  await vm2.acquireLeader();
  for (const subject of ['c1', 'c2', 'c3']) await enqueue(vm1.jobs, { project: 'demo', workflow: 'demo', operation: 'counted', subject, input: { seconds: 1 }, trigger: { id: subject, name: 'test', kind: 'manual' } });
  await vm1.poll();
  await vm2.poll();
  const jobs = await jobsBy(vm1, 'counted');
  assert.deepEqual(jobs.filter((job) => job.status === 'running').map((job) => job.run?.host).sort(), ['vm1', 'vm2']);
  assert.equal(jobs.filter((job) => job.status === 'queued').length, 1);
  await pollUntil(vm1, async () => { await vm2.poll(); return (await jobsBy(vm1, 'counted')).every((job) => job.status === 'done'); });
});

test('a hosted daemon waits while a daemon without hosts holds the project lease', async () => {
  const p = await hosted();
  const legacy = await p.backend.locks.acquire('leader', 60_000, 'old');
  assert.equal(await p.daemon({ host: 'vm1' }).acquireLeader(), false);
  await p.backend.locks.release('leader');
  assert.ok(legacy.acquired);
  assert.equal(await p.daemon({ host: 'vm1' }).acquireLeader(), true);
});

test('the wrapper records the host the daemon goes by', async () => {
  const p = await hosted();
  const vm2 = p.daemon({ host: 'vm2' });
  await vm2.acquireLeader();
  await hostedJob(p, 'named', 'r1');
  await vm2.poll();
  const job = (await jobsBy(vm2, 'hosted', 'named'))[0];
  await pollUntil(vm2, async () => (await readJsonFile<WrapperInfo>(runPath(job?.run?.runDir ?? '', 'wrapper'))) !== undefined);
  assert.equal((await readJsonFile<WrapperInfo>(runPath(job?.run?.runDir ?? '', 'wrapper')))?.host, 'vm2');
  await pollUntil(vm2, async () => (await jobsBy(vm2, 'hosted', 'named'))[0]?.status === 'done');
});

test('a run whose job another daemon took over is stopped on its own host', async () => {
  const p = await hosted();
  const vm2 = p.daemon({ host: 'vm2' });
  await vm2.acquireLeader();
  const { id } = await enqueue(vm2.jobs, { project: 'demo', workflow: 'demo', operation: 'hosted', subject: 'long', input: { seconds: 30 }, trigger: { id: 'long', name: 'test', kind: 'manual' }, member: 'r1' });
  await vm2.poll();
  const started = (await vm2.jobs.get(id))?.run?.runDir ?? '';
  await pollUntil(vm2, async () => (await readJsonFile<WrapperInfo>(runPath(started, 'wrapper'))) !== undefined);
  const wrapper = await readJsonFile<WrapperInfo>(runPath(started, 'wrapper'));
  // What a host that found the lease expired writes: the attempt requeued, its run gone.
  await vm2.jobs.update(id, (job) => { job.status = 'queued'; job.attempt += 1; delete job.run; job.notBefore = new Date(Date.now() + 3_600_000).toISOString(); return job; });
  await vm2.poll();
  await pollUntil(vm2, async () => { try { process.kill(wrapper?.pid ?? 0, 0); return false; } catch { return true; } });
});

test('a restarted daemon still stops a run taken over before its first observation', async () => {
  const p = await hosted();
  const first = p.daemon({ host: 'vm2' });
  await first.acquireLeader();
  const { id } = await enqueue(first.jobs, { project: 'demo', workflow: 'demo', operation: 'hosted', subject: 'early', input: { seconds: 30 }, trigger: { id: 'early', name: 'test', kind: 'manual' }, member: 'r1' });
  await first.poll();
  const runDir = (await first.jobs.get(id))?.run?.runDir ?? '';
  await pollUntil(first, async () => (await readJsonFile<WrapperInfo>(runPath(runDir, 'wrapper'))) !== undefined);
  const wrapper = await readJsonFile<WrapperInfo>(runPath(runDir, 'wrapper'));
  first.stop();
  await first.jobs.update(id, (job) => { job.status = 'queued'; job.attempt += 1; delete job.run; job.notBefore = new Date(Date.now() + 3_600_000).toISOString(); return job; });
  await p.backend.locks.release('leader.vm2');
  const second = p.daemon({ host: 'vm2' });
  assert.equal(await second.acquireLeader(), true);
  await second.poll();
  await pollUntil(second, async () => { try { process.kill(wrapper?.pid ?? 0, 0); return false; } catch { return true; } });
});
