import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { buildCommand, CLAUDE_FALLBACK_DENIES, CLAUDE_FALLBACK_READS, claudeFallback, codexFallback, findCodexThread, onProvider } from './engines.ts';
import type { OperationSpec } from './manifest.ts';

const base: OperationSpec = { name: 'op', kind: 'agent', engine: 'command', args: [], thread: 'none', placement: 'headless', timeoutMs: 1000, retries: 0, retryDelayMs: 1000, exclusive: false, env: {}, notify: [], access: 'write', keepTabMs: 0, tabs: 'per-job' };
const context = { root: '/repo', cwd: '/repo', runDir: '/runs/j1/a1', inputPath: '/runs/j1/a1/input.json', resultPath: '/runs/j1/a1/result.json', workflow: 'development', operation: 'implement', subject: 'pr-7' };

test('a claude operation runs its skill headlessly with a pointer prompt', () => {
  const { argv } = buildCommand({ ...base, engine: 'claude', skill: 'implement-change', model: 'opus', args: ['--permission-mode', 'acceptEdits'] }, context);
  assert.equal(argv[0], 'claude');
  assert.equal(argv[1], '-p');
  assert.match(argv[2] ?? '', /^Run the implement-change skill for subject pr-7\. The operation input file is \/runs\/j1\/a1\/input\.json\. Write the operation result \(contract 1\) to \/runs\/j1\/a1\/result\.json\.$/);
  assert.deepEqual(argv.slice(3), ['--model', 'opus', '--permission-mode', 'acceptEdits', '--output-format', 'stream-json', '--verbose']);
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

test('a codex operation carries its agent definition\'s model and instructions', () => {
  const op: OperationSpec = { ...base, engine: 'codex', agent: 'code-reviewer' };
  const agent = { model: 'gpt-6.1-sol', reasoningEffort: 'high', instructions: 'Review "diffs".\nCite file:line.' };
  const { argv } = buildCommand(op, { ...context, codexAgent: agent });
  assert.equal(argv[argv.indexOf('-m') + 1], 'gpt-6.1-sol');
  assert.ok(argv.includes('model_reasoning_effort="high"'));
  assert.ok(argv.includes('developer_instructions="Review \\"diffs\\".\\nCite file:line."'));
  const pinned = buildCommand({ ...op, model: 'gpt-other' }, { ...context, codexAgent: agent }).argv;
  assert.deepEqual(pinned.filter((arg) => arg === 'gpt-6.1-sol' || arg === 'gpt-other'), ['gpt-other']);
  const resumed = buildCommand(op, { ...context, threadId: 'th-1', codexAgent: agent }).argv;
  assert.ok(resumed.includes('developer_instructions="Review \\"diffs\\".\\nCite file:line."'));
});

test('a command operation runs through the shell', () => {
  assert.deepEqual(buildCommand({ ...base, command: 'node scripts/x.mjs --flag' }, context).argv, ['/bin/sh', '-c', 'node scripts/x.mjs --flag']);
});

test('the codex thread id is read from the JSON event stream', () => {
  const output = 'operator: job j1\n{"type":"thread.started","thread_id":"0199-abc"}\n{"type":"turn.completed"}\nplain text\n';
  assert.equal(findCodexThread(output), '0199-abc');
  assert.equal(findCodexThread('no events here'), undefined);
});

test('an attended claude run starts a session with the same prompt; without its terminal it runs -p', () => {
  const op: OperationSpec = { ...base, kind: 'interactive', engine: 'claude', skill: 'plan-change', placement: 'herdr', args: ['--permission-mode', 'auto'] };
  const session = buildCommand(op, { ...context, attended: true }).argv;
  assert.equal(session[0], 'claude');
  assert.ok(!session.includes('-p'));
  assert.match(session[1] ?? '', /^Run the plan-change skill for subject pr-7\./);
  assert.deepEqual(session.slice(2), ['--permission-mode', 'auto']);
  assert.deepEqual(buildCommand(op, context).argv.slice(0, 2), ['claude', '-p']);
});

test('a claude run in a per-subject tab starts its session under a known id, and the next one resumes it', () => {
  const op = { ...base, engine: 'claude' as const, skill: 'implement-change', model: 'opus', args: ['--permission-mode', 'auto'] };
  const id = '1b4e28ba-2fa1-11d2-883f-0016d3cca427';
  const first = buildCommand(op, { ...context, attended: true, session: { id, resume: false } }).argv;
  assert.deepEqual(first.slice(2, 4), ['--session-id', id]);
  assert.equal(first.includes('-p'), false);
  const next = buildCommand(op, { ...context, session: { id, resume: true } }).argv;
  assert.deepEqual(next.slice(0, 2), ['claude', '-p']);
  assert.deepEqual(next.slice(3, 5), ['--resume', id]);
  assert.equal(next.includes('--session-id'), false);
  assert.deepEqual(next.slice(-7), ['--model', 'opus', '--permission-mode', 'auto', '--output-format', 'stream-json', '--verbose']);
  assert.equal(buildCommand(op, context).argv.some((arg) => arg === '--session-id' || arg === '--resume'), false);
});


test('opted-in Codex fallback preserves contract and declared sandbox, without Claude policy or model arguments', () => {
  const original: OperationSpec = { ...base, engine: 'claude', fallback: 'codex', skill: 'work', model: 'opus', args: ['--permission-mode', 'auto'] };
  const fallback = codexFallback(original);
  const fresh = buildCommand(fallback, context).argv;
  assert.deepEqual(fresh.slice(0, 4), ['codex', 'exec', '-s', 'workspace-write']);
  assert.ok(fresh.includes('approval_policy="on-request"'));
  assert.ok(fresh.includes('sandbox_workspace_write.writable_roots=["/runs/j1/a1"]'));
  assert.equal(fresh.includes('opus'), false);
  assert.equal(fresh.includes('--permission-mode'), false);
  assert.match(fresh.at(-1)!, /Return the operation result \(contract 1\) as your final JSON/);
  const readOnly = buildCommand(codexFallback({ ...original, access: 'read' }), context).argv;
  assert.deepEqual(readOnly.slice(0, 4), ['codex', 'exec', '-s', 'read-only']);
  assert.equal(readOnly.some((arg) => arg.startsWith('sandbox_workspace_write.writable_roots=')), false);
  const resumed = buildCommand(fallback, { ...context, threadId: 'thread-1' }).argv;
  assert.deepEqual(resumed.slice(0, 4), ['codex', 'exec', 'resume', 'thread-1']);
  assert.ok(resumed.includes('sandbox_mode="workspace-write"'));
});

test('opted-in Claude fallback answers a Codex schema once, without editing tools or a session, with the Codex prompt and no Codex arguments', () => {
  const original: OperationSpec = { ...base, engine: 'codex', fallback: 'claude', agent: 'code-reviewer', schema: 'schemas/review.json', model: 'gpt-6.1-sol', thread: 'per-subject', tabs: 'per-subject', placement: 'herdr', access: 'read', then: 'verdict', args: ['-c', 'approval_policy=on-request'], prompt: 'Review {subject} from {input} into {output}.' };
  const fallback = claudeFallback(original);
  assert.equal(fallback.engine, 'claude');
  assert.equal(fallback.thread, 'none');
  assert.equal(fallback.tabs, 'per-job');
  assert.equal(fallback.then, 'verdict');
  const schema = '{"type":"object"}';
  const command = buildCommand(fallback, { ...context, jsonSchema: schema, claudeAgentPrompt: 'Review.', session: { id: 's-1', resume: false } });
  assert.equal(command.outputPath, '/runs/j1/a1/output.json');
  // It answers once: no session to start or resume, even when one is offered.
  assert.equal(command.session, undefined);
  assert.deepEqual(command.argv.slice(0, 3), ['claude', '-p', 'Review pr-7 from /runs/j1/a1/input.json into /runs/j1/a1/output.json.']);
  assert.deepEqual(command.argv.slice(3), ['--json-schema', schema, '--append-system-prompt', 'Review.', '--permission-mode', 'dontAsk', '--allowedTools', ...CLAUDE_FALLBACK_READS, '--disallowedTools', ...CLAUDE_FALLBACK_DENIES, '--output-format', 'stream-json', '--verbose']);
  assert.equal(command.argv.includes('-c'), false);
  assert.equal(command.argv.includes('gpt-6.1-sol'), false);
  // The agent's instructions are an appended system prompt, never --agent, whose tools list would
  // leave out the structured-output tool; without a Claude definition in the checkout, neither.
  assert.equal(command.argv.includes('--agent'), false);
  const bare = buildCommand(fallback, { ...context, jsonSchema: schema }).argv;
  assert.equal(bare.includes('--append-system-prompt'), false);
  const { prompt: _prompt, ...unprompted } = original;
  assert.match(buildCommand(claudeFallback(unprompted), { ...context, jsonSchema: schema }).argv[2]!, /^Act as the code-reviewer agent defined in \/repo\/\.codex\/agents\/code-reviewer\.toml for subject pr-7\./);
  assert.throws(() => buildCommand(fallback, context), /needs its schema/);
});

test('a run executes the configured operation, or its fallback variant on the other provider', () => {
  const codexReview: OperationSpec = { ...base, engine: 'codex', fallback: 'claude', agent: 'code-reviewer', schema: 'review.json' };
  assert.equal(onProvider(codexReview, 'codex'), codexReview);
  assert.equal(onProvider(codexReview, 'claude').structuredOutput, true);
  const { schema: _schema, ...schemaless } = codexReview;
  assert.equal(onProvider(schemaless, 'claude').engine, 'codex');
  const claudeTask: OperationSpec = { ...base, engine: 'claude', fallback: 'codex', skill: 'work' };
  assert.equal(onProvider(claudeTask, 'claude'), claudeTask);
  assert.equal(onProvider(claudeTask, 'codex').contractResult, true);
});

test('the Claude fallback may run only read-only git commands and sha256sum', () => {
  const bash = CLAUDE_FALLBACK_READS.filter((rule) => rule.startsWith('Bash('));
  const subs = new Set(bash.filter((rule) => rule.startsWith('Bash(git ')).map((rule) => rule.replace(/^Bash\(git (-C \* )?/, '').split(' ')[0]));
  assert.deepEqual([...subs].sort(), ['diff', 'log', 'merge-base', 'rev-parse', 'show', 'status']);
  assert.deepEqual(bash.filter((rule) => !rule.startsWith('Bash(git ')), ['Bash(sha256sum *)']);
  assert.ok(CLAUDE_FALLBACK_READS.includes('Read(//**)'));
  // git diff/log/show --output=<file> writes a file; the deny rule wins over the allow rules.
  assert.ok(CLAUDE_FALLBACK_DENIES.includes('Bash(git * --output*)'));
});
