import { after, test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { enqueue } from './jobs.ts';
import { setTimeout as sleep } from 'node:timers/promises';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import type { Herdr } from './herdr.ts';
import { processAlive, readJsonFile, runPath, type CommandInfo, type WrapperInfo } from './runfiles.ts';
import { absentHerdr, createTestProject, jobsBy, pollUntil, type TestProject } from './test-support/project.ts';
import { fireTrigger } from './triggers.ts';

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
  assert.deepEqual(closes, ['wT:t1']);
  assert.ok(p.lines.some((line) => line.includes('kept open for a person')));
});
