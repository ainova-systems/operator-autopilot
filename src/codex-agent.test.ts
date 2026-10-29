import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { parseCodexAgent } from './codex-agent.ts';

test('a generated agent definition yields its model and instructions', () => {
  const agent = parseCodexAgent([
    'name = "code-reviewer"',
    'description = "Reviews a diff. Read-only."',
    'model = "gpt-6.1-sol"',
    'sandbox_mode = "read-only"',
    '',
    'developer_instructions = """',
    '',
    'You review **diffs**: cite `file:line` and say "why".',
    "It's read-only.",
    '"""',
    '',
  ].join('\n'), 'code-reviewer.toml');
  assert.deepEqual(agent, {
    model: 'gpt-6.1-sol',
    instructions: 'You review **diffs**: cite `file:line` and say "why".\nIt\'s read-only.',
  });
});

test('escapes, literal strings, scalars, comments and tables are read as TOML reads them', () => {
  const agent = parseCodexAgent([
    '# a comment',
    "model = 'gpt-x' # trailing comment",
    'model_reasoning_effort = "high"',
    'max_turns = 12',
    'enabled = true',
    'developer_instructions = """\\',
    '   Tab\\there, quote \\" and \\u00e9.',
    'Two quotes at the end ""',
    '"""',
    '[mcp_servers.x]',
    'model = "ignored inside a table"',
  ].join('\n'), 'a.toml');
  assert.deepEqual(agent, { model: 'gpt-x', reasoningEffort: 'high', instructions: 'Tab\there, quote " and é.\nTwo quotes at the end ""' });
});

test('anything outside the understood subset is refused with its line', () => {
  assert.throws(() => parseCodexAgent('model = "a"\nlist = [1, 2]\n', 'b.toml'), /b\.toml: unsupported value for list on line 2/);
  assert.throws(() => parseCodexAgent('developer_instructions = """\nno end', 'c.toml'), /unterminated multi-line string/);
  assert.throws(() => parseCodexAgent('model = "a"\nmodel = "b"\n', 'd.toml'), /model is defined twice on line 2/);
  assert.throws(() => parseCodexAgent('model = "a" extra\n', 'e.toml'), /unexpected text after model on line 1/);
  assert.throws(() => parseCodexAgent('model = "bad \\q"\n', 'f.toml'), /unsupported escape/);
});
