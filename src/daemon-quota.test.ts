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
import type { Daemon } from './daemon.ts';

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
appendFileSync(join(data, 'provider-calls.jsonl'), JSON.stringify({ provider, args, sessionId, subject: input.subject, pid: process.pid }) + '\\n');
let transcript;
if (provider === 'claude' && sessionId) {
  const dir = join(process.env.CLAUDE_CONFIG_DIR, 'projects', process.cwd().replace(/[^a-zA-Z0-9]/g, '-'));
  mkdirSync(dir, { recursive: true });
  transcript = join(dir, sessionId + '.jsonl');
  if (!existsSync(transcript)) writeFileSync(transcript, '');
}
const result = { contract: 1, status: 'done', evidence: [], next: [] };
if (provider === 'codex') process.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: 'thread-' + input.subject }) + '\\n');
const done = () => {
  if (setting.after === 'auth') { process.stderr.write('Authentication failed\\n'); process.exit(1); }
  if (provider === 'codex') writeFileSync(args[args.indexOf('-o') + 1], JSON.stringify(result));
  else writeFileSync(process.env.OPERATOR_RESULT, JSON.stringify(result));
  process.exit(0);
};
if (setting.mode === 'done') done();
if (setting.mode === 'auth') { process.stderr.write('Authentication failed\\n'); process.exit(1); }
const event = provider === 'claude'
  ? { type: 'rate_limit_event', rate_limit_info: { status: 'rejected', ...(setting.reset ? { resetsAt: setting.reset / 1000 } : {}) } }
  : { type: 'error', code: 'usage_limit_reached', message: "You've hit your usage limit", ...(setting.reset ? { resets_at: setting.reset / 1000 } : {}) };
if (setting.mode === 'live' || setting.mode === 'split') {
  const encoded = JSON.stringify(event) + '\\n';
  if (setting.mode === 'split') {
    appendFileSync(transcript, encoded.slice(0, 20));
    setTimeout(() => appendFileSync(transcript, encoded.slice(20)), 200);
  } else appendFileSync(transcript, encoded);
  const timer = setInterval(() => { if (existsSync(join(data, 'continue-' + input.subject))) { clearInterval(timer); done(); } }, 25);
} else {
  process.stdout.write(JSON.stringify(event) + '\\n');
  process.exit(1);
}
`;

type Mode = { mode: string; reset?: number; after?: string };
async function fixture(options: { live?: boolean; limit?: boolean; timeout?: string } = {}) {
  const extra = options.live
    ? `      task: { kind: interactive, engine: claude, fallback: codex, prompt: 'Do the task from {input}; write {result}', placement: herdr, tabs: per-subject, timeout: ${options.timeout ?? '1s'}, ${options.limit ? 'limit: checks,' : ''} args: ['--permission-mode', auto] }`
    : `      task: { kind: agent, engine: claude, fallback: codex, prompt: 'Do the task from {input}; write {result}', timeout: 5s, args: ['--permission-mode', auto] }`;
  const p = await createTestProject({ extraOperations: extra });
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
    notify: async () => undefined,
  };
  return {
    p, herdr,
    sends: () => sends,
    setStatus: (value: typeof status) => { status = value; },
    failSend: () => { rejectSends = 1; },
    modes: async (claude: Mode, codex: Mode = { mode: 'done' }) => writeFile(join(p.data, 'providers.json'), JSON.stringify({ claude, codex })),
    calls: async (): Promise<{ provider: string; args: string[]; sessionId?: string; subject: string; pid: number }[]> => {
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
    await f.modes({ mode: 'done' }, { mode: 'quota', reset });
    const daemon = f.p.daemon(); await daemon.acquireLeader();
    const id = await task(daemon, 'codex-resume');
    await pollUntil(daemon, async () => (await daemon.jobs.get(id))?.status === 'queued' && Boolean((await daemon.jobs.get(id))?.codexThreadId));
    assert.equal((await daemon.jobs.get(id))?.codexThreadId, 'thread-codex-resume');
    await f.modes({ mode: 'done' }, { mode: 'done' });
    await pollUntil(daemon, async () => { await daemon.poll(new Date(Date.now() + 60_000)); return (await daemon.jobs.get(id))?.status === 'done'; });
    const calls = await f.calls();
    assert.deepEqual(calls.map((call) => call.provider), ['codex', 'codex']);
    assert.deepEqual(calls[1]!.args.slice(0, 3), ['exec', 'resume', 'thread-codex-resume']);
    assert.equal((await daemon.jobs.get(id))?.retryCount, 0);
  } finally { await f.cleanup(); }
});
