import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { spawn } from 'node:child_process';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { enqueue } from './jobs.ts';
import type { Herdr } from './herdr.ts';
import { DEFAULT_QUOTA_WAIT_MS, PROVIDER_COOLDOWNS, quotaFromEvent, rememberQuota, type QuotaWait } from './provider-quota.ts';
import { processAlive, readJsonFile, runPath, type CommandInfo } from './runfiles.ts';
import { createTestProject, pollUntil, type TestProject } from './test-support/project.ts';
import { PROVIDER_AFFINITIES, SUBJECT_TABS_COLLECTION, type Daemon } from './daemon.ts';

const FAKE = `#!/usr/bin/env node
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
const provider = basename(process.argv[1]);
const args = process.argv.slice(2);
const input = JSON.parse(readFileSync(process.env.OPERATOR_INPUT, 'utf8'));
const data = process.env.FAKE_DATA;
const config = JSON.parse(readFileSync(join(data, 'providers.json'), 'utf8'));
const setting = config[provider];
const sessionId = args.includes('--resume') ? args[args.indexOf('--resume') + 1] : args.includes('--session-id') ? args[args.indexOf('--session-id') + 1] : undefined;
appendFileSync(join(data, 'provider-calls.jsonl'), JSON.stringify({ provider, args, sessionId, subject: input.subject, pid: process.pid, cwd: process.cwd() }) + '\\n');
let transcript;
if (provider === 'claude' && sessionId) {
  const dir = join(process.env.CLAUDE_CONFIG_DIR, 'projects', process.cwd().replace(/[^a-zA-Z0-9]/g, '-'));
  mkdirSync(dir, { recursive: true });
  transcript = join(dir, sessionId + '.jsonl');
  if (!existsSync(transcript)) writeFileSync(transcript, '');
}
const result = setting.mode === 'retryable' ? { contract: 1, status: 'failed', failure: { reason: 'transient operation error', retryable: true }, evidence: [], next: [] } : { contract: 1, status: 'done', evidence: [], next: [], ...(setting.endSubjects ? { endSubjects: setting.endSubjects } : {}) };
const output = (text) => new Promise((resolve, reject) => process.stdout.write(text, (error) => error ? reject(error) : resolve()));
if (provider === 'codex') await output(JSON.stringify({ type: 'thread.started', thread_id: 'thread-' + input.subject }) + '\\n');
if (setting.noise) await output(JSON.stringify({ type: 'item.completed', item: { text: 'x'.repeat(setting.noise) } }) + '\\n');
const done = () => {
  if (setting.after === 'auth') { process.stderr.write('Authentication failed\\n'); process.exit(1); }
  if (provider === 'codex') writeFileSync(args[args.indexOf('-o') + 1], JSON.stringify(setting.output ?? result));
  else if (args.includes('--json-schema')) {
    // Claude's final stream-json event; a run without structured output answers in prose only.
    const final = { type: 'result', subtype: 'success', is_error: false, result: 'Reviewed.', ...(setting.prose ? {} : { structured_output: setting.output ?? { verdict: 'pass', subject: input.subject } }) };
    return new Promise(() => process.stdout.write(JSON.stringify(final) + '\\n', () => process.exit(0)));
  }
  else writeFileSync(process.env.OPERATOR_RESULT, JSON.stringify(result));
  process.exit(0);
};
if (setting.mode === 'done' || setting.mode === 'retryable') await done();
if (setting.mode === 'hold') await new Promise(() => { const timer = setInterval(() => { if (existsSync(join(data, 'continue-' + input.subject))) { clearInterval(timer); done(); } }, 25); });
if (setting.mode === 'auth') { process.stderr.write('Authentication failed\\n'); process.exit(1); }
const event = provider === 'claude'
  ? { type: 'rate_limit_event', rate_limit_info: { status: 'rejected', ...(setting.reset ? { resetsAt: setting.reset / 1000 } : {}) } }
  : { type: 'error', code: 'usage_limit_reached', message: setting.message ?? "You've hit your usage limit", ...(setting.reset ? { resets_at: setting.reset / 1000 } : {}) };
if (setting.mode === 'live' || setting.mode === 'split') {
  const encoded = JSON.stringify(event) + '\\n';
  if (setting.mode === 'split') {
    appendFileSync(transcript, encoded.slice(0, 20));
    setTimeout(() => appendFileSync(transcript, encoded.slice(20)), 200);
  } else appendFileSync(transcript, encoded);
  const timer = setInterval(() => { if (existsSync(join(data, 'continue-' + input.subject))) { clearInterval(timer); done(); } }, 25);
} else {
  await output(JSON.stringify(event) + '\\n');
  process.exit(1);
}
`;

