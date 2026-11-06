import { after, test } from 'node:test';
import { strict as assert } from 'node:assert';
import { enqueue } from './jobs.ts';
import { parseManifest } from './manifest.ts';
import { requestPause } from './pause.ts';
import { coolingProvider, rememberQuota } from './provider-quota.ts';
import { jobsBy, pollUntil, createTestProject, type TestProject } from './test-support/project.ts';

const projects: TestProject[] = [];
after(async () => { for (const p of projects) await p.cleanup(); });

// Two hosts share one state: vm1 runs h1 and h2, vm2 runs r1.
const HOSTED = {
  pools: '  host-slot:\n    workspaces:\n      h: { count: 2, host: vm1, cwd: . }\n      r: { count: 1, host: vm2, cwd: . }\n',
  extraOperations: '      hosted: { kind: agent, engine: command, command: node scripts/fake-agent.mjs, pool: host-slot, timeout: 30m }',
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
