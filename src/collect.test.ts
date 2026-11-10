import { after, test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectRun, readClaudeStructuredOutput } from './collect.ts';
import { claudeFallback } from './engines.ts';
import type { JobRecord } from './jobs.ts';
import type { OperationSpec } from './manifest.ts';
import { runPath, type ExitInfo } from './runfiles.ts';

const dirs: string[] = [];
after(async () => { for (const dir of dirs) await rm(dir, { recursive: true, force: true }); });

const review: OperationSpec = { name: 'review', kind: 'agent', engine: 'codex', fallback: 'claude', agent: 'code-reviewer', schema: 'review.json', args: [], thread: 'per-subject', placement: 'headless', timeoutMs: 1000, retries: 0, retryDelayMs: 1000, exclusive: false, env: {}, notify: [], access: 'read', keepTabMs: 0, tabs: 'per-job', then: 'verdict' };
const job = { id: 'j1', subject: 'pr-1', input: { head: 'abc' } } as unknown as JobRecord;
const exit = (exitCode: number): ExitInfo => ({ exitCode, signal: null, timedOut: false, finishedAt: new Date().toISOString() });
const result = (fields: Record<string, unknown>): string => JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'Reviewed.', ...fields });

/** A run directory whose output log holds the wrapper's banner, these lines and its footer. */
async function run(...lines: string[]): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'operator-collect-'));
  dirs.push(dir);
  await writeFile(runPath(dir, 'output'), ['operator: job j1 attempt 1 - pr-1 op:review', ...lines, 'operator: exit 0 - the runtime collects the result and closes this tab', ''].join('\n'));
  return dir;
}

test('the last result event of a Claude run is its answer', async () => {
  const dir = await run(JSON.stringify({ type: 'system', subtype: 'init' }), result({ structured_output: { verdict: 'first' } }), result({ structured_output: { verdict: 'last' } }));
  assert.deepEqual(await readClaudeStructuredOutput(dir), { verdict: 'last' });
});

test('a failed or schema-less ending is no answer, even after an earlier one', async () => {
  assert.equal(await readClaudeStructuredOutput(await run(result({ structured_output: { verdict: 'pass' } }), result({ subtype: 'error_max_structured_output_retries', is_error: true }))), undefined);
  assert.equal(await readClaudeStructuredOutput(await run(result({ is_error: true, structured_output: { verdict: 'pass' } }))), undefined);
  assert.equal(await readClaudeStructuredOutput(await run(result({ subtype: 'error_during_execution', structured_output: { verdict: 'pass' } }))), undefined);
  assert.equal(await readClaudeStructuredOutput(await run(result({}))), undefined);
  assert.equal(await readClaudeStructuredOutput(await run('plain prose, no events')), undefined);
  const missing = await mkdtemp(join(tmpdir(), 'operator-collect-'));
  dirs.push(missing);
  assert.equal(await readClaudeStructuredOutput(missing), undefined);
});

test('a Claude stand-in result becomes the Codex output and its then, but never on a nonzero exit', async () => {
  const op = claudeFallback(review);
  const done = await run(result({ structured_output: { verdict: 'pass' } }));
  const collected = await collectRun(job, op, done, exit(0));
  const outputPath = `${done}/output.json`;
  assert.equal(collected.result.status, 'done');
  assert.deepEqual(collected.result.evidence, [outputPath]);
  assert.deepEqual(collected.result.next, [{ operation: 'verdict', subject: 'pr-1', input: { head: 'abc', output: outputPath } }]);
  assert.deepEqual(JSON.parse(await readFile(outputPath, 'utf8')), { verdict: 'pass' });
  assert.equal(collected.threadId, undefined);

  const exited = await run(result({ structured_output: { verdict: 'pass' } }));
  const failed = await collectRun(job, op, exited, exit(1));
  assert.equal(failed.result.status, 'failed');
  assert.equal(failed.result.failure?.reason, 'claude exited 1');
  await assert.rejects(readFile(`${exited}/output.json`, 'utf8'), { code: 'ENOENT' });
});