type Mode = { mode: string; reset?: number; after?: string; noise?: number; message?: string; endSubjects?: string[]; output?: unknown; prose?: boolean };
const REVIEW_SCHEMA = { type: 'object', properties: { verdict: { type: 'string' }, subject: { type: 'string' } }, required: ['verdict'], additionalProperties: false };
async function fixture(options: { live?: boolean; limit?: boolean; timeout?: string; review?: 'headless' | 'herdr' } = {}) {
  const taskOp = options.live
    ? `      task: { kind: interactive, engine: claude, fallback: codex, prompt: 'Do the task from {input}; write {result}', placement: herdr, tabs: per-subject, timeout: ${options.timeout ?? '1s'}, ${options.limit ? 'limit: checks,' : ''} args: ['--permission-mode', auto] }`
    : `      task: { kind: agent, engine: claude, fallback: codex, prompt: 'Do the task from {input}; write {result}', timeout: 5s, args: ['--permission-mode', auto] }`;
  // A read-only Codex review with a schema, whose verdict a follow-on operation reads from {output}.
  const review = options.review
    ? `\n      review: { kind: agent, engine: codex, fallback: claude, agent: code-reviewer, schema: review.schema.json, thread: per-subject, ${options.review === 'herdr' ? 'placement: herdr, tabs: per-subject,' : ''} timeout: 5s, args: ['-c', 'approval_policy=on-request'], prompt: 'Review {subject} from {input} into {output}. Answer only with the JSON your output schema requires.', then: verdict }\n      verdict: { kind: script, command: 'true' }`
    : '';
  const extra = taskOp + review;
  const p = await createTestProject({ extraOperations: extra });
  if (options.review) {
    await writeFile(join(p.root, 'review.schema.json'), JSON.stringify(REVIEW_SCHEMA, null, 2));
    await mkdir(join(p.root, '.codex', 'agents'), { recursive: true });
    await writeFile(join(p.root, '.codex', 'agents', 'code-reviewer.toml'), 'model = "gpt-test"\n');
    p.manifest.workflows.get('demo')!.operations.get('review')!.env = { FAKE_DATA: p.data, CLAUDE_CONFIG_DIR: join(p.root, '.claude') };
  }
  const bin = join(p.root, 'bin');
  await mkdir(bin);
  for (const provider of ['claude', 'codex']) { const path = join(bin, provider); await writeFile(path, FAKE); await chmod(path, 0o755); }
  const oldPath = process.env['PATH'];
  process.env['PATH'] = `${bin}:${oldPath ?? ''}`;
  const op = p.manifest.workflows.get('demo')!.operations.get('task')!;
  op.env = { FAKE_DATA: p.data, CLAUDE_CONFIG_DIR: join(p.root, '.claude') };
  let sends = 0;
  let rejectSends = 0;
  let status: 'idle' | 'working' | 'blocked' | 'unknown' = 'idle';
  const children: number[] = [];
  const herdr: Herdr = {
    available: async () => true,
    findWorkspace: async () => 'workspace',
    createTab: async () => ({ workspaceId: 'workspace', tabId: 'tab', paneId: 'pane' }),
    runInPane: async (_pane, command) => {
      if (command.startsWith('operator:')) {
        sends += 1;
        if (rejectSends > 0) { rejectSends -= 1; throw new Error('pane delivery refused'); }
        const active = (await p.daemon().jobs.list('running')).find((job) => job.operation === 'task');
        await writeFile(join(p.data, 'continue-' + active!.subject), 'continue');
        status = 'working';
      } else {
        const child = spawn('/bin/sh', ['-c', command], { detached: true, stdio: 'ignore' });
        if (child.pid) children.push(child.pid);
        child.unref();
      }
    },
    setTitle: async () => undefined,
    closeTab: async () => 'gone',
    agentStatus: async () => status,
    atShell: async () => undefined,
    notify: async () => undefined,
  };
  return {
    p, herdr,
    sends: () => sends,
    setStatus: (value: typeof status) => { status = value; },
    failSend: () => { rejectSends = 1; },
    modes: async (claude: Mode, codex: Mode = { mode: 'done' }) => writeFile(join(p.data, 'providers.json'), JSON.stringify({ claude, codex })),
    calls: async (): Promise<{ provider: string; args: string[]; sessionId?: string; subject: string; pid: number; cwd: string }[]> => {
      try { return (await readFile(join(p.data, 'provider-calls.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)); } catch { return []; }
    },
    cleanup: async () => {
      for (const pid of children) { try { process.kill(-pid, 'SIGTERM'); } catch { /* already exited */ } }
      if (oldPath === undefined) delete process.env['PATH']; else process.env['PATH'] = oldPath;
      await p.cleanup();
    },
  };
}
async function task(daemon: Daemon, subject: string, key = subject) {
  return (await enqueue(daemon.jobs, { project: 'demo', workflow: 'demo', operation: 'task', subject, input: {}, trigger: { id: key, name: 'test', kind: 'manual' } })).id;
}
async function cache(p: TestProject, provider: 'claude' | 'codex', reset: number) {
  const event = provider === 'claude' ? { type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: reset / 1000 } } : { type: 'error', code: 'usage_limit_reached', resets_at: reset / 1000 };
  return rememberQuota(p.backend.docs, quotaFromEvent(event, provider)!);
}

test('first quota-limited task stays Claude; only a new task falls back and same session resumes without spending retries', async () => {
  const f = await fixture();
  try {
    const reset = Date.now() + 60_000;
    await f.modes({ mode: 'quota', reset });
    const daemon = f.p.daemon(); await daemon.acquireLeader();
    const first = await task(daemon, 'first');
    await pollUntil(daemon, async () => (await daemon.jobs.get(first))?.status === 'queued' && Boolean((await daemon.jobs.get(first))?.quotaWait));
    const waiting = (await daemon.jobs.get(first))!;
    assert.equal(waiting.provider, 'claude');
    assert.equal(waiting.retryCount, 0);
    assert.equal(waiting.notBefore, new Date(reset).toISOString());
    const second = await task(daemon, 'second');
    await pollUntil(daemon, async () => (await daemon.jobs.get(second))?.status === 'done');
    const fallback = (await f.calls()).find((call) => call.subject === 'second')!;
    assert.equal(fallback.provider, 'codex');
    assert.equal(fallback.args.includes('--permission-mode'), false);
    assert.ok(fallback.args.includes('workspace-write'));
    assert.ok(fallback.args.includes('approval_policy="on-request"'));
    assert.ok(fallback.args.some((arg) => arg.startsWith('sandbox_workspace_write.writable_roots=')));
    await f.modes({ mode: 'done' });
    await daemon.poll(new Date(reset + 1));
    await pollUntil(daemon, async () => { await daemon.poll(new Date(Date.now() + 60_000)); return (await daemon.jobs.get(first))?.status === 'done'; });
    const original = (await f.calls()).filter((call) => call.subject === 'first');
    assert.equal(original.length, 2);
    assert.equal(original[1]!.provider, 'claude');
    assert.equal(original[1]!.sessionId, original[0]!.sessionId);
    assert.ok(original[1]!.args.includes('--resume'));
    assert.equal((await daemon.jobs.get(first))?.retryCount, 0);
    assert.equal((await daemon.jobs.get(first))?.attempt, 2);
  } finally { await f.cleanup(); }
});

test('both unavailable leaves new tasks queued across restart; four hours is the missing-reset default', async () => {
  const f = await fixture();
  try {
    await f.modes({ mode: 'done' });
    const detected = Date.now();
    const quota = await rememberQuota(f.p.backend.docs, quotaFromEvent({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected' } }, 'claude', detected)!);
    assert.equal(Date.parse(quota.until) - detected, DEFAULT_QUOTA_WAIT_MS);
    const reset = detected + 90_000;
    await cache(f.p, 'codex', reset);
    let daemon = f.p.daemon(); await daemon.acquireLeader();
    const id = await task(daemon, 'waiting');
    await daemon.poll();
    assert.equal((await daemon.jobs.get(id))?.status, 'queued');
    assert.equal((await daemon.jobs.get(id))?.notBefore, new Date(reset).toISOString());
    assert.equal((await daemon.jobs.get(id))?.attempt, 1);
    assert.deepEqual(await f.calls(), []);
    await f.p.backend.locks.release('leader');
    daemon = f.p.daemon(); await daemon.acquireLeader();
    await daemon.poll(new Date(reset + 1));
    await pollUntil(daemon, async () => (await daemon.jobs.get(id))?.status === 'done');
    assert.equal((await f.calls())[0]?.provider, 'codex');
  } finally { await f.cleanup(); }
});

test('live Claude quota wait keeps the same process past active timeout and resumes once after daemon restart', async () => {
  const f = await fixture({ live: true });
  try {
    const reset = Date.now() + 60_000;
    await f.modes({ mode: 'split', reset });
    let daemon = f.p.daemon({ herdr: f.herdr }); await daemon.acquireLeader();
    const id = await task(daemon, 'live');
    await pollUntil(daemon, async () => Boolean((await daemon.jobs.get(id))?.quotaWait));
    const run = (await daemon.jobs.get(id))!.run!;
    const command = await readJsonFile<CommandInfo>(runPath(run.runDir, 'command'));
    assert.ok(command && processAlive(command.pid));
    await sleep(1_500);
    await daemon.poll();
    assert.equal((await daemon.jobs.get(id))?.status, 'running');
    assert.ok(processAlive(command!.pid));
    assert.equal(f.sends(), 0);
    await f.p.backend.locks.release('leader');
    daemon = f.p.daemon({ herdr: f.herdr }); await daemon.acquireLeader();
    await daemon.poll(new Date(reset + 1));
    await pollUntil(daemon, async () => (await daemon.jobs.get(id))?.status === 'done');
    await daemon.poll(new Date(reset + 2));
    assert.equal(f.sends(), 1);
    assert.equal((await f.calls()).length, 1);
    assert.equal((await daemon.jobs.get(id))?.attempt, 1);
  } finally { await f.cleanup(); }
});

test('a retained Claude conversation cannot fallback just because a new job record exists', async () => {
  const f = await fixture({ live: true, timeout: '5s' });
  try {
    await f.modes({ mode: 'done' });
    const daemon = f.p.daemon({ herdr: f.herdr }); await daemon.acquireLeader();
    const first = await task(daemon, 'conversation');
    await pollUntil(daemon, async () => (await daemon.jobs.get(first))?.status === 'done');
    await cache(f.p, 'claude', Date.now() + 60_000);
    const next = await task(daemon, 'conversation', 'round-two');
    await daemon.poll();
    assert.equal((await daemon.jobs.get(next))?.status, 'queued');
    assert.equal((await daemon.jobs.get(next))?.provider, 'claude');
    assert.equal((await f.calls()).length, 1);
  } finally { await f.cleanup(); }
});

test('live wait never answers an unrelated blocked prompt; failed continuation delivery retries with backoff', async () => {
  const f = await fixture({ live: true });
  try {
    const reset = Date.now() + 60_000;
    await f.modes({ mode: 'live', reset });
    const daemon = f.p.daemon({ herdr: f.herdr }); await daemon.acquireLeader();
    const id = await task(daemon, 'blocked');
    await pollUntil(daemon, async () => Boolean((await daemon.jobs.get(id))?.quotaWait));
    f.setStatus('blocked');
    await daemon.poll(new Date(reset + 1));
    assert.equal(f.sends(), 0);
    assert.match((await daemon.jobs.get(id))?.waitingFor ?? '', /pane blocked needs attention/);
    f.setStatus('idle'); f.failSend();
    await daemon.poll(new Date(reset + 2));
    assert.equal(f.sends(), 1);
    await daemon.poll(new Date(reset + 10));
    assert.equal(f.sends(), 1);
    await daemon.poll(new Date(reset + 60_003));
    await pollUntil(daemon, async () => (await daemon.jobs.get(id))?.status === 'done');
    assert.equal(f.sends(), 2);
  } finally { await f.cleanup(); }
});

test('nonrenewable limit capacity keeps its wall-time cap and quota timeout queues the same provider', async () => {
  const f = await fixture({ live: true, limit: true });
  try {
    await f.modes({ mode: 'live', reset: Date.now() + 60_000 });
    const daemon = f.p.daemon({ herdr: f.herdr }); await daemon.acquireLeader();
    const id = await task(daemon, 'guarded');
    await pollUntil(daemon, async () => (await daemon.jobs.get(id))?.status === 'queued' && Boolean((await daemon.jobs.get(id))?.quotaWait));
    assert.equal((await daemon.jobs.get(id))?.provider, 'claude');
    assert.equal((await daemon.jobs.get(id))?.retryCount, 0);
    assert.equal(f.sends(), 0);
  } finally { await f.cleanup(); }
});

test('ordinary authentication errors never start a provider cooldown or Codex fallback', async () => {
  const f = await fixture();
  try {
    await f.modes({ mode: 'auth' });
    const daemon = f.p.daemon(); await daemon.acquireLeader();
    const id = await task(daemon, 'auth');
    await pollUntil(daemon, async () => (await daemon.jobs.get(id))?.status === 'failed');
    assert.equal((await daemon.jobs.get(id))?.attempt, 1);
    assert.deepEqual(await f.p.backend.docs.list<QuotaWait>(PROVIDER_COOLDOWNS), []);
    assert.deepEqual((await f.calls()).map((call) => call.provider), ['claude']);
  } finally { await f.cleanup(); }
});


test('an ordinary failure after a resumed quota wait is not another quota retry', async () => {
  const f = await fixture({ live: true });
  try {
    const reset = Date.now() + 60_000;
    await f.modes({ mode: 'live', reset, after: 'auth' });
    const daemon = f.p.daemon({ herdr: f.herdr }); await daemon.acquireLeader();
    const id = await task(daemon, 'resumed-auth');
    await pollUntil(daemon, async () => Boolean((await daemon.jobs.get(id))?.quotaWait));
    await daemon.poll(new Date(reset + 1));
    await pollUntil(daemon, async () => (await daemon.jobs.get(id))?.status === 'failed');
    assert.equal((await daemon.jobs.get(id))?.attempt, 1);
    assert.equal((await daemon.jobs.get(id))?.quotaWait, undefined);
    assert.equal(f.sends(), 1);
  } finally { await f.cleanup(); }
});


test('a fallback Codex task that exhausts quota resumes its saved thread, never Claude', async () => {
  const f = await fixture();
  try {
    const reset = Date.now() + 60_000;
    await cache(f.p, 'claude', reset + 60_000);
    await f.modes({ mode: 'done' }, { mode: 'quota', reset, noise: 300_000 });
    const daemon = f.p.daemon(); await daemon.acquireLeader();
    const id = await task(daemon, 'codex-resume');
    await pollUntil(daemon, async () => (await daemon.jobs.get(id))?.status === 'queued' && Boolean((await daemon.jobs.get(id))?.quotaWait));
    assert.equal((await daemon.jobs.get(id))?.codexThreadId, 'thread-codex-resume');
    await f.modes({ mode: 'done' }, { mode: 'done' });
    await pollUntil(daemon, async () => { await daemon.poll(new Date(Date.now() + 60_000)); return (await daemon.jobs.get(id))?.status === 'done'; });
    const calls = await f.calls();
    assert.deepEqual(calls.map((call) => call.provider), ['codex', 'codex']);
    assert.deepEqual(calls[1]!.args.slice(0, 3), ['exec', 'resume', 'thread-codex-resume']);
    assert.equal((await daemon.jobs.get(id))?.retryCount, 0);
  } finally { await f.cleanup(); }
});


for (const mode of ['quota', 'retryable']) {
  test(`auto-selected workspace and Claude conversation remain pinned through ${mode} recovery`, async () => {
    const f = await fixture();
    try {
      const reset = Date.now() + 60_000;
      const a = join(f.p.root, 'slot-a'); const b = join(f.p.root, 'slot-b');
      await mkdir(a); await mkdir(b);
      f.p.manifest.pools.set('resume-slots', { kind: 'workspaces', name: 'resume-slots', members: [{ name: 'a', cwd: a, herdr: 'a' }, { name: 'b', cwd: b, herdr: 'b' }] });
      const op = f.p.manifest.workflows.get('demo')!.operations.get('task')!;
      op.pool = 'resume-slots'; op.retries = 1; op.retryDelayMs = 60_000;
      await f.modes({ mode, reset });
      const daemon = f.p.daemon(); await daemon.acquireLeader();
      const blocker = await daemon.pools.acquire('resume-slots', 'blocker', { member: 'a' });
      assert.ok(blocker.granted);
      const id = await task(daemon, `workspace-${mode}`);
      await pollUntil(daemon, async () => (await daemon.jobs.get(id))?.status === 'queued' && (await daemon.jobs.get(id))!.attempt === 2);
      await daemon.pools.release('blocker', blocker.hold);
      await f.modes({ mode: 'done' });
      await pollUntil(daemon, async () => { await daemon.poll(new Date(Date.now() + 60_001)); return (await daemon.jobs.get(id))?.status === 'done'; });
      const calls = await f.calls();
      assert.deepEqual(calls.map((call) => call.cwd), [b, b]);
      assert.equal(calls[1]!.sessionId, calls[0]!.sessionId);
      assert.ok(calls[1]!.args.includes('--resume'));
      assert.equal((await daemon.jobs.get(id))?.member, 'b');
    } finally { await f.cleanup(); }
  });
}

test('a fallback Codex ordinary retry keeps its thread after oversized output', async () => {
  const f = await fixture();
  try {
    const reset = Date.now() + 120_000;
    await cache(f.p, 'claude', reset);
    const op = f.p.manifest.workflows.get('demo')!.operations.get('task')!;
    op.retries = 1; op.retryDelayMs = 60_000;
    await f.modes({ mode: 'done' }, { mode: 'retryable', noise: 300_000 });
    const daemon = f.p.daemon(); await daemon.acquireLeader();
    const id = await task(daemon, 'codex-ordinary');
    await pollUntil(daemon, async () => (await daemon.jobs.get(id))?.status === 'queued' && (await daemon.jobs.get(id))!.attempt === 2);
    await f.modes({ mode: 'done' }, { mode: 'done' });
    await pollUntil(daemon, async () => { await daemon.poll(new Date(Date.now() + 60_001)); return (await daemon.jobs.get(id))?.status === 'done'; });
    const calls = await f.calls();
    assert.deepEqual(calls[1]!.args.slice(0, 3), ['exec', 'resume', 'thread-codex-ordinary']);
    assert.equal((await daemon.jobs.get(id))?.retryCount, 1);
  } finally { await f.cleanup(); }
});

test('fallback Codex persists a rendered reset in its configured child timezone', async () => {
  const f = await fixture();
  try {
    const timeZone = 'America/New_York';
    f.p.manifest.workflows.get('demo')!.operations.get('task')!.env['TZ'] = timeZone;
    const until = Math.ceil((Date.now() + 86_400_000) / 60_000) * 60_000;
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone, month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true }).formatToParts(until).map((part) => [part.type, part.value]));
    const message = `You've hit your usage limit. Try again at ${parts['month']} ${parts['day']}, ${parts['year']} ${parts['hour']}:${parts['minute']} ${parts['dayPeriod']}.`;
    await f.modes({ mode: 'quota' }, { mode: 'quota', message });
    const daemon = f.p.daemon(); await daemon.acquireLeader();
    await rememberQuota(daemon.backend.docs, quotaFromEvent({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected' } }, 'claude')!);
    const jobId = await task(daemon, 'child-zone');
    await pollUntil(daemon, async () => (await daemon.jobs.get(jobId))?.quotaWait?.provider === 'codex');
    assert.equal((await daemon.jobs.get(jobId))?.quotaWait?.until, new Date(until).toISOString());
  } finally { await f.cleanup(); }
});

test('ending a subject clears threads created by fallback for per-subject Claude tabs', async () => {
  const f = await fixture({ live: true, timeout: '5s' });
  try {
    await cache(f.p, 'claude', Date.now() + 120_000);
    await f.modes({ mode: 'done' }, { mode: 'done', endSubjects: ['ended'] });
    const daemon = f.p.daemon({ herdr: f.herdr }); await daemon.acquireLeader();
    const first = await task(daemon, 'ended', 'first');
    await pollUntil(daemon, async () => (await daemon.jobs.get(first))?.status === 'done');
    assert.deepEqual(await f.p.backend.docs.list('threads'), []);
    await f.modes({ mode: 'done' });
    const second = await task(daemon, 'ended', 'second');
    await pollUntil(daemon, async () => (await daemon.jobs.get(second))?.status === 'done');
    assert.notEqual((await f.calls())[1]!.args[1], 'resume');
  } finally { await f.cleanup(); }
});

async function review(daemon: Daemon, subject: string, key = subject) {
  return (await enqueue(daemon.jobs, { project: 'demo', workflow: 'demo', operation: 'review', subject, input: { head: 'abc' }, trigger: { id: key, name: 'test', kind: 'manual' } })).id;
}

for (const placement of ['headless', 'herdr'] as const) {
  test(`a new Codex review falls back to Claude during a Codex cooldown and answers through output.json (${placement})`, async () => {
    const f = await fixture({ review: placement });
    try {
      await cache(f.p, 'codex', Date.now() + 60_000);
      await f.modes({ mode: 'done' }, { mode: 'done' });
      await mkdir(join(f.p.root, '.claude', 'agents'), { recursive: true });
      await writeFile(join(f.p.root, '.claude', 'agents', 'code-reviewer.md'), '---\nname: code-reviewer\n---\nReview.\n');
      const daemon = f.p.daemon(placement === 'herdr' ? { herdr: f.herdr } : {}); await daemon.acquireLeader();
      const id = await review(daemon, 'pr-1');
      await pollUntil(daemon, async () => (await daemon.jobs.get(id))?.status === 'done');
      const job = (await daemon.jobs.get(id))!;
      const outputPath = join(f.p.manifest.runtime.stateDir, 'runs', id, 'a1', 'output.json');
      const calls = await f.calls();
      assert.deepEqual(calls.map((call) => call.provider), ['claude']);
      const args = calls[0]!.args;
      assert.equal(args[0], '-p');
      assert.equal(args[1], `Review pr-1 from ${join(f.p.manifest.runtime.stateDir, 'runs', id, 'a1', 'input.json')} into ${outputPath}. Answer only with the JSON your output schema requires.`);
      assert.deepEqual(JSON.parse(args[args.indexOf('--json-schema') + 1]!), REVIEW_SCHEMA);
      assert.equal(args[args.indexOf('--agent') + 1], 'code-reviewer');
      assert.deepEqual(args.slice(args.indexOf('--permission-mode'), args.indexOf('--permission-mode') + 6), ['--permission-mode', 'dontAsk', '--allowedTools', 'Read(//**)', '--disallowedTools', 'Edit,Write,NotebookEdit']);
      assert.equal(args.includes('-c'), false);
      assert.equal(args.includes('gpt-test'), false);
      assert.equal(job.provider, 'claude');
      // It answers once: no Claude session is started or kept for a retry to resume.
      assert.equal(calls[0]!.sessionId, undefined);
      assert.equal(job.claudeSessionId, undefined);
      // In herdr the run is a per-job pane of its own; the runtime still reads its answer from the run's output.
      assert.ok(job.history.some((item) => item.event === 'started' && item.detail?.startsWith(placement === 'herdr' ? 'herdr pane' : 'headless')));
      assert.deepEqual(JSON.parse(await readFile(outputPath, 'utf8')), { verdict: 'pass', subject: 'pr-1' });
      assert.deepEqual(job.outcome?.evidence, [outputPath]);
      const next = (await daemon.jobs.list()).find((other) => other.operation === 'verdict')!;
      assert.equal(next.subject, 'pr-1');
      assert.deepEqual(next.input, { head: 'abc', output: outputPath });
      assert.ok(f.p.lines.some((line) => line.includes('job runs on its fallback provider')));
      // Nothing of the Claude run is kept for the subject: the next Codex run is not pinned to Claude.
      assert.deepEqual(await f.p.backend.docs.list('threads'), []);
      assert.deepEqual(await f.p.backend.docs.list(PROVIDER_AFFINITIES), []);
      assert.deepEqual(await f.p.backend.docs.list(SUBJECT_TABS_COLLECTION), []);
    } finally { await f.cleanup(); }
  });
}

test('a Claude review without structured output fails instead of passing on its exit status', async () => {
  const f = await fixture({ review: 'headless' });
  try {
    await cache(f.p, 'codex', Date.now() + 60_000);
    await f.modes({ mode: 'done', prose: true }, { mode: 'done' });
    const daemon = f.p.daemon(); await daemon.acquireLeader();
    const id = await review(daemon, 'pr-2');
    await pollUntil(daemon, async () => (await daemon.jobs.get(id))?.status === 'failed');
    const job = (await daemon.jobs.get(id))!;
    assert.equal(job.outcome?.failure?.reason, 'claude returned no structured output for the schema');
    assert.equal(job.outcome?.exitCode, 0);
    assert.deepEqual(job.outcome?.next, []);
    assert.equal((await daemon.jobs.list()).some((other) => other.operation === 'verdict'), false);
    await assert.rejects(readFile(join(f.p.manifest.runtime.stateDir, 'runs', id, 'a1', 'output.json'), 'utf8'), { code: 'ENOENT' });
    assert.deepEqual((await f.calls()).map((call) => call.provider), ['claude']);
  } finally { await f.cleanup(); }
});

test('a retried Codex review runs on Claude during a Codex cooldown', async () => {
  const f = await fixture({ review: 'headless' });
  try {
    const op = f.p.manifest.workflows.get('demo')!.operations.get('review')!;
    op.retries = 1; op.retryDelayMs = 100;
    await f.modes({ mode: 'done' }, { mode: 'auth' });
    const daemon = f.p.daemon(); await daemon.acquireLeader();
    const id = await review(daemon, 'pr-3');
    await pollUntil(daemon, async () => (await daemon.jobs.get(id))?.status === 'queued' && (await daemon.jobs.get(id))!.attempt === 2);
    assert.equal((await daemon.jobs.get(id))?.provider, 'codex');
    await cache(f.p, 'codex', Date.now() + 60_000);
    await sleep(200);
    await pollUntil(daemon, async () => (await daemon.jobs.get(id))?.status === 'done', 10_000);
    const job = (await daemon.jobs.get(id))!;
    assert.equal(job.provider, 'claude');
    assert.equal(job.attempt, 2);
    assert.deepEqual((await f.calls()).map((call) => call.provider), ['codex', 'claude']);
  } finally { await f.cleanup(); }
});

test('a started Codex review that hits the usage limit runs on Claude at its next start, without spending a retry', async () => {
  const f = await fixture({ review: 'headless' });
  try {
    const reset = Date.now() + 60_000;
    await f.modes({ mode: 'done' }, { mode: 'quota', reset });
    const daemon = f.p.daemon(); await daemon.acquireLeader();
    const id = await review(daemon, 'pr-8');
    await pollUntil(daemon, async () => (await daemon.jobs.get(id))?.status === 'done', 10_000);
    const job = (await daemon.jobs.get(id))!;
    assert.equal(job.provider, 'claude');
    assert.equal(job.attempt, 2);
    assert.equal(job.retryCount, 0);
    assert.ok(job.history.some((item) => item.event === 'quota wait' && item.detail?.startsWith('codex until')));
    assert.deepEqual((await f.calls()).map((call) => call.provider), ['codex', 'claude']);
    const cooldowns = Object.fromEntries((await f.p.backend.docs.list<QuotaWait>(PROVIDER_COOLDOWNS)).map((item) => [item.key, item.value]));
    assert.equal(cooldowns['codex']?.until, new Date(reset).toISOString());
  } finally { await f.cleanup(); }
});

test('a review an older daemon left waiting for the Codex reset is decided again at start and runs on Claude', async () => {
  const f = await fixture({ review: 'headless' });
  try {
    const reset = Date.now() + 60_000;
    const quota = await cache(f.p, 'codex', reset);
    await f.modes({ mode: 'done' }, { mode: 'done' });
    const daemon = f.p.daemon(); await daemon.acquireLeader();
    const id = await review(daemon, 'pr-9');
    // The state an older daemon wrote: a not-started task held until the reset by its quota wait.
    await daemon.jobs.update(id, (current) => {
      current.notBefore = quota.until;
      current.waitingFor = `available provider usage limit until ${quota.until}`;
      current.quotaWait = quota;
      return current;
    });
    await daemon.poll();
    assert.equal((await daemon.jobs.get(id))?.status, 'queued');
    assert.deepEqual(await f.calls(), []);
    await daemon.resumeAfterRestart();
    await pollUntil(daemon, async () => (await daemon.jobs.get(id))?.status === 'done', 10_000);
    assert.equal((await daemon.jobs.get(id))?.provider, 'claude');
    assert.deepEqual((await f.calls()).map((call) => call.provider), ['claude']);
  } finally { await f.cleanup(); }
});

test('a started Claude task without a Claude fallback keeps its provider and its wait across a restart', async () => {
  const f = await fixture();
  try {
    const reset = Date.now() + 60_000;
    await f.modes({ mode: 'quota', reset });
    const daemon = f.p.daemon(); await daemon.acquireLeader();
    const id = await task(daemon, 'pinned');
    await pollUntil(daemon, async () => (await daemon.jobs.get(id))?.status === 'queued' && Boolean((await daemon.jobs.get(id))?.quotaWait));
    const before = (await daemon.jobs.get(id))!;
    assert.equal(before.provider, 'claude');
    assert.equal(before.notBefore, new Date(reset).toISOString());
    await daemon.resumeAfterRestart();
    await daemon.poll();
    const after = (await daemon.jobs.get(id))!;
    assert.equal(after.status, 'queued');
    assert.equal(after.provider, 'claude');
    assert.equal(after.notBefore, new Date(reset).toISOString());
    assert.equal(after.attempt, before.attempt);
    assert.deepEqual((await f.calls()).map((call) => call.provider), ['claude']);
  } finally { await f.cleanup(); }
});

test('a new Codex review waits for the earlier reset while both providers cool down', async () => {
  const f = await fixture({ review: 'headless' });
  try {
    const claudeReset = Date.now() + 60_000;
    await cache(f.p, 'codex', claudeReset + 60_000);
    await cache(f.p, 'claude', claudeReset);
    await f.modes({ mode: 'done' }, { mode: 'done' });
    const daemon = f.p.daemon(); await daemon.acquireLeader();
    const id = await review(daemon, 'pr-4');
    await daemon.poll();
    const waiting = (await daemon.jobs.get(id))!;
    assert.equal(waiting.status, 'queued');
    assert.equal(waiting.notBefore, new Date(claudeReset).toISOString());
    assert.equal(waiting.provider, undefined);
    assert.deepEqual(await f.calls(), []);
    await pollUntil(daemon, async () => { await daemon.poll(new Date(claudeReset + 1)); return (await daemon.jobs.get(id))?.status === 'done'; });
    assert.deepEqual((await f.calls()).map((call) => call.provider), ['claude']);
  } finally { await f.cleanup(); }
});

for (const placement of ['headless', 'herdr'] as const) {
  test(`a second review during a Codex cooldown falls back to Claude despite the subject's Codex affinity, and Codex continues its thread after (${placement})`, async () => {
    const f = await fixture({ review: placement });
    try {
      await f.modes({ mode: 'done' }, { mode: 'done' });
      const daemon = f.p.daemon(placement === 'herdr' ? { herdr: f.herdr } : {}); await daemon.acquireLeader();
      const first = await review(daemon, 'pr-5', 'first');
      await pollUntil(daemon, async () => (await daemon.jobs.get(first))?.status === 'done');
      const [thread] = await f.p.backend.docs.list<{ threadId: string; updatedAt: string }>('threads');
      assert.equal(thread?.value.threadId, 'thread-pr-5');
      const affinities = (await f.p.backend.docs.list<{ provider: string }>(PROVIDER_AFFINITIES)).map((item) => item.value);
      assert.deepEqual(affinities.map((value) => value.provider), ['codex']);
      const tabs = (await f.p.backend.docs.list<{ provider?: string }>(SUBJECT_TABS_COLLECTION)).map((item) => item.value);
      assert.deepEqual(tabs.map((tab) => tab.provider), placement === 'herdr' ? ['codex'] : []);
      // The subject's Codex affinity (and, in herdr, its idle Codex tab) does not hold the next review.
      await cache(f.p, 'codex', Date.now() + 60_000);
      const second = await review(daemon, 'pr-5', 'second');
      await pollUntil(daemon, async () => (await daemon.jobs.get(second))?.status === 'done');
      assert.equal((await daemon.jobs.get(second))?.provider, 'claude');
      assert.equal((await daemon.jobs.get(second))?.codexThreadId, undefined);
      assert.deepEqual((await f.p.backend.docs.list('threads')).map((item) => item.value), [thread!.value]);
      assert.deepEqual((await f.p.backend.docs.list(PROVIDER_AFFINITIES)).map((item) => item.value), affinities);
      assert.deepEqual((await f.p.backend.docs.list(SUBJECT_TABS_COLLECTION)).map((item) => item.value), tabs);
      // After the reset the next Codex review continues the subject's own thread.
      await f.p.backend.docs.delete(PROVIDER_COOLDOWNS, 'codex');
      const third = await review(daemon, 'pr-5', 'third');
      await pollUntil(daemon, async () => (await daemon.jobs.get(third))?.status === 'done');
      const calls = await f.calls();
      assert.deepEqual(calls.map((call) => call.provider), ['codex', 'claude', 'codex']);
      assert.deepEqual(calls[2]!.args.slice(0, 3), ['exec', 'resume', 'thread-pr-5']);
    } finally { await f.cleanup(); }
  });
}

test('a new review waits for Codex while the subject tab still runs a Codex review, even during a Codex cooldown', async () => {
  const f = await fixture({ review: 'herdr' });
  try {
    await f.modes({ mode: 'done' }, { mode: 'hold' });
    const daemon = f.p.daemon({ herdr: f.herdr }); await daemon.acquireLeader();
    const first = await review(daemon, 'pr-7', 'first');
    await pollUntil(daemon, async () => (await daemon.jobs.get(first))?.status === 'running'
      && (await f.p.backend.docs.list<{ provider?: string; jobId: string }>(SUBJECT_TABS_COLLECTION)).some((item) => item.value.provider === 'codex' && item.value.jobId === first)
      && (await f.calls()).length === 1);
    const reset = Date.now() + 60_000;
    await cache(f.p, 'codex', reset);
    const second = await review(daemon, 'pr-7', 'second');
    await daemon.poll();
    const waiting = (await daemon.jobs.get(second))!;
    assert.equal(waiting.status, 'queued');
    assert.equal(waiting.provider, 'codex');
    assert.equal(waiting.notBefore, new Date(reset).toISOString());
    assert.deepEqual((await f.calls()).map((call) => call.provider), ['codex']);
    await writeFile(join(f.p.data, 'continue-pr-7'), 'continue');
    await pollUntil(daemon, async () => (await daemon.jobs.get(first))?.status === 'done');
  } finally { await f.cleanup(); }
});

test('a usage limit hit by a Claude review requeues it without spending a retry, leaves the Codex cooldown alone, and returns to Codex once Codex is free', async () => {
  const f = await fixture({ review: 'headless' });
  try {
    const claudeReset = Date.now() + 60_000;
    const codexCooldown = await cache(f.p, 'codex', claudeReset + 60_000);
    await f.modes({ mode: 'quota', reset: claudeReset }, { mode: 'done' });
    const daemon = f.p.daemon(); await daemon.acquireLeader();
    const id = await review(daemon, 'pr-6');
    await pollUntil(daemon, async () => (await daemon.jobs.get(id))?.status === 'queued' && Boolean((await daemon.jobs.get(id))?.quotaWait));
    const waiting = (await daemon.jobs.get(id))!;
    assert.equal(waiting.quotaWait?.provider, 'claude');
    assert.equal(waiting.notBefore, new Date(claudeReset).toISOString());
    assert.equal(waiting.retryCount, 0);
    assert.equal(waiting.attempt, 2);
    const cooldowns = Object.fromEntries((await f.p.backend.docs.list<QuotaWait>(PROVIDER_COOLDOWNS)).map((item) => [item.key, item.value]));
    assert.equal(cooldowns['claude']?.until, new Date(claudeReset).toISOString());
    assert.deepEqual(cooldowns['codex'], codexCooldown);
    // With Codex free and Claude limited again, the task returns to Codex instead of waiting for Claude.
    await f.p.backend.docs.delete(PROVIDER_COOLDOWNS, 'codex');
    await cache(f.p, 'claude', claudeReset + 120_000);
    await f.modes({ mode: 'done' }, { mode: 'done' });
    // The clock runs on from past the reset, so a run lease being given back lapses as it would.
    const skew = claudeReset + 1_000 - Date.now();
    await pollUntil(daemon, async () => { await daemon.poll(new Date(Date.now() + skew)); return (await daemon.jobs.get(id))?.status === 'done'; }, 10_000);
    assert.deepEqual((await f.calls()).map((call) => call.provider), ['claude', 'codex']);
    assert.equal((await daemon.jobs.get(id))?.provider, 'codex');
    assert.equal((await daemon.jobs.get(id))?.retryCount, 0);
  } finally { await f.cleanup(); }
});
