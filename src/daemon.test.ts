import { after, test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { enqueue } from './jobs.ts';
import { setTimeout as sleep } from 'node:timers/promises';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { HerdrRefusal, type Herdr } from './herdr.ts';
import { processAlive, readJsonFile, runPath, type CommandInfo, type WrapperInfo } from './runfiles.ts';
import { absentHerdr, createTestProject, jobsBy, pollUntil, type TestProject } from './test-support/project.ts';
import { fireTrigger } from './triggers.ts';
import { clearPause, readPause, requestPause } from './pause.ts';

const projects: TestProject[] = [];
async function project(options?: Parameters<typeof createTestProject>[0]): Promise<TestProject> {
  const created = await createTestProject(options);
  projects.push(created);
  return created;
}
after(async () => { for (const p of projects) await p.cleanup(); });

function discover(p: TestProject, id: string) {
  return enqueue(p.daemon().jobs, { project: 'demo', workflow: 'demo', operation: 'discover', subject: '', input: {}, trigger: { id, name: 'test', kind: 'manual' } });
}

test('a discovered item runs through script, agent and follow-on operation', async () => {
  const p = await project();
  const daemon = p.daemon();
  assert.equal(await daemon.acquireLeader(), true);
  await p.drop('item-1.work', '1');
  await discover(p, 't1');
  await pollUntil(daemon, async () => (await jobsBy(daemon, 'finish', 'item-1'))[0]?.status === 'done');
  const [discoverJob] = await jobsBy(daemon, 'discover');
  const [work] = await jobsBy(daemon, 'work', 'item-1');
  assert.equal(discoverJob?.status, 'done');
  assert.equal(work?.status, 'done');
  assert.deepEqual(discoverJob?.outcome?.next, [work?.id]);
  assert.equal(work?.run?.placement.degraded, 'herdr is not reachable');
  assert.deepEqual(JSON.parse(await readFile(join(p.data, 'done', 'item-1.done'), 'utf8')), { worked: 1 });
  assert.equal(daemon.launches, 3);
});

test('an empty discovery is noop and starts nothing else', async () => {
  const p = await project();
  const daemon = p.daemon();
  await daemon.acquireLeader();
  await discover(p, 't1');
  await pollUntil(daemon, async () => (await jobsBy(daemon, 'discover'))[0]?.status === 'noop');
  assert.equal((await daemon.jobs.list()).length, 1);
});

test('the same trigger id twice is one job', async () => {
  const p = await project();
  const daemon = p.daemon();
  const first = await fireTrigger(p.manifest, daemon.jobs, daemon.waits, { workflow: 'demo', name: 'poke', subject: '', input: {}, id: 'hook-42' });
  const second = await fireTrigger(p.manifest, daemon.jobs, daemon.waits, { workflow: 'demo', name: 'poke', subject: '', input: {}, id: 'hook-42' });
  assert.equal(first.started?.created, true);
  assert.equal(second.duplicate, true);
  assert.equal(second.started?.jobId, first.started?.jobId);
  assert.equal((await daemon.jobs.list()).length, 1);
});

test('a timer slot fires once however often the daemon ticks', async () => {
  const p = await project();
  const daemon = p.daemon();
  await daemon.acquireLeader();
  const now = new Date('2026-10-23T10:00:30Z');
  await daemon.tick(now);
  await daemon.tick(new Date('2026-10-23T10:00:45Z'));
  const restarted = p.daemon();
  await p.backend.locks.release('leader');
  await restarted.acquireLeader();
  await restarted.tick(new Date('2026-10-23T10:00:50Z'));
  assert.equal((await jobsBy(daemon, 'discover')).length, 1);
  await restarted.tick(new Date('2026-10-23T10:01:05Z'));
  assert.equal((await jobsBy(daemon, 'discover')).length, 2);
});

test('a full pool queues the job and says why', async () => {
  const p = await project();
  const daemon = p.daemon();
  await daemon.acquireLeader();
  for (const subject of ['a', 'b']) {
    await enqueue(daemon.jobs, { project: 'demo', workflow: 'demo', operation: 'work', subject, input: { seconds: 2 }, trigger: { id: subject, name: 'test', kind: 'manual' } });
  }
  await daemon.poll();
  const [a, b] = [(await jobsBy(daemon, 'work', 'a'))[0], (await jobsBy(daemon, 'work', 'b'))[0]];
  assert.equal(a?.status, 'running');
  assert.equal(b?.status, 'queued');
  assert.match(b?.waitingFor ?? '', /every workspace of pool agent-slot is busy/);
  await pollUntil(daemon, async () => (await jobsBy(daemon, 'work', 'b'))[0]?.status === 'done');
  assert.equal((await p.launches()).length, 2);
});

test('a question waits across a restart and resumes on the answer trigger', async () => {
  const p = await project();
  const daemon = p.daemon();
  await daemon.acquireLeader();
  await p.drop('item-2.ask');
  await discover(p, 't1');
  await pollUntil(daemon, async () => (await jobsBy(daemon, 'ask', 'item-2'))[0]?.status === 'needs-input');
  const [wait] = await daemon.waits.listOpen();
  assert.equal(wait?.key, 'q1');

  await p.backend.locks.release('leader');
  const restarted = p.daemon();
  assert.equal(await restarted.acquireLeader(), true);
  assert.equal((await restarted.waits.listOpen()).length, 1);
  await assert.rejects(fireTrigger(p.manifest, restarted.jobs, restarted.waits, { workflow: 'demo', name: 'answer', subject: 'item-2', key: 'q2', input: { answer: 'no' } }), /matched no open wait/);
  const answered = await fireTrigger(p.manifest, restarted.jobs, restarted.waits, { workflow: 'demo', name: 'answer', subject: 'item-2', key: 'q1', id: 'comment-9', input: { answer: 'yes' } });
  assert.equal(answered.resumed.length, 1);
  // The same delivery again (a repeated poll) is recognised, even though the wait is now closed.
  const repeated = await fireTrigger(p.manifest, restarted.jobs, restarted.waits, { workflow: 'demo', name: 'answer', subject: 'item-2', key: 'q1', id: 'comment-9', input: { answer: 'yes' } });
  assert.equal(repeated.duplicate, true);
  assert.equal(repeated.resumed[0]?.jobId, answered.resumed[0]?.jobId);
  await pollUntil(restarted, async () => (await jobsBy(restarted, 'answered', 'item-2'))[0]?.status === 'done');
  assert.deepEqual(JSON.parse(await readFile(join(p.data, 'done', 'item-2.answer'), 'utf8')), { question: 'q1', answer: 'yes' });
  assert.equal((await restarted.waits.listOpen()).length, 0);
});

test('a restarted daemon adopts the running job instead of starting it again', async () => {
  const p = await project();
  const first = p.daemon();
  await first.acquireLeader();
  await enqueue(first.jobs, { project: 'demo', workflow: 'demo', operation: 'work', subject: 'long', input: { seconds: 3 }, trigger: { id: 'x', name: 'test', kind: 'manual' } });
  await first.poll();
  assert.equal((await jobsBy(first, 'work', 'long'))[0]?.status, 'running');

  // The first daemon is gone without releasing anything; a new one takes over.
  await p.backend.locks.release('leader');
  const second = p.daemon();
  await second.acquireLeader();
  await pollUntil(second, async () => (await jobsBy(second, 'finish', 'long'))[0]?.status === 'done');
  assert.equal(second.launches, 1, 'only the finish step was started by the new daemon');
  assert.equal((await p.launches()).length, 1);
  assert.equal((await jobsBy(second, 'work', 'long'))[0]?.attempt, 1);
});

test('a run whose wrapper died is interrupted and runs again', async () => {
  const p = await project();
  const daemon = p.daemon();
  await daemon.acquireLeader();
  await enqueue(daemon.jobs, { project: 'demo', workflow: 'demo', operation: 'work', subject: 'crash', input: { seconds: 5 }, trigger: { id: 'x', name: 'test', kind: 'manual' } });
  await daemon.poll();
  const job = (await jobsBy(daemon, 'work', 'crash'))[0];
  const runDir = job?.run?.runDir ?? '';
  await pollUntil(daemon, async () => (await readJsonFile<WrapperInfo>(runPath(runDir, 'wrapper'))) !== undefined);
  const wrapper = await readJsonFile<WrapperInfo>(runPath(runDir, 'wrapper'));
  await pollUntil(daemon, async () => (await readJsonFile<CommandInfo>(runPath(runDir, 'command'))) !== undefined);
  const command = await readJsonFile<CommandInfo>(runPath(runDir, 'command'));
  process.kill(wrapper?.pid ?? 0, 'SIGKILL');
  await pollUntil(daemon, async () => (await jobsBy(daemon, 'work', 'crash'))[0]?.attempt === 2);
  const retried = (await jobsBy(daemon, 'work', 'crash'))[0];
  assert.ok(retried?.history.some((entry) => entry.event === 'interrupted'));
  // The orphaned command of attempt 1 is stopped, so it cannot overlap attempt 2.
  await sleep(200);
  assert.equal(processAlive(command?.pid ?? 0), false);
  await pollUntil(daemon, async () => (await jobsBy(daemon, 'work', 'crash'))[0]?.status === 'done', 30_000);
});

test('a retryable failure runs again within the configured retries', async () => {
  const p = await project({ extraOperations: '      flaky: { kind: script, command: node scripts/fake-agent.mjs, retries: 1, retryDelay: 100ms }' });
  const daemon = p.daemon();
  await daemon.acquireLeader();
  await enqueue(daemon.jobs, { project: 'demo', workflow: 'demo', operation: 'flaky', subject: 'f', input: { seconds: 1, fail: 'retryable' }, trigger: { id: 'x', name: 'test', kind: 'manual' } });
  await pollUntil(daemon, async () => (await jobsBy(daemon, 'flaky', 'f'))[0]?.status === 'failed');
  const job = (await jobsBy(daemon, 'flaky', 'f'))[0];
  assert.equal(job?.attempt, 2);
  assert.equal(job?.outcome?.failure?.reason, 'demo failure');
  assert.equal((await p.launches()).length, 2);
});

test('a result asking for an operation the workflow lacks fails the job', async () => {
  const p = await project({ extraOperations: '      stray: { kind: script, command: "node -e \\"require(\'fs\').writeFileSync(process.env.OPERATOR_RESULT, JSON.stringify({contract:1,status:\'done\',next:[{operation:\'nowhere\'}]}))\\"" }' });
  const daemon = p.daemon();
  await daemon.acquireLeader();
  await enqueue(daemon.jobs, { project: 'demo', workflow: 'demo', operation: 'stray', subject: 's', input: {}, trigger: { id: 'x', name: 'test', kind: 'manual' } });
  await pollUntil(daemon, async () => (await jobsBy(daemon, 'stray', 's'))[0]?.status === 'failed');
  assert.match((await jobsBy(daemon, 'stray', 's'))[0]?.outcome?.failure?.reason ?? '', /unknown operation\(s\): nowhere/);
});

test('exit 0 without a result file is a failure, not a success', async () => {
  const p = await project({ extraOperations: '      silent: { kind: script, command: "true" }' });
  const daemon = p.daemon();
  await daemon.acquireLeader();
  await enqueue(daemon.jobs, { project: 'demo', workflow: 'demo', operation: 'silent', subject: 's', input: {}, trigger: { id: 'x', name: 'test', kind: 'manual' } });
  await pollUntil(daemon, async () => (await jobsBy(daemon, 'silent', 's'))[0]?.status === 'failed');
  assert.equal((await jobsBy(daemon, 'silent', 's'))[0]?.outcome?.failure?.reason, 'exited 0 without writing a result file');
});

test('a dry run runs scripts and only logs agents', async () => {
  const p = await project();
  const daemon = p.daemon({ dryRun: true });
  await daemon.acquireLeader();
  await p.drop('item-3.work');
  await discover(p, 't1');
  await pollUntil(daemon, async () => (await jobsBy(daemon, 'work', 'item-3'))[0]?.status === 'noop');
  assert.equal((await p.launches()).length, 0);
  assert.ok(p.lines.some((line) => line.includes('dry run: would start agent') && line.includes('fake-agent.mjs')));
  assert.equal((await jobsBy(daemon, 'discover'))[0]?.status, 'done');
});

test('a timeout ends the command\'s whole process tree', async () => {
  const p = await project({ extraOperations: '      orphan: { kind: script, command: "(sleep 2; touch \\"$(dirname $OPERATOR_MANIFEST)/data/orphan\\") & sleep 30", timeout: 1s }' });
  const daemon = p.daemon();
  await daemon.acquireLeader();
  await enqueue(daemon.jobs, { project: 'demo', workflow: 'demo', operation: 'orphan', subject: 'o', input: {}, trigger: { id: 'x', name: 'test', kind: 'manual' } });
  await pollUntil(daemon, async () => (await jobsBy(daemon, 'orphan', 'o'))[0]?.status === 'failed');
  assert.match((await jobsBy(daemon, 'orphan', 'o'))[0]?.outcome?.failure?.reason ?? '', /timed out after 1s/);
  await sleep(2500);
  assert.equal(existsSync(join(p.data, 'orphan')), false);
});

test('two daemons racing for the lease after a crash get one leader', async () => {
  const p = await project();
  const [a, b] = [p.daemon(), p.daemon()];
  const results = await Promise.all([a.acquireLeader(), b.acquireLeader()]);
  assert.deepEqual(results.filter(Boolean).length, 1);
});

test('an exclusive operation never runs twice at once', async () => {
  const p = await project();
  const daemon = p.daemon();
  await daemon.acquireLeader();
  await p.drop('one.work', '1');
  await discover(p, 'timer-slot');
  await discover(p, 'manual-poke');
  await daemon.poll();
  const running = (await jobsBy(daemon, 'discover')).filter((job) => job.status === 'running');
  assert.equal(running.length, 1);
  await pollUntil(daemon, async () => (await jobsBy(daemon, 'discover')).every((job) => job.status === 'done' || job.status === 'noop'));
  // The item was taken once, so exactly one work job exists for it.
  assert.equal((await jobsBy(daemon, 'work', 'one')).length, 1);
});

test('a herdr tab that could not be closed is closed on a later poll', async () => {
  const p = await project();
  const closes: string[] = [];
  const herdr: Herdr = {
    ...absentHerdr,
    available: async () => true,
    findWorkspace: async () => 'wT',
    createTab: async () => ({ tabId: 'wT:t1', paneId: 'wT:p1', workspaceId: 'wT' }),
    runInPane: async (_pane, command) => { spawn('sh', ['-c', command], { detached: true, stdio: 'ignore' }).unref(); },
    closeTab: async (tabId) => {
      closes.push(tabId);
      if (closes.length <= 2) throw new Error('herdr did not answer');
      return 'closed';
    },
  };
  const daemon = p.daemon({ herdr });
  await daemon.acquireLeader();
  await p.drop('item-1.work', '1');
  await discover(p, 't1');
  await pollUntil(daemon, async () => (await jobsBy(daemon, 'work', 'item-1'))[0]?.status === 'done');
  assert.equal((await jobsBy(daemon, 'work', 'item-1'))[0]?.run?.placement.kind, 'herdr');
  assert.deepEqual(closes, ['wT:t1']);
  assert.equal((await p.backend.docs.list('tabs')).length, 1);
  await daemon.poll(new Date(Date.now() + 120_000));
  assert.deepEqual(closes, ['wT:t1', 'wT:t1']);
  assert.equal((await p.backend.docs.list('tabs')).length, 1);
  assert.ok(p.lines.some((line) => line.includes(' WARN ') && line.includes('a herdr tab is still not closed')));
  await daemon.poll(new Date(Date.now() + 240_000));
  assert.deepEqual(closes, ['wT:t1', 'wT:t1', 'wT:t1']);
  assert.equal((await p.backend.docs.list('tabs')).length, 0);
});

test('a run still finishes when neither herdr nor the state store can take its tab', async () => {
  const p = await project();
  const herdr: Herdr = {
    ...absentHerdr,
    available: async () => true,
    findWorkspace: async () => 'wT',
    createTab: async () => ({ tabId: 'wT:t1', paneId: 'wT:p1', workspaceId: 'wT' }),
    runInPane: async (_pane, command) => { spawn('sh', ['-c', command], { detached: true, stdio: 'ignore' }).unref(); },
    closeTab: async () => { throw new Error('herdr did not answer'); },
  };
  const docs = p.backend.docs;
  const backend = {
    ...p.backend,
    docs: {
      ...docs,
      replace: (collection: string, key: string, value: unknown, options?: { etag?: string; ttlMs?: number }) =>
        collection === 'tabs' ? Promise.reject(new Error('storage did not answer')) : docs.replace(collection, key, value, options),
    },
  };
  const daemon = p.daemon({ herdr, backend });
  await daemon.acquireLeader();
  await p.drop('item-1.work', '1');
  await discover(p, 't1');
  await pollUntil(daemon, async () => (await jobsBy(daemon, 'work', 'item-1'))[0]?.status === 'done', 10_000);
  assert.ok(p.lines.some((line) => line.includes('the open herdr tab could not be recorded')));
});

test('two results requesting the same operation, subject and key start one job', async () => {
  const p = await project({ extraOperations: [
    '      emit: { kind: script, command: node scripts/emit-keyed.mjs }',
    '      sink: { kind: script, command: node scripts/sink.mjs }',
  ].join('\n') });
  await writeFile(join(p.root, 'scripts', 'emit-keyed.mjs'), [
    "import { writeFileSync } from 'node:fs';",
    "if (process.argv.includes('--describe')) { console.log(JSON.stringify({ contract: 1 })); process.exit(0); }",
    "writeFileSync(process.env.OPERATOR_RESULT, JSON.stringify({ contract: 1, status: 'done', next: [{ operation: 'sink', subject: 'pr-7', key: 'head:abc' }] }));",
  ].join('\n'));
  await writeFile(join(p.root, 'scripts', 'sink.mjs'), [
    "import { writeFileSync } from 'node:fs';",
    "if (process.argv.includes('--describe')) { console.log(JSON.stringify({ contract: 1 })); process.exit(0); }",
    "writeFileSync(process.env.OPERATOR_RESULT, JSON.stringify({ contract: 1, status: 'done' }));",
  ].join('\n'));
  const daemon = p.daemon();
  await daemon.acquireLeader();
  for (const id of ['poll-1', 'poll-2']) {
    await enqueue(daemon.jobs, { project: 'demo', workflow: 'demo', operation: 'emit', subject: '', input: {}, trigger: { id, name: 'test', kind: 'manual' } });
  }
  await pollUntil(daemon, async () => (await jobsBy(daemon, 'emit')).every((job) => job.status === 'done') && (await jobsBy(daemon, 'sink', 'pr-7')).every((job) => job.status === 'done'));
  const sinks = await jobsBy(daemon, 'sink', 'pr-7');
  assert.equal(sinks.length, 1);
  assert.deepEqual((await jobsBy(daemon, 'emit')).map((job) => job.outcome?.next), [[sinks[0]?.id], [sinks[0]?.id]]);
});

/** A herdr that hosts tabs: its pane runs the wrapper as a detached shell, as `herdr pane run` would. */
function hostingHerdr(notes: string[] = []): Herdr {
  return {
    ...absentHerdr,
    available: async () => true,
    findWorkspace: async () => 'wT',
    createTab: async () => ({ tabId: 'wT:t1', paneId: 'wT:p1', workspaceId: 'wT' }),
    runInPane: async (_pane, command) => { spawn('sh', ['-c', command], { detached: true, stdio: 'ignore' }).unref(); },
    closeTab: async () => 'closed',
    // A shell with no agent in it, as herdr reports a pane whose session has ended.
    agentStatus: async () => 'unknown',
    notify: async (title, body) => { notes.push(`${title} | ${body}`); },
  };
}

test('an interactive operation runs attended in its tab and is closed after its result', async () => {
  const p = await project();
  const daemon = p.daemon({ herdr: hostingHerdr() });
  await daemon.acquireLeader();
  await p.drop('item-3.plan');
  await discover(p, 't1');
  await pollUntil(daemon, async () => (await jobsBy(daemon, 'plan', 'item-3'))[0]?.status === 'done');
  const [plan] = await jobsBy(daemon, 'plan', 'item-3');
  assert.equal(plan?.run?.placement.kind, 'herdr');
  assert.equal(plan?.run?.placement.degraded, undefined);
  assert.equal(plan?.outcome?.message, 'planned item-3');
  const exit = await readJsonFile<{ closedAfterResult?: boolean }>(runPath(plan?.run?.runDir ?? '', 'exit'));
  assert.equal(exit?.closedAfterResult, true);
});

test('an interactive operation without a terminal runs as an agent and says so', async () => {
  const p = await project();
  const daemon = p.daemon();
  await daemon.acquireLeader();
  await p.drop('item-3.plan');
  await discover(p, 't1');
  await pollUntil(daemon, async () => (await jobsBy(daemon, 'plan', 'item-3'))[0]?.status === 'done');
  const [plan] = await jobsBy(daemon, 'plan', 'item-3');
  assert.equal(plan?.run?.placement.kind, 'headless');
  assert.equal(plan?.run?.placement.degraded, 'herdr is not reachable; runs as an agent');
  const exit = await readJsonFile<{ closedAfterResult?: boolean; exitCode: number }>(runPath(plan?.run?.runDir ?? '', 'exit'));
  assert.equal(exit?.exitCode, 0);
  assert.equal(exit?.closedAfterResult, undefined);
});

test('the owner is notified of a question, and not of a status the operation does not name', async () => {
  const p = await project();
  const notes: string[] = [];
  const daemon = p.daemon({ herdr: { ...absentHerdr, notify: async (title, body) => { notes.push(`${title} | ${body}`); } } });
  await daemon.acquireLeader();
  await p.drop('item-2.ask');
  await p.drop('item-1.work', '1');
  await discover(p, 't1');
  await pollUntil(daemon, async () => (await jobsBy(daemon, 'ask', 'item-2'))[0]?.status === 'needs-input' && (await jobsBy(daemon, 'finish', 'item-1'))[0]?.status === 'done');
  assert.deepEqual(notes, ['operator: item-2 op:ask needs-input | asked q1']);
  assert.ok(p.lines.some((line) => line.includes('owner notified') && line.includes('status=needs-input')));
});

const SLOT_POOL = '  slots:\n    workspaces:\n      s1: { cwd: . }\n      s2: { cwd: . }';
const SLOT_OPERATIONS = [
  '      hold:     { kind: agent, engine: command, command: node scripts/fake-agent.mjs, pool: slots, timeout: 5m }',
  '      peek:     { kind: agent, engine: command, command: node scripts/session.mjs, pool: slots, access: read, limit: checks, timeout: 5m }',
].join('\n');

function inSlot(p: TestProject, operation: string, subject: string, member: string, input: Record<string, unknown> = {}) {
  return enqueue(p.daemon().jobs, { project: 'demo', workflow: 'demo', operation, subject, input, trigger: { id: `${operation}-${subject}`, name: 'test', kind: 'manual' }, member });
}

test('a job that names its workspace member runs there, and waits for it rather than taking another', async () => {
  const p = await project({ pools: SLOT_POOL, extraOperations: SLOT_OPERATIONS });
  const daemon = p.daemon();
  await daemon.acquireLeader();
  await inSlot(p, 'hold', 'pr-1', 's2', { seconds: 3 });
  await inSlot(p, 'hold', 'pr-2', 's2', { seconds: 1 });
  await pollUntil(daemon, async () => (await jobsBy(daemon, 'hold', 'pr-1'))[0]?.status === 'running');
  await daemon.poll();
  const [waiting] = await jobsBy(daemon, 'hold', 'pr-2');
  assert.equal(waiting?.status, 'queued');
  assert.equal(waiting?.waitingFor, 'workspace s2 of pool slots is busy');
  await pollUntil(daemon, async () => (await jobsBy(daemon, 'hold', 'pr-2'))[0]?.status === 'done');
  for (const subject of ['pr-1', 'pr-2']) assert.equal((await jobsBy(daemon, 'hold', subject))[0]?.run?.slot?.member, 's2');
});

test('a run lease the state backend fails to grant gives the workspace back for the next job', async () => {
  const p = await project({ pools: SLOT_POOL, extraOperations: SLOT_OPERATIONS });
  const broken = await inSlot(p, 'hold', 'pr-1', 's1', { seconds: 1 });
  const backend = { ...p.backend, locks: { ...p.backend.locks, async acquire(key: string, ttlMs: number, reference?: string) {
    if (key === `run.${broken.id}`) throw new Error('lock service answered 503');
    return p.backend.locks.acquire(key, ttlMs, reference);
  } } };
  const daemon = p.daemon({ backend });
  await daemon.acquireLeader();
  await inSlot(p, 'hold', 'pr-2', 's1', { seconds: 1 });
  // pr-1 can never start; the workspace it took on each attempt must not stay with it.
  await pollUntil(daemon, async () => (await jobsBy(daemon, 'hold', 'pr-2'))[0]?.status === 'done', 10_000);
  assert.equal((await jobsBy(daemon, 'hold', 'pr-2'))[0]?.run?.slot?.member, 's1');
  assert.equal((await jobsBy(daemon, 'hold', 'pr-1'))[0]?.status, 'queued');
  assert.ok(p.lines.some((line) => line.includes('starting a queued job failed')));
});

test('a run lease that throws after a limit slot was granted frees the slot and waits before trying again', async () => {
  const p = await project({ pools: SLOT_POOL, extraOperations: SLOT_OPERATIONS });
  const job = await inSlot(p, 'peek', 'pr-3', 's1');
  let attempts = 0;
  const backend = { ...p.backend, locks: { ...p.backend.locks, async acquire(key: string, ttlMs: number, reference?: string) {
    if (key === `run.${job.id}`) { attempts += 1; throw new Error('lock service answered 503'); }
    return p.backend.locks.acquire(key, ttlMs, reference);
  } } };
  const daemon = p.daemon({ backend });
  await daemon.acquireLeader();
  await daemon.poll();
  await daemon.poll();
  // One attempt, then a deferral; and the limit pool's single slot is free again.
  assert.equal(attempts, 1);
  const slot = await p.backend.slots.acquire('pool.checks', 1, 60_000);
  assert.equal(slot.granted, true);
});

test('a hold that cannot be given back after a failed run lease is logged, not swallowed', async () => {
  const p = await project({ pools: SLOT_POOL, extraOperations: SLOT_OPERATIONS });
  const job = await inSlot(p, 'peek', 'pr-4', 's1');
  const backend = {
    ...p.backend,
    locks: { ...p.backend.locks, async acquire(key: string, ttlMs: number, reference?: string) {
      if (key === `run.${job.id}`) throw new Error('lock service answered 503');
      return p.backend.locks.acquire(key, ttlMs, reference);
    } },
    slots: { ...p.backend.slots, async release() { throw new Error('guard answered 503'); } },
  };
  const daemon = p.daemon({ backend });
  await daemon.acquireLeader();
  await daemon.poll();
  assert.ok(p.lines.some((line) => line.includes('releasing part of a run failed; it expires by itself') && line.includes('guard answered 503')));
});

test('a read job shares the member a write job holds, and holds its limit pool', async () => {
  const p = await project({ pools: SLOT_POOL, extraOperations: SLOT_OPERATIONS });
  const daemon = p.daemon();
  await daemon.acquireLeader();
  await inSlot(p, 'hold', 'pr-1', 's1', { seconds: 4 });
  await pollUntil(daemon, async () => (await jobsBy(daemon, 'hold', 'pr-1'))[0]?.status === 'running');
  await inSlot(p, 'peek', 'pr-1', 's1');
  await pollUntil(daemon, async () => (await jobsBy(daemon, 'peek', 'pr-1'))[0]?.status === 'done');
  assert.equal((await jobsBy(daemon, 'hold', 'pr-1'))[0]?.status, 'running');
  const [peek] = await jobsBy(daemon, 'peek', 'pr-1');
  assert.equal(peek?.run?.slot?.member, 's1');
  assert.equal(peek?.run?.slot?.read, true);
  assert.equal(peek?.run?.limitSlot?.pool, 'checks');
  await pollUntil(daemon, async () => (await jobsBy(daemon, 'hold', 'pr-1'))[0]?.status === 'done');
});

test('a follow-on in the same workspace pool stays in the member its request came from, and the run is told which', async () => {
  const p = await project({ pools: SLOT_POOL, extraOperations: SLOT_OPERATIONS.replace("command: node scripts/fake-agent.mjs, pool: slots", "command: node scripts/relay.mjs, pool: slots") });
  await writeFile(join(p.root, 'scripts', 'relay.mjs'), [
    "import { readInput, writeResult } from './lib.mjs';",
    'const input = readInput();',
    "if (input.input.step === 2) writeResult({ status: 'done', message: `step 2 in ${input.member}` });",
    "else writeResult({ status: 'done', message: `step 1 in ${input.member}`, next: [{ operation: 'hold', input: { step: 2 } }] });",
  ].join('\n'));
  const daemon = p.daemon();
  await daemon.acquireLeader();
  await inSlot(p, 'hold', 'pr-1', 's2');
  await pollUntil(daemon, async () => (await jobsBy(daemon, 'hold', 'pr-1')).filter((job) => job.status === 'done').length === 2);
  const messages = (await jobsBy(daemon, 'hold', 'pr-1')).map((job) => job.outcome?.message).sort();
  assert.deepEqual(messages, ['step 1 in s2', 'step 2 in s2']);
});

test('a noop run keeps no tab open, whatever its keepTab', async () => {
  const p = await project({ extraOperations: '      look:     { kind: interactive, engine: command, command: node scripts/session.mjs, placement: herdr, keepTab: 4s, timeout: 5m }' });
  const closes: string[] = [];
  const daemon = p.daemon({ herdr: { ...hostingHerdr(), closeTab: async (tabId) => { closes.push(tabId); return 'closed'; } } });
  await daemon.acquireLeader();
  await enqueue(daemon.jobs, { project: 'demo', workflow: 'demo', operation: 'look', subject: 'pr-3', input: { status: 'noop' }, trigger: { id: 'look-noop', name: 'test', kind: 'manual' } });
  await pollUntil(daemon, async () => (await jobsBy(daemon, 'look', 'pr-3'))[0]?.status === 'noop');
  assert.deepEqual(closes, ['wT:t1']);
  assert.ok(!p.lines.some((line) => line.includes('stays open for a person')));
});

test('a kept tab outlives its finished run, which hands its result over at once, and closes when keepTab runs out', async () => {
  const p = await project({ extraOperations: '      look:     { kind: interactive, engine: command, command: node scripts/session.mjs, placement: herdr, keepTab: 4s, timeout: 5m }' });
  const closes: string[] = [];
  const daemon = p.daemon({ herdr: { ...hostingHerdr(), closeTab: async (tabId) => { closes.push(tabId); return 'closed'; } } });
  await daemon.acquireLeader();
  await enqueue(daemon.jobs, { project: 'demo', workflow: 'demo', operation: 'look', subject: 'pr-3', input: {}, trigger: { id: 'look-1', name: 'test', kind: 'manual' } });
  await pollUntil(daemon, async () => (await jobsBy(daemon, 'look', 'pr-3'))[0]?.status === 'done');
  assert.deepEqual(closes, []);
  assert.ok(p.lines.some((line) => line.includes('stays open for a person')));
  await daemon.poll(new Date(Date.now() + 120_000));
  await daemon.poll(new Date(Date.now() + 240_000));
  assert.deepEqual(closes, ['wT:t1']);
  assert.ok(p.lines.some((line) => line.includes('kept open for a person')));
});

test('a pause lets the running job finish, starts nothing new, and says once when it is quiet', async () => {
  const p = await project();
  const notes: string[] = [];
  const daemon = p.daemon({ herdr: { ...absentHerdr, notify: async (title) => { notes.push(title); } } });
  await daemon.acquireLeader();
  await p.drop('item-1.work', '1');
  await discover(p, 't1');
  await daemon.poll();
  assert.equal((await jobsBy(daemon, 'discover'))[0]?.status, 'running');
  await requestPause(daemon.backend.docs, 'tester', 'host restart');
  await pollUntil(daemon, async () => (await jobsBy(daemon, 'discover'))[0]?.status === 'done');
  await daemon.poll();
  await daemon.poll();
  // The follow-on waits; nothing starts while the pause stands, and the quiet moment is said once.
  assert.equal((await jobsBy(daemon, 'work', 'item-1'))[0]?.status, 'queued');
  assert.equal(p.lines.filter((line) => line.includes('fully paused')).length, 1);
  assert.deepEqual(notes, ['operator: fully paused']);
  assert.ok((await readPause(daemon.backend.docs))?.quietAt);
  // No timer fires while paused either.
  await daemon.tick(new Date(Date.now() + 120_000));
  assert.equal((await jobsBy(daemon, 'discover')).length, 1);
  await clearPause(daemon.backend.docs);
  await pollUntil(daemon, async () => (await jobsBy(daemon, 'finish', 'item-1'))[0]?.status === 'done');
  assert.ok(p.lines.some((line) => line.includes(' resumed ')));
});

test('a pause ends when the service starts again', async () => {
  const p = await project();
  const daemon = p.daemon();
  await daemon.acquireLeader();
  await requestPause(daemon.backend.docs, 'tester');
  await daemon.resumeAfterRestart();
  assert.equal(await readPause(daemon.backend.docs), undefined);
  assert.ok(p.lines.some((line) => line.includes('a pause ends when the service starts')));
  await discover(p, 't1');
  await pollUntil(daemon, async () => (await jobsBy(daemon, 'discover'))[0]?.status === 'noop');
});

async function idleSessionProject(): Promise<TestProject> {
  const p = await project({ extraOperations: '      idle:     { kind: interactive, engine: command, command: node scripts/idle.mjs, placement: herdr, timeout: 5m }' });
  await writeFile(join(p.root, 'scripts', 'idle.mjs'), [
    "import { existsSync } from 'node:fs';",
    "import { join } from 'node:path';",
    "import { dataDir, describeIfAsked, writeResult } from './lib.mjs';",
    'describeIfAsked();',
    "const release = join(dataDir(), 'release');",
    "const timer = setInterval(() => { if (existsSync(release)) { writeResult({ status: 'done', message: 'released' }); clearInterval(timer); } }, 100);",
  ].join('\n'));
  p.manifest.runtime.idleNudgeMs = 300;
  return p;
}

test('an idle interactive session without a result is nudged twice, then the owner is told once', async () => {
  const p = await idleSessionProject();
  const notes: string[] = [];
  const typed: string[] = [];
  const base = hostingHerdr(notes);
  const daemon = p.daemon({ herdr: {
    ...base,
    agentStatus: async () => 'done',
    runInPane: async (pane, command) => { if (command.startsWith('operator:')) typed.push(command); else await base.runInPane(pane, command); },
  } });
  await daemon.acquireLeader();
  await enqueue(daemon.jobs, { project: 'demo', workflow: 'demo', operation: 'idle', subject: 'pr-9', input: {}, trigger: { id: 'idle-1', name: 'test', kind: 'manual' } });
  await pollUntil(daemon, async () => notes.some((note) => note.includes('is idle')), 30_000);
  assert.equal(typed.length, 2);
  assert.match(typed[0] ?? '', /idle for \d+ min without a result.*write your result now.*waiting on a subagent/);
  assert.equal(notes.filter((note) => note.includes('is idle')).length, 1);
  assert.ok(p.lines.some((line) => line.includes('nudged an idle session that has no result yet')));
  assert.ok(p.lines.some((line) => line.includes('an idle session still has no result after being nudged')));
  for (let i = 0; i < 5; i += 1) { await daemon.poll(); await sleep(500); }
  assert.equal(typed.length, 2);
  assert.equal(notes.filter((note) => note.includes('is idle')).length, 1);
  await writeFile(join(p.data, 'release'), '1');
  await pollUntil(daemon, async () => (await jobsBy(daemon, 'idle', 'pr-9'))[0]?.status === 'done', 30_000);
});

test('a working session is never nudged, and idleNudge off turns nudging off', async () => {
  for (const [status, nudgeMs] of [['working', 300], ['done', 0]] as const) {
    const p = await idleSessionProject();
    p.manifest.runtime.idleNudgeMs = nudgeMs;
    const typed: string[] = [];
    const base = hostingHerdr();
    const daemon = p.daemon({ herdr: {
      ...base,
      agentStatus: async () => status,
      runInPane: async (pane, command) => { if (command.startsWith('operator:')) typed.push(command); else await base.runInPane(pane, command); },
    } });
    await daemon.acquireLeader();
    await enqueue(daemon.jobs, { project: 'demo', workflow: 'demo', operation: 'idle', subject: 'pr-9', input: {}, trigger: { id: `idle-${status}`, name: 'test', kind: 'manual' } });
    const deadline = Date.now() + 7_000;
    while (Date.now() < deadline) { await daemon.poll(); await sleep(200); }
    assert.deepEqual(typed, [], `${status} / ${nudgeMs}`);
    await writeFile(join(p.data, 'release'), '1');
    await pollUntil(daemon, async () => (await jobsBy(daemon, 'idle', 'pr-9'))[0]?.status === 'done', 30_000);
  }
});

const PER_SUBJECT = [
  '      look:     { kind: interactive, engine: command, command: node scripts/session.mjs, placement: herdr, tabs: per-subject, timeout: 5m }',
  '      glance:   { kind: interactive, engine: command, command: node scripts/session.mjs, placement: herdr, tabs: per-subject, timeout: 5m }',
  '      close:    { kind: script, command: node scripts/end-subjects.mjs }',
  '      toil:     { kind: agent, engine: command, command: node scripts/fake-agent.mjs, placement: herdr, tabs: per-subject, timeout: 5m }',
].join('\n');

/** A herdr whose tabs are counted: each createTab is a new tab, and a closed tab's pane is gone. */
function tabHerdr() {
  const created: string[] = [];
  const closed: string[] = [];
  const herdr: Herdr = {
    ...hostingHerdr(),
    createTab: async () => {
      const n = created.length + 1;
      created.push(`wT:t${n}`);
      return { tabId: `wT:t${n}`, paneId: `wT:p${n}`, workspaceId: 'wT' };
    },
    closeTab: async (tabId) => { closed.push(tabId); return 'closed'; },
    // A closed tab's pane is gone; herdr refuses it by name.
    agentStatus: async (paneId) => {
      if (closed.includes(paneId.replace(':p', ':t'))) throw new HerdrRefusal('pane_not_found', `pane ${paneId} not found`);
      return 'idle';
    },
  };
  return { herdr, created, closed };
}

async function perSubjectProject(): Promise<TestProject> {
  const p = await project({ extraOperations: PER_SUBJECT });
  await writeFile(join(p.root, 'scripts', 'end-subjects.mjs'), [
    "import { describeIfAsked, readInput, writeResult } from './lib.mjs';",
    'describeIfAsked();',
    "writeResult({ status: 'done', endSubjects: readInput().input.subjects });",
  ].join('\n'));
  return p;
}

/** Ends every per-subject tab the test left, as a finished pipeline would, so no session outlives it. */
async function endAll(daemon: ReturnType<TestProject['daemon']>, id = 'end-all') {
  const subjects = [...new Set((await daemon.backend.docs.list<{ subject: string }>('subject-tabs')).map((item) => item.value.subject))];
  if (subjects.length > 0) await runOnce(daemon, 'close', '', id, { subjects });
}

async function runOnce(daemon: ReturnType<TestProject['daemon']>, operation: string, subject: string, id: string, input: Record<string, unknown> = {}) {
  await enqueue(daemon.jobs, { project: 'demo', workflow: 'demo', operation, subject, input, trigger: { id, name: 'test', kind: 'manual' } });
  await pollUntil(daemon, async () => (await daemon.jobs.list()).some((job) => job.trigger.id === id && job.status !== 'queued' && job.status !== 'running'));
  return (await daemon.jobs.list()).find((job) => job.trigger.id === id);
}

test('a per-subject operation runs every step for its subject in one tab, ending the previous session first', async () => {
  const p = await perSubjectProject();
  const { herdr, created, closed } = tabHerdr();
  const daemon = p.daemon({ herdr });
  await daemon.acquireLeader();
  const first = await runOnce(daemon, 'look', 'pr-3', 'look-1');
  assert.equal(first?.status, 'done');
  assert.equal(first?.run?.placement.retained, true);
  const firstWrapper = await readJsonFile<WrapperInfo>(runPath(first?.run?.runDir ?? '', 'wrapper'));
  assert.equal(processAlive(firstWrapper?.pid ?? 0), true, 'the retained session stays open after its result');
  const second = await runOnce(daemon, 'look', 'pr-3', 'look-2');
  assert.equal(second?.status, 'done');
  assert.deepEqual(created, ['wT:t1']);
  assert.equal(second?.run?.placement.tabId, 'wT:t1');
  assert.deepEqual(closed, []);
  assert.equal(processAlive(firstWrapper?.pid ?? 0), false, 'the previous session ended before the next step took the tab');
  const [record] = await p.backend.docs.list<{ jobId: string; tabId: string }>('subject-tabs');
  assert.equal(record?.value.jobId, second?.id);
  assert.ok(p.lines.some((line) => line.includes('reusing the per-subject tab')));
  await endAll(daemon);
});

test('another operation for the same subject gets a tab of its own', async () => {
  const p = await perSubjectProject();
  const { herdr, created } = tabHerdr();
  const daemon = p.daemon({ herdr });
  await daemon.acquireLeader();
  await runOnce(daemon, 'look', 'pr-3', 'look-1');
  const glance = await runOnce(daemon, 'glance', 'pr-3', 'glance-1');
  await runOnce(daemon, 'look', 'pr-4', 'look-4');
  assert.deepEqual(created, ['wT:t1', 'wT:t2', 'wT:t3']);
  assert.equal(glance?.run?.placement.tabId, 'wT:t2');
  assert.equal((await p.backend.docs.list('subject-tabs')).length, 3);
  await endAll(daemon);
});

test('a result naming ended subjects closes their tabs and ends their sessions', async () => {
  const p = await perSubjectProject();
  const { herdr, closed } = tabHerdr();
  const daemon = p.daemon({ herdr });
  await daemon.acquireLeader();
  const look = await runOnce(daemon, 'look', 'pr-3', 'look-1');
  await runOnce(daemon, 'glance', 'pr-3', 'glance-1');
  await runOnce(daemon, 'look', 'pr-4', 'look-4');
  const wrapper = await readJsonFile<WrapperInfo>(runPath(look?.run?.runDir ?? '', 'wrapper'));
  const close = await runOnce(daemon, 'close', '', 'close-1', { subjects: ['pr-3'] });
  assert.equal(close?.status, 'done');
  assert.deepEqual(closed.sort(), ['wT:t1', 'wT:t2']);
  assert.equal(processAlive(wrapper?.pid ?? 0), false);
  const left = await p.backend.docs.list<{ subject: string }>('subject-tabs');
  assert.deepEqual(left.map((item) => item.value.subject), ['pr-4']);
  // A subject named again once its tabs are gone changes nothing.
  await runOnce(daemon, 'close', '', 'close-2', { subjects: ['pr-3'] });
  assert.equal(closed.length, 2);
  await endAll(daemon);
});

test('a restarted daemon reuses the per-subject tab it recorded', async () => {
  const p = await perSubjectProject();
  const { herdr, created } = tabHerdr();
  const first = p.daemon({ herdr });
  await first.acquireLeader();
  await runOnce(first, 'look', 'pr-3', 'look-1');
  await p.backend.locks.release('leader');
  const second = p.daemon({ herdr });
  assert.equal(await second.acquireLeader(), true);
  const again = await runOnce(second, 'look', 'pr-3', 'look-2');
  assert.equal(again?.run?.placement.tabId, 'wT:t1');
  assert.deepEqual(created, ['wT:t1']);
  await endAll(second);
});

test('a per-subject tab closed by hand is replaced by a new tab', async () => {
  const p = await perSubjectProject();
  const { herdr, created, closed } = tabHerdr();
  const daemon = p.daemon({ herdr });
  await daemon.acquireLeader();
  const first = await runOnce(daemon, 'look', 'pr-3', 'look-1');
  // Closing a tab by hand ends what runs in it.
  const wrapper = await readJsonFile<WrapperInfo>(runPath(first?.run?.runDir ?? '', 'wrapper'));
  process.kill(wrapper?.pid ?? 0, 'SIGTERM');
  closed.push('wT:t1');
  const again = await runOnce(daemon, 'look', 'pr-3', 'look-2');
  assert.deepEqual(created, ['wT:t1', 'wT:t2']);
  assert.equal(again?.run?.placement.tabId, 'wT:t2');
  assert.ok(p.lines.some((line) => line.includes('the per-subject tab is gone')));
  await endAll(daemon);
});

test('a retained tab whose run has finished is never nudged', async () => {
  const p = await perSubjectProject();
  p.manifest.runtime.idleNudgeMs = 200;
  const typed: string[] = [];
  const { herdr } = tabHerdr();
  const daemon = p.daemon({ herdr: {
    ...herdr,
    agentStatus: async () => 'done',
    runInPane: async (pane, command) => { if (command.startsWith('operator:')) typed.push(command); else await herdr.runInPane(pane, command); },
  } });
  await daemon.acquireLeader();
  const look = await runOnce(daemon, 'look', 'pr-3', 'look-1');
  assert.equal(look?.run?.placement.retained, true);
  for (let i = 0; i < 10; i += 1) { await daemon.poll(); await sleep(150); }
  assert.deepEqual(typed, []);
  await endAll(daemon);
});

test('a claude step in a per-subject tab starts a session under a known id, and the next step resumes it', async () => {
  const p = await project({ extraOperations: CODE_OPERATION });
  const claude = await fakeClaude(p);
  try {
    const { herdr } = tabHerdr();
    const daemon = p.daemon({ herdr });
    await daemon.acquireLeader();
    assert.equal((await runOnce(daemon, 'code', 'pr-5', 'code-1'))?.status, 'done');
    assert.equal((await runOnce(daemon, 'code', 'pr-5', 'code-2'))?.status, 'done');
    const [first, second] = await claude.calls();
    const id = first?.[first.indexOf('--session-id') + 1];
    assert.match(id ?? '', /^[0-9a-f-]{36}$/);
    assert.deepEqual(second?.slice(second.indexOf('--resume'), second.indexOf('--resume') + 2), ['--resume', id]);
    const [record] = await p.backend.docs.list<{ sessionId?: string }>('subject-tabs');
    assert.equal(record?.value.sessionId, id);
  } finally {
    claude.restore();
  }
});

test('a kept tab is not closed when its keepTab runs out while someone works in it, and is closed once its pane is idle', async () => {
  const p = await project({ extraOperations: '      look:     { kind: interactive, engine: command, command: node scripts/session.mjs, placement: herdr, keepTab: 4s, timeout: 5m }' });
  const closes: string[] = [];
  let status = 'idle';
  const daemon = p.daemon({ herdr: { ...hostingHerdr(), agentStatus: async () => status, closeTab: async (tabId) => { closes.push(tabId); return 'closed'; } } });
  await daemon.acquireLeader();
  const look = await runOnce(daemon, 'look', 'pr-3', 'look-1');
  const command = await readJsonFile<CommandInfo>(runPath(look?.run?.runDir ?? '', 'command'));
  // The owner talks to the kept session after its result; it starts working again.
  status = 'working';
  await daemon.poll(new Date(Date.now() + 120_000));
  await daemon.poll(new Date(Date.now() + 240_000));
  assert.deepEqual(closes, []);
  assert.equal(processAlive(command?.pid ?? 0), true, 'the session working past its keepTab is left alone');
  assert.equal(p.lines.filter((line) => line.includes('a herdr tab is in use')).length, 1);
  status = 'idle';
  await daemon.poll(new Date(Date.now() + 360_000));
  assert.deepEqual(closes, ['wT:t1']);
  assert.equal(processAlive(command?.pid ?? 0), false, 'closing the tab ended its session');
});

test('the next step for a subject waits while its tab is in use, then continues in the same tab', async () => {
  const p = await perSubjectProject();
  const { herdr, created } = tabHerdr();
  let status = 'idle';
  const daemon = p.daemon({ herdr: { ...herdr, agentStatus: async () => status } });
  await daemon.acquireLeader();
  const look = await runOnce(daemon, 'look', 'pr-3', 'look-1');
  const wrapper = await readJsonFile<WrapperInfo>(runPath(look?.run?.runDir ?? '', 'wrapper'));
  status = 'working';
  await enqueue(daemon.jobs, { project: 'demo', workflow: 'demo', operation: 'look', subject: 'pr-3', input: {}, trigger: { id: 'look-2', name: 'test', kind: 'manual' } });
  await daemon.poll();
  const [, waiting] = await jobsBy(daemon, 'look', 'pr-3');
  assert.equal(waiting?.status, 'queued');
  assert.equal(waiting?.waitingFor, 'per-subject tab wT:t1 is in use');
  assert.equal(processAlive(wrapper?.pid ?? 0), true);
  status = 'idle';
  await pollUntil(daemon, async () => (await jobsBy(daemon, 'look', 'pr-3')).every((job) => job.status === 'done'));
  assert.deepEqual(created, ['wT:t1']);
  assert.equal(processAlive(wrapper?.pid ?? 0), false);
  await endAll(daemon);
});

test('an ended subject whose tab is in use leaves the registry at once and closes once its pane is idle', async () => {
  const p = await perSubjectProject();
  const { herdr, closed } = tabHerdr();
  let status = 'idle';
  const daemon = p.daemon({ herdr: { ...herdr, agentStatus: async () => status } });
  await daemon.acquireLeader();
  const look = await runOnce(daemon, 'look', 'pr-3', 'look-1');
  const wrapper = await readJsonFile<WrapperInfo>(runPath(look?.run?.runDir ?? '', 'wrapper'));
  status = 'working';
  await runOnce(daemon, 'close', '', 'close-1', { subjects: ['pr-3'] });
  assert.deepEqual(closed, []);
  assert.equal((await p.backend.docs.list('subject-tabs')).length, 0);
  assert.equal((await p.backend.docs.list('tabs')).length, 1);
  await daemon.poll(new Date(Date.now() + 120_000));
  assert.deepEqual(closed, [], 'nothing names the subject again, and the pane still works');
  assert.equal(processAlive(wrapper?.pid ?? 0), true);
  status = 'idle';
  await daemon.poll(new Date(Date.now() + 240_000));
  assert.deepEqual(closed, ['wT:t1']);
  assert.equal(processAlive(wrapper?.pid ?? 0), false);
  assert.equal((await p.backend.docs.list('tabs')).length, 0);
});

test('a step whose previous run of the same key still works waits for it instead of forking the conversation', async () => {
  const p = await perSubjectProject();
  const { herdr, created } = tabHerdr();
  const daemon = p.daemon({ herdr });
  await daemon.acquireLeader();
  await enqueue(daemon.jobs, { project: 'demo', workflow: 'demo', operation: 'toil', subject: 'pr-6', input: { seconds: 3 }, trigger: { id: 'toil-1', name: 'test', kind: 'manual' } });
  await pollUntil(daemon, async () => (await jobsBy(daemon, 'toil', 'pr-6'))[0]?.status === 'running');
  const [first] = await jobsBy(daemon, 'toil', 'pr-6');
  await enqueue(daemon.jobs, { project: 'demo', workflow: 'demo', operation: 'toil', subject: 'pr-6', input: { seconds: 1 }, trigger: { id: 'toil-2', name: 'test', kind: 'manual' } });
  await daemon.poll();
  const second = (await jobsBy(daemon, 'toil', 'pr-6')).find((job) => job.trigger.id === 'toil-2');
  assert.equal(second?.status, 'queued');
  assert.equal(second?.waitingFor, `per-subject tab wT:t1 is busy with ${first?.id}`);
  await pollUntil(daemon, async () => (await jobsBy(daemon, 'toil', 'pr-6')).every((job) => job.status === 'done'));
  assert.deepEqual(created, ['wT:t1']);
  await endAll(daemon);
});

test('an ended subject whose tab a run still works in closes once that run is over', async () => {
  const p = await perSubjectProject();
  const { herdr, closed } = tabHerdr();
  const daemon = p.daemon({ herdr });
  await daemon.acquireLeader();
  await enqueue(daemon.jobs, { project: 'demo', workflow: 'demo', operation: 'toil', subject: 'pr-6', input: { seconds: 3 }, trigger: { id: 'toil-1', name: 'test', kind: 'manual' } });
  await pollUntil(daemon, async () => (await jobsBy(daemon, 'toil', 'pr-6'))[0]?.status === 'running');
  await enqueue(daemon.jobs, { project: 'demo', workflow: 'demo', operation: 'close', subject: '', input: { subjects: ['pr-6'] }, trigger: { id: 'close-1', name: 'test', kind: 'manual' } });
  await pollUntil(daemon, async () => (await daemon.jobs.list()).find((job) => job.trigger.id === 'close-1')?.status === 'done');
  assert.deepEqual(closed, []);
  assert.equal((await p.backend.docs.list('subject-tabs')).length, 0);
  await pollUntil(daemon, async () => (await jobsBy(daemon, 'toil', 'pr-6'))[0]?.status === 'done');
  await daemon.poll(new Date(Date.now() + 120_000));
  assert.deepEqual(closed, ['wT:t1']);
});

test('a herdr that does not answer is no permission to end a session: the close waits until it does', async () => {
  const p = await perSubjectProject();
  const { herdr, closed } = tabHerdr();
  let answering = true;
  const daemon = p.daemon({ herdr: { ...herdr, agentStatus: async (paneId) => { if (!answering) throw new Error('herdr did not answer'); return herdr.agentStatus(paneId); } } });
  await daemon.acquireLeader();
  const look = await runOnce(daemon, 'look', 'pr-3', 'look-1');
  const wrapper = await readJsonFile<WrapperInfo>(runPath(look?.run?.runDir ?? '', 'wrapper'));
  answering = false;
  await runOnce(daemon, 'close', '', 'close-1', { subjects: ['pr-3'] });
  await daemon.poll(new Date(Date.now() + 120_000));
  assert.deepEqual(closed, []);
  assert.equal(processAlive(wrapper?.pid ?? 0), true);
  answering = true;
  await daemon.poll(new Date(Date.now() + 240_000));
  assert.deepEqual(closed, ['wT:t1']);
  assert.equal(processAlive(wrapper?.pid ?? 0), false);
});

test('a tab in use past idleNudge warns and notifies the owner once per episode, and its record stays alive', async () => {
  const p = await project({ extraOperations: '      look:     { kind: interactive, engine: command, command: node scripts/session.mjs, placement: herdr, keepTab: 4s, timeout: 5m }' });
  p.manifest.runtime.idleNudgeMs = 300;
  const notes: string[] = [];
  let status = 'working';
  const closes: string[] = [];
  const daemon = p.daemon({ herdr: { ...hostingHerdr(notes), agentStatus: async () => status, closeTab: async (tabId) => { closes.push(tabId); return 'closed'; } } });
  await daemon.acquireLeader();
  const look = await runOnce(daemon, 'look', 'pr-3', 'look-1');
  const command = await readJsonFile<CommandInfo>(runPath(look?.run?.runDir ?? '', 'command'));
  const later = Date.now() + 2 * 3_600_000;
  await daemon.poll(new Date(later));
  await sleep(400);
  await daemon.poll(new Date(later + 120_000));
  await daemon.poll(new Date(later + 240_000));
  const inUse = (note: string) => note.includes('is still in use');
  assert.equal(notes.filter(inUse).length, 1);
  assert.equal(p.lines.filter((line) => line.includes(' WARN ') && line.includes('in use a long time')).length, 1);
  const [record] = await p.backend.docs.list<{ refreshedAt: string }>('tabs');
  assert.ok(Date.parse(record?.value.refreshedAt ?? '') >= later, 'a deferred close renews its record');
  // The episode ends when the pane is free; a new one is a new episode.
  status = 'idle';
  await daemon.poll(new Date(later + 360_000));
  assert.deepEqual(closes, ['wT:t1']);
  assert.equal(processAlive(command?.pid ?? 0), false);
  assert.equal(p.lines.filter((line) => line.includes('a herdr tab is in use;')).length, 1);
});

test('a per-subject tab is recorded before its run can fail to start, so a failed start leaks nothing', async () => {
  const p = await perSubjectProject();
  const { herdr, created } = tabHerdr();
  let refuse = true;
  const daemon = p.daemon({ herdr: { ...herdr, runInPane: async (pane, command) => { if (refuse) { refuse = false; throw new Error('herdr refused the command'); } await herdr.runInPane(pane, command); } } });
  await daemon.acquireLeader();
  const look = await runOnce(daemon, 'look', 'pr-3', 'look-1');
  assert.equal(look?.status, 'done');
  assert.equal(look?.attempt, 2);
  assert.deepEqual(created, ['wT:t1'], 'the interrupted attempt\'s tab is the one the retry runs in');
  await endAll(daemon);
});

test('a session on another host, or a pane not back at its shell, keeps the next step waiting', async () => {
  const p = await perSubjectProject();
  const { herdr } = tabHerdr();
  let statuses: string[] = [];
  const daemon = p.daemon({ herdr: { ...herdr, agentStatus: async (paneId) => statuses.shift() ?? herdr.agentStatus(paneId) } });
  await daemon.acquireLeader();
  const look = await runOnce(daemon, 'look', 'pr-3', 'look-1');
  const wrapperPath = runPath(look?.run?.runDir ?? '', 'wrapper');
  const wrapper = await readJsonFile<WrapperInfo>(wrapperPath);
  await writeFile(wrapperPath, JSON.stringify({ ...wrapper, host: 'another-host' }));
  await enqueue(daemon.jobs, { project: 'demo', workflow: 'demo', operation: 'look', subject: 'pr-3', input: {}, trigger: { id: 'look-2', name: 'test', kind: 'manual' } });
  await daemon.poll();
  const waiting = (await jobsBy(daemon, 'look', 'pr-3')).find((job) => job.trigger.id === 'look-2');
  assert.equal(waiting?.waitingFor, 'per-subject tab wT:t1 still runs a session this host cannot end');
  assert.equal(processAlive(wrapper?.pid ?? 0), true);
  await writeFile(wrapperPath, JSON.stringify(wrapper));
  // Free when asked, then still working once its session was ended: not back at its shell.
  statuses = ['idle', ...Array.from({ length: 200 }, () => 'working')];
  await daemon.poll(new Date(Date.now() + 1000));
  assert.equal((await jobsBy(daemon, 'look', 'pr-3')).find((job) => job.trigger.id === 'look-2')?.waitingFor, 'per-subject tab wT:t1 is not back at its shell');
  statuses = [];
  await pollUntil(daemon, async () => (await jobsBy(daemon, 'look', 'pr-3')).every((job) => job.status === 'done'));
  await endAll(daemon);
});

test('a per-subject tab record is renewed while its tab stays open', async () => {
  const p = await perSubjectProject();
  const { herdr } = tabHerdr();
  const daemon = p.daemon({ herdr });
  await daemon.acquireLeader();
  await runOnce(daemon, 'look', 'pr-3', 'look-1');
  const later = Date.now() + 2 * 86_400_000;
  await daemon.poll(new Date(later));
  const [record] = await p.backend.docs.list<{ refreshedAt: string }>('subject-tabs');
  assert.equal(Date.parse(record?.value.refreshedAt ?? ''), later);
  await endAll(daemon);
});

test('a tab an older daemon recorded without its pane closes as before, whatever herdr says of panes', async () => {
  const p = await project();
  const closes: string[] = [];
  const daemon = p.daemon({ herdr: { ...hostingHerdr(), agentStatus: async () => { throw new Error('herdr did not answer'); }, closeTab: async (tabId) => { closes.push(tabId); return 'closed'; } } });
  await daemon.acquireLeader();
  await p.backend.docs.replace('tabs', 'wT:t9', { tabId: 'wT:t9', jobId: 'j-old', since: new Date().toISOString(), closeAt: new Date(Date.now() - 1000).toISOString() });
  await daemon.poll();
  assert.deepEqual(closes, ['wT:t9']);
});

/**
 * A stand-in claude: keeps a transcript per session where claude does, under CLAUDE_CONFIG_DIR,
 * refuses to resume a session without one, and records its arguments. `data/claude-exit` makes it
 * end without a result, with that exit code, once it has started (or resumed) its session.
 */
async function fakeClaude(p: TestProject): Promise<{ restore: () => void; calls: () => Promise<string[][]>; transcript: (id: string) => string }> {
  const bin = join(p.root, 'bin');
  const config = join(p.root, 'claude-config');
  await mkdir(bin, { recursive: true });
  await writeFile(join(bin, 'claude'), [
    '#!/usr/bin/env node',
    "const { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } = require('node:fs');",
    "const { join } = require('node:path');",
    `const data = ${JSON.stringify(p.data)};`,
    'const args = process.argv.slice(2);',
    "appendFileSync(join(data, 'claude.log'), JSON.stringify(args) + '\\n');",
    "const { realpathSync } = require('node:fs');",
    "const store = existsSync(join(data, 'claude-store')) ? readFileSync(join(data, 'claude-store'), 'utf8') : process.env.CLAUDE_CONFIG_DIR;",
    "const dir = join(store, 'projects', realpathSync(process.cwd()).replace(/[^a-zA-Z0-9]/g, '-'));",
    "const resume = args.indexOf('--resume');",
    "if (resume >= 0 && !existsSync(join(dir, args[resume + 1] + '.jsonl'))) { console.error('No conversation found with session ID: ' + args[resume + 1]); process.exit(1); }",
    "const fresh = args.indexOf('--session-id');",
    "if (fresh >= 0 && existsSync(join(dir, args[fresh + 1] + '.jsonl'))) { console.error('Error: Session ID ' + args[fresh + 1] + ' is already in use.'); process.exit(1); }",
    "if (fresh >= 0) { mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, args[fresh + 1] + '.jsonl'), ''); }",
    "const fail = join(data, 'claude-exit');",
    "if (existsSync(fail)) { const code = Number(readFileSync(fail, 'utf8')); rmSync(fail); process.exit(code); }",
    "writeFileSync(process.env.OPERATOR_RESULT, JSON.stringify({ contract: 1, status: 'done' }));",
  ].join('\n'), { mode: 0o755 });
  const saved = { PATH: process.env.PATH, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR };
  process.env.PATH = `${bin}:${saved.PATH ?? ''}`;
  process.env.CLAUDE_CONFIG_DIR = config;
  return {
    restore: () => {
      process.env.PATH = saved.PATH;
      if (saved.CLAUDE_CONFIG_DIR === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = saved.CLAUDE_CONFIG_DIR;
    },
    calls: async () => (await readFile(join(p.data, 'claude.log'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as string[]),
    transcript: (id: string) => join(config, 'projects', p.root.replace(/[^a-zA-Z0-9]/g, '-'), `${id}.jsonl`),
  };
}

const CODE_OPERATION = '      code:     { kind: agent, engine: claude, prompt: "work on {subject}", placement: herdr, tabs: per-subject, timeout: 5m }';

const sessionArg = (args: string[] | undefined, flag: string): string | undefined => (args && args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);

test('a session whose transcript is gone starts new under the same id rather than failing to resume', async () => {
  const p = await project({ extraOperations: CODE_OPERATION });
  const claude = await fakeClaude(p);
  try {
    const { herdr } = tabHerdr();
    const daemon = p.daemon({ herdr });
    await daemon.acquireLeader();
    assert.equal((await runOnce(daemon, 'code', 'pr-5', 'code-1'))?.status, 'done');
    const id = sessionArg((await claude.calls())[0], '--session-id') ?? '';
    await rm(claude.transcript(id));
    assert.equal((await runOnce(daemon, 'code', 'pr-5', 'code-2'))?.status, 'done');
    const calls = await claude.calls();
    assert.equal(calls.length, 2, 'one run, no failed resume first');
    assert.equal(sessionArg(calls[1], '--session-id'), id);
    assert.equal(calls[1]?.includes('--resume'), false);
  } finally {
    claude.restore();
  }
});

test('a session with a transcript is resumed even after a run that ended without a result', async () => {
  const p = await project({ extraOperations: CODE_OPERATION });
  const claude = await fakeClaude(p);
  try {
    const { herdr } = tabHerdr();
    const daemon = p.daemon({ herdr });
    await daemon.acquireLeader();
    // A long conversation that then failed: its session exists.
    await writeFile(join(p.data, 'claude-exit'), '1');
    assert.equal((await runOnce(daemon, 'code', 'pr-5', 'code-1'))?.status, 'failed');
    const id = sessionArg((await claude.calls())[0], '--session-id');
    assert.equal((await runOnce(daemon, 'code', 'pr-5', 'code-2'))?.status, 'done');
    assert.equal(sessionArg((await claude.calls())[1], '--resume'), id);
  } finally {
    claude.restore();
  }
});

test('a resumed session that fails for another reason is not started again as a new one', async () => {
  const p = await project({ extraOperations: CODE_OPERATION });
  const claude = await fakeClaude(p);
  try {
    const { herdr } = tabHerdr();
    const daemon = p.daemon({ herdr });
    await daemon.acquireLeader();
    assert.equal((await runOnce(daemon, 'code', 'pr-5', 'code-1'))?.status, 'done');
    // A rate limit, an outage: the session is there, the run fails.
    await writeFile(join(p.data, 'claude-exit'), '1');
    assert.equal((await runOnce(daemon, 'code', 'pr-5', 'code-2'))?.status, 'failed');
    const calls = await claude.calls();
    assert.equal(calls.length, 2);
    assert.ok(calls[1]?.includes('--resume'));
  } finally {
    claude.restore();
  }
});

test('an ended subject\'s tab that cannot enter the close retries stays registered, and the other subjects still end', async () => {
  const p = await perSubjectProject();
  const { herdr, closed } = tabHerdr();
  const docs = p.backend.docs;
  const backend = { ...p.backend, docs: { ...docs, replace: (collection: string, key: string, value: unknown, options?: { etag?: string; ttlMs?: number }) =>
    collection === 'tabs' && key === 'wT:t1' ? Promise.reject(new Error('storage did not answer')) : docs.replace(collection, key, value, options) } };
  const daemon = p.daemon({ herdr: { ...herdr, closeTab: async (tabId) => { if (tabId === 'wT:t1') throw new Error('herdr did not answer'); return herdr.closeTab(tabId); } }, backend });
  await daemon.acquireLeader();
  await runOnce(daemon, 'look', 'pr-3', 'look-1');
  await runOnce(daemon, 'look', 'pr-4', 'look-4');
  assert.equal((await runOnce(daemon, 'close', '', 'close-1', { subjects: ['pr-3', 'pr-4'] }))?.status, 'done');
  const left = await docs.list<{ subject: string; tabId: string }>('subject-tabs');
  assert.deepEqual(left.map((item) => item.value.tabId), ['wT:t1'], 'the tab nothing could record stays where a later end finds it');
  assert.deepEqual(closed, ['wT:t2']);
  assert.ok(p.lines.some((line) => line.includes('could not end a subject')));
  const wrapper = await readJsonFile<WrapperInfo>(runPath((await jobsBy(daemon, 'look', 'pr-3'))[0]?.run?.runDir ?? '', 'wrapper'));
  process.kill(wrapper?.pid ?? 0, 'SIGTERM');
});

test('renewing a per-subject tab record never brings back one that was ended meanwhile', async () => {
  const p = await perSubjectProject();
  const { herdr } = tabHerdr();
  const docs = p.backend.docs;
  let stale: { key: string; value: unknown }[] | undefined;
  const backend = { ...p.backend, docs: { ...docs, list: async <T>(collection: string, filter?: { prefix?: string; where?: Record<string, string> }) =>
    (collection === 'subject-tabs' && stale ? stale : await docs.list(collection, filter)) as { key: string; value: T }[] } };
  const daemon = p.daemon({ herdr, backend });
  await daemon.acquireLeader();
  await runOnce(daemon, 'look', 'pr-3', 'look-1');
  // The renewal reads a list taken before the subject ended.
  stale = await docs.list('subject-tabs');
  await runOnce(daemon, 'close', '', 'close-1', { subjects: ['pr-3'] });
  await daemon.poll(new Date(Date.now() + 2 * 86_400_000));
  stale = undefined;
  assert.equal((await docs.list('subject-tabs')).length, 0);
});

test('a long-use notification herdr could not deliver is sent again on a later poll, once', async () => {
  const p = await project({ extraOperations: '      look:     { kind: interactive, engine: command, command: node scripts/session.mjs, placement: herdr, keepTab: 4s, timeout: 5m }' });
  p.manifest.runtime.idleNudgeMs = 300;
  const delivered: string[] = [];
  let attempts = 0;
  let status = 'working';
  const daemon = p.daemon({ herdr: { ...hostingHerdr(), agentStatus: async () => status, notify: async (title) => {
    if (!title.includes('still in use')) return;
    attempts += 1;
    if (attempts === 1) throw new Error('herdr did not answer');
    delivered.push(title);
  } } });
  await daemon.acquireLeader();
  await runOnce(daemon, 'look', 'pr-3', 'look-1');
  const later = Date.now() + 3_600_000;
  await daemon.poll(new Date(later));
  await sleep(400);
  for (let i = 1; i <= 4; i += 1) await daemon.poll(new Date(later + i * 120_000));
  assert.equal(attempts, 2);
  assert.equal(delivered.length, 1);
  assert.equal(p.lines.filter((line) => line.includes('in use a long time')).length, 1);
  status = 'idle';
  await daemon.poll(new Date(later + 600_000));
});

test('a pane herdr reports unknown once may be an agent it has not detected yet; unknown twice is a shell', async () => {
  const p = await project({ extraOperations: '      look:     { kind: interactive, engine: command, command: node scripts/session.mjs, placement: herdr, keepTab: 4s, timeout: 5m }' });
  const closes: string[] = [];
  const daemon = p.daemon({ herdr: { ...hostingHerdr(), closeTab: async (tabId) => { closes.push(tabId); return 'closed'; } } });
  await daemon.acquireLeader();
  await runOnce(daemon, 'look', 'pr-3', 'look-1');
  await daemon.poll(new Date(Date.now() + 120_000));
  assert.deepEqual(closes, []);
  await daemon.poll(new Date(Date.now() + 240_000));
  assert.deepEqual(closes, ['wT:t1']);
});

test('renewing a tab record loses to a write that landed between its read and its write', async () => {
  const p = await perSubjectProject();
  const { herdr } = tabHerdr();
  const docs = p.backend.docs;
  let interleave = false;
  const backend = { ...p.backend, docs: { ...docs, get: async <T>(collection: string, key: string) => {
    const read = await docs.get<T>(collection, key);
    if (interleave && collection === 'subject-tabs' && read) {
      interleave = false;
      // Another step - a run starting in the tab - writes the record right after the renewal read it.
      await docs.replace(collection, key, { ...(read.value as object), jobId: 'j-concurrent' });
    }
    return read;
  } } };
  const daemon = p.daemon({ herdr, backend });
  await daemon.acquireLeader();
  await runOnce(daemon, 'look', 'pr-3', 'look-1');
  interleave = true;
  await daemon.poll(new Date(Date.now() + 2 * 86_400_000));
  const [record] = await docs.list<{ jobId: string }>('subject-tabs');
  assert.equal(record?.value.jobId, 'j-concurrent');
  const wrapper = await readJsonFile<WrapperInfo>(runPath((await jobsBy(daemon, 'look', 'pr-3'))[0]?.run?.runDir ?? '', 'wrapper'));
  process.kill(wrapper?.pid ?? 0, 'SIGTERM');
});

/** Runs `code` for pr-5 twice in member l1 and answers what claude was asked each time. */
async function codeTwice(p: TestProject, herdr: Herdr, claude: Awaited<ReturnType<typeof fakeClaude>>): Promise<{ statuses: (string | undefined)[]; calls: string[][] }> {
  const daemon = p.daemon({ herdr });
  await daemon.acquireLeader();
  const statuses: (string | undefined)[] = [];
  for (const id of ['code-1', 'code-2']) {
    await enqueue(daemon.jobs, { project: 'demo', workflow: 'demo', operation: 'codel', subject: 'pr-5', input: {}, trigger: { id, name: 'test', kind: 'manual' }, member: 'l1' });
    await pollUntil(daemon, async () => ['done', 'failed'].includes((await daemon.jobs.list()).find((job) => job.trigger.id === id)?.status ?? ''));
    statuses.push((await daemon.jobs.list()).find((job) => job.trigger.id === id)?.status);
  }
  return { statuses, calls: await claude.calls() };
}

async function linkedProject(target?: string): Promise<TestProject> {
  const link = join(tmpdir(), `operator-link-${process.pid}-${Math.random().toString(36).slice(2)}`);
  const p = await project({
    pools: `  links:\n    workspaces:\n      l1: { cwd: ${link} }`,
    extraOperations: '      codel:    { kind: agent, engine: claude, prompt: "work on {subject}", pool: links, placement: herdr, tabs: per-subject, timeout: 5m }',
  });
  await symlink(target ?? p.root, link);
  links.push(link);
  return p;
}
const links: string[] = [];
after(async () => { for (const link of links) await rm(link, { force: true }); });

test('a session in a symlinked cwd is found where claude keeps it, under the real path, and resumed', async () => {
  const p = await linkedProject();
  const claude = await fakeClaude(p);
  try {
    const { statuses, calls } = await codeTwice(p, tabHerdr().herdr, claude);
    assert.deepEqual(statuses, ['done', 'done']);
    assert.equal(sessionArg(calls[1], '--resume'), sessionArg(calls[0], '--session-id'));
  } finally {
    claude.restore();
  }
});

test('the session is looked up with the environment of the pane it runs in, not the daemon\'s', async () => {
  const p = await linkedProject();
  const claude = await fakeClaude(p);
  const paneConfig = join(p.root, 'pane-claude-config');
  try {
    const { herdr } = tabHerdr();
    // The herdr server started the pane with a CLAUDE_CONFIG_DIR the daemon does not have.
    const paneHerdr: Herdr = { ...herdr, runInPane: (pane, command) => herdr.runInPane(pane, `CLAUDE_CONFIG_DIR=${paneConfig} ${command}`) };
    const { statuses, calls } = await codeTwice(p, paneHerdr, claude);
    assert.deepEqual(statuses, ['done', 'done']);
    assert.equal(sessionArg(calls[1], '--resume'), sessionArg(calls[0], '--session-id'));
  } finally {
    claude.restore();
  }
});

test('a session claude says is already in use is resumed instead, once', async () => {
  const p = await linkedProject();
  const claude = await fakeClaude(p);
  try {
    // claude keeps its transcripts where the wrapper does not look, so the wrapper misreads the session as new.
    await writeFile(join(p.data, 'claude-store'), join(p.root, 'elsewhere'));
    const { statuses, calls } = await codeTwice(p, tabHerdr().herdr, claude);
    assert.deepEqual(statuses, ['done', 'done']);
    const id = sessionArg(calls[0], '--session-id');
    assert.equal(calls.length, 3);
    assert.equal(sessionArg(calls[1], '--session-id'), id);
    assert.equal(sessionArg(calls[2], '--resume'), id);
  } finally {
    claude.restore();
  }
});

test('two unknown answers in one poll are one, and a pane id herdr hands out again starts unconfirmed', async () => {
  const p = await project();
  const closes: string[] = [];
  const daemon = p.daemon({ herdr: { ...hostingHerdr(), closeTab: async (tabId) => { closes.push(tabId); return 'closed'; } } });
  await daemon.acquireLeader();
  const record = (tabId: string) => ({ tabId, jobId: 'j-x', since: new Date().toISOString(), closeAt: new Date(Date.now() - 1000).toISOString(), paneId: 'wT:p7', guard: true });
  await p.backend.docs.replace('tabs', 'wT:t7', record('wT:t7'));
  await p.backend.docs.replace('tabs', 'wT:t8', record('wT:t8'));
  await daemon.poll(new Date(Date.now() + 120_000));
  assert.deepEqual(closes, [], 'both tabs asked about the same pane in one poll: still one answer');
  await daemon.poll(new Date(Date.now() + 240_000));
  // Closing the first tab forgets its pane, so the second starts its own confirmation.
  assert.deepEqual(closes, ['wT:t7']);
  await daemon.poll(new Date(Date.now() + 360_000));
  assert.deepEqual(closes, ['wT:t7', 'wT:t8']);
  await p.backend.docs.replace('tabs', 'wT:t9', record('wT:t9'));
  await daemon.poll(new Date(Date.now() + 480_000));
  assert.deepEqual(closes, ['wT:t7', 'wT:t8'], 'the pane id is new again: its first unknown is not a shell yet');
});

test('a renewal that is not due reads nothing more than the list', async () => {
  const p = await perSubjectProject();
  const { herdr } = tabHerdr();
  const docs = p.backend.docs;
  let reads = 0;
  const backend = { ...p.backend, docs: { ...docs, get: async <T>(collection: string, key: string) => { if (collection === 'subject-tabs') reads += 1; return docs.get<T>(collection, key); } } };
  const daemon = p.daemon({ herdr, backend });
  await daemon.acquireLeader();
  await runOnce(daemon, 'look', 'pr-3', 'look-1');
  // The renewal pass is due; the record itself was just renewed.
  const later = Date.now() + 2 * 3_600_000;
  const [kept] = await docs.list<Record<string, unknown>>('subject-tabs');
  await docs.replace('subject-tabs', kept?.key ?? '', { ...kept?.value, refreshedAt: new Date(later).toISOString() });
  reads = 0;
  await daemon.poll(new Date(later));
  assert.equal(reads, 0);
  await endAll(daemon);
});

test('an ended subject\'s tab whose pane reads unknown closes within two polls, not a minute later', async () => {
  const p = await perSubjectProject();
  const { herdr, closed } = tabHerdr();
  const daemon = p.daemon({ herdr: { ...herdr, agentStatus: async () => 'unknown' } });
  await daemon.acquireLeader();
  await runOnce(daemon, 'look', 'pr-3', 'look-1');
  await runOnce(daemon, 'close', '', 'close-1', { subjects: ['pr-3'] });
  assert.deepEqual(closed, [], 'one unknown is not yet a shell');
  await sleep(150);
  await daemon.poll();
  assert.deepEqual(closed, ['wT:t1']);
  assert.ok(p.lines.some((line) => line.includes('closed the tab of an ended subject')));
});

test('an unknown answer nobody asked again for a few polls does not confirm a later one', async () => {
  const p = await project();
  const closes: string[] = [];
  const daemon = p.daemon({ herdr: { ...hostingHerdr(), closeTab: async (tabId) => { closes.push(tabId); return 'closed'; } } });
  await daemon.acquireLeader();
  const t0 = Date.now();
  const record = (closeAt: number) => ({ tabId: 'wT:t7', jobId: 'j-x', since: new Date(t0).toISOString(), closeAt: new Date(closeAt).toISOString(), paneId: 'wT:p7', guard: true });
  await p.backend.docs.replace('tabs', 'wT:t7', record(t0 - 1000));
  await daemon.poll(new Date(t0));
  // The tab is kept on purpose for a while: nobody asks about its pane.
  await p.backend.docs.replace('tabs', 'wT:t7', record(t0 + 86_400_000));
  for (let i = 1; i <= 5; i += 1) await daemon.poll(new Date(t0 + i * 120_000));
  await p.backend.docs.replace('tabs', 'wT:t7', record(t0 - 1000));
  await daemon.poll(new Date(t0 + 6 * 120_000));
  assert.deepEqual(closes, [], 'the old unknown is stale: this one starts a new confirmation');
  await daemon.poll(new Date(t0 + 6 * 120_000 + 200));
  assert.deepEqual(closes, ['wT:t7']);
});

test('a close-retry pass that fails runs again a minute later, not on every poll', async () => {
  const p = await project();
  const docs = p.backend.docs;
  let reads = 0;
  const backend = { ...p.backend, docs: { ...docs, list: async <T>(collection: string, filter?: { prefix?: string; where?: Record<string, string> }) => {
    if (collection === 'tabs') { reads += 1; throw new Error('storage did not answer'); }
    return docs.list<T>(collection, filter);
  } } };
  const daemon = p.daemon({ backend });
  await daemon.acquireLeader();
  const t0 = Date.now();
  await assert.rejects(daemon.poll(new Date(t0)), /storage did not answer/);
  await daemon.poll(new Date(t0 + 200));
  await daemon.poll(new Date(t0 + 30_000));
  assert.equal(reads, 1);
  await assert.rejects(daemon.poll(new Date(t0 + 61_000)), /storage did not answer/);
  assert.equal(reads, 2);
});
