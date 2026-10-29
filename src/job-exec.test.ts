import { after, test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectRun } from './collect.ts';
import { resultWritten, runJobExec } from './job-exec.ts';
import type { JobRecord } from './jobs.ts';
import type { OperationSpec } from './manifest.ts';
import { processAlive, readJsonFile, runPath, writeJsonAtomic, type CommandInfo, type ExitInfo, type LaunchSpec } from './runfiles.ts';

const dirs: string[] = [];
after(async () => { for (const dir of dirs) await rm(dir, { recursive: true, force: true }); });

const job = { id: 'j1', subject: 'pr-7', input: {} } as unknown as JobRecord;
const op: OperationSpec = { name: 'plan', kind: 'interactive', engine: 'command', command: 'x', args: [], thread: 'none', placement: 'herdr', timeoutMs: 30_000, retries: 0, retryDelayMs: 1000, exclusive: false, env: {}, notify: [], access: 'write', keepTabMs: 0 };

/** A run directory whose command is a node script; `attended` hands it the terminal. */
async function runDir(script: string, attended: boolean, keepMs = 0): Promise<{ dir: string; resultPath: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'operator-exec-'));
  dirs.push(dir);
  const resultPath = runPath(dir, 'result');
  const launch: LaunchSpec = {
    jobId: 'j1', attempt: 1, title: 'pr-7 op:plan', argv: [process.execPath, '-e', script], cwd: dir,
    env: { OPERATOR_RESULT: resultPath }, timeoutMs: 30_000,
    ...(attended ? { attended: { resultPath, graceMs: 200, ...(keepMs > 0 ? { keepMs } : {}) } } : {}),
  };
  await writeJsonAtomic(runPath(dir, 'launch'), launch);
  return { dir, resultPath };
}

const WRITE_RESULT = `require('node:fs').writeFileSync(process.env.OPERATOR_RESULT, JSON.stringify({ contract: 1, status: 'done', evidence: [], next: [], message: 'planned' }));`;

test('an attended session that wrote its result is closed, and the run counts as done', async () => {
  // The session stays open after its result, as an interactive claude does until someone types /exit.
  const { dir } = await runDir(`${WRITE_RESULT} setInterval(() => {}, 1000);`, true);
  const code = await runJobExec(dir);
  const exit = await readJsonFile<ExitInfo>(runPath(dir, 'exit'));
  const command = await readJsonFile<CommandInfo>(runPath(dir, 'command'));
  assert.equal(exit?.closedAfterResult, true);
  assert.equal(exit?.exitCode, null);
  assert.equal(exit?.signal, 'SIGTERM');
  assert.equal(command?.group, false);
  assert.equal(processAlive(command?.pid ?? 0), false);
  assert.notEqual(code, 0);
  const collected = await collectRun(job, op, dir, exit as ExitInfo);
  assert.equal(collected.result.status, 'done');
  assert.equal(collected.result.message, 'planned');
});

test('an attended session that ends without a result is a failure, not a closed session', async () => {
  const { dir } = await runDir('process.exit(0);', true);
  await runJobExec(dir);
  const exit = await readJsonFile<ExitInfo>(runPath(dir, 'exit'));
  assert.equal(exit?.exitCode, 0);
  assert.equal(exit?.closedAfterResult, undefined);
  const collected = await collectRun(job, op, dir, exit as ExitInfo);
  assert.equal(collected.result.status, 'failed');
  assert.match(collected.result.failure?.reason ?? '', /exited 0 without writing a result file/);
});

test('a command killed by a signal still fails although its result says done, unless the wrapper closed it', async () => {
  const { dir } = await runDir(`${WRITE_RESULT} process.kill(process.pid, 'SIGTERM');`, false);
  await runJobExec(dir);
  const exit = await readJsonFile<ExitInfo>(runPath(dir, 'exit'));
  assert.equal(exit?.closedAfterResult, undefined);
  assert.equal((await collectRun(job, { ...op, kind: 'agent', placement: 'headless' }, dir, exit as ExitInfo)).result.status, 'failed');
});

test('a result file counts as written only once it is complete JSON with a status', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'operator-result-'));
  dirs.push(dir);
  const path = join(dir, 'result.json');
  assert.equal(await resultWritten(path), false);
  await writeFile(path, '{"contract": 1, "sta');
  assert.equal(await resultWritten(path), false);
  await writeFile(path, '{"contract": 1}');
  assert.equal(await resultWritten(path), false);
  await writeFile(path, '{"contract": 1, "status": "done"}');
  assert.equal(await resultWritten(path), true);
});

test('a noop session closes after its result even when keepTab is set: nothing happened there to ask about', async () => {
  const noop = `require('node:fs').writeFileSync(process.env.OPERATOR_RESULT, JSON.stringify({ contract: 1, status: 'noop', evidence: [], next: [], message: 'nothing to do' })); setInterval(() => {}, 1000);`;
  const { dir } = await runDir(noop, true, 60_000);
  await runJobExec(dir);
  const exit = await readJsonFile<ExitInfo>(runPath(dir, 'exit'));
  assert.equal(exit?.closedAfterResult, true);
  assert.equal(exit?.released, undefined);
});

test('a kept session hands its result over at once and stays open for its keepTab time', async () => {
  const { dir } = await runDir(`${WRITE_RESULT} setInterval(() => {}, 1000);`, true, 2500);
  const running = runJobExec(dir);
  let handedOver: ExitInfo | undefined;
  for (let i = 0; i < 40 && !handedOver; i += 1) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    handedOver = await readJsonFile<ExitInfo>(runPath(dir, 'exit'));
  }
  const command = await readJsonFile<CommandInfo>(runPath(dir, 'command'));
  assert.equal(handedOver?.released, true);
  // The pipeline collects now, while the session is still there for questions.
  assert.equal(processAlive(command?.pid ?? 0), true);
  assert.equal((await collectRun(job, op, dir, handedOver as ExitInfo)).result.status, 'done');
  await running;
  assert.equal(processAlive(command?.pid ?? 0), false);
  assert.equal((await readJsonFile<ExitInfo>(runPath(dir, 'exit')))?.released, true);
});
