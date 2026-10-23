import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { buildCommand, findCodexThread } from './engines.ts';
import type { OperationSpec } from './manifest.ts';

const base: OperationSpec = { name: 'op', kind: 'agent', engine: 'command', args: [], thread: 'none', placement: 'headless', timeoutMs: 1000, retries: 0, retryDelayMs: 1000, env: {} };
const context = { root: '/repo', cwd: '/repo', runDir: '/runs/j1/a1', inputPath: '/runs/j1/a1/input.json', resultPath: '/runs/j1/a1/result.json', workflow: 'development', operation: 'implement', subject: 'pr-7' };

test('a claude operation runs its skill headlessly with a pointer prompt', () => {
  const { argv } = buildCommand({ ...base, engine: 'claude', skill: 'orchestrator-implement', model: 'opus', args: ['--permission-mode', 'acceptEdits'] }, context);
  assert.equal(argv[0], 'claude');
  assert.equal(argv[1], '-p');
  assert.match(argv[2] ?? '', /^Delegated sub-agent: do not orchestrate\. Run the orchestrator-implement skill for subject pr-7\. The operation input file is \/runs\/j1\/a1\/input\.json\. Write the operation result \(contract 1\) to \/runs\/j1\/a1\/result\.json\.$/);
  assert.deepEqual(argv.slice(3), ['--model', 'opus', '--permission-mode', 'acceptEdits']);
});

test('a codex operation is read-only, schema-bound, and resumes its thread', () => {
  const op: OperationSpec = { ...base, engine: 'codex', agent: 'code-reviewer', schema: 'schemas/review.json', thread: 'per-subject' };
  const fresh = buildCommand(op, context);
  assert.deepEqual(fresh.argv.slice(0, 4), ['codex', 'exec', '-s', 'read-only']);
  assert.ok(fresh.argv.includes('--output-schema'));
  assert.equal(fresh.argv[fresh.argv.indexOf('--output-schema') + 1], '/repo/schemas/review.json');
  assert.equal(fresh.outputPath, '/runs/j1/a1/output.json');
  assert.match(fresh.argv.at(-1) ?? '', /Act as the code-reviewer agent defined in \/repo\/\.codex\/agents\/code-reviewer\.toml/);
  const inSlot = buildCommand(op, { ...context, cwd: '/slots/d1' });
  assert.match(inSlot.argv.at(-1) ?? '', /defined in \/slots\/d1\/\.codex\/agents\/code-reviewer\.toml/);
  const resumed = buildCommand(op, { ...context, threadId: 'th-1' });
  assert.deepEqual(resumed.argv.slice(0, 4), ['codex', 'exec', 'resume', 'th-1']);
  assert.ok(!resumed.argv.includes('-s'));
  assert.ok(resumed.argv.includes('sandbox_mode="read-only"'));
});

test('a command operation runs through the shell', () => {
  assert.deepEqual(buildCommand({ ...base, command: 'node scripts/x.mjs --flag' }, context).argv, ['/bin/sh', '-c', 'node scripts/x.mjs --flag']);
});

test('the codex thread id is read from the JSON event stream', () => {
  const output = 'operator: job j1\n{"type":"thread.started","thread_id":"0199-abc"}\n{"type":"turn.completed"}\nplain text\n';
  assert.equal(findCodexThread(output), '0199-abc');
  assert.equal(findCodexThread('no events here'), undefined);
});
