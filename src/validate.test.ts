import { after, test } from 'node:test';
import { strict as assert } from 'node:assert';
import { chmod, mkdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { absentHerdr, createTestProject, type TestProject } from './test-support/project.ts';
import { validateProject } from './validate.ts';

const projects: TestProject[] = [];
after(async () => { for (const p of projects) await p.cleanup(); });

async function reviewProject(definition: string | undefined): Promise<TestProject> {
  const p = await createTestProject({ extraOperations: '      review: { kind: agent, engine: codex, agent: code-reviewer }' });
  projects.push(p);
  if (definition !== undefined) {
    await mkdir(join(p.root, '.codex', 'agents'), { recursive: true });
    await writeFile(join(p.root, '.codex', 'agents', 'code-reviewer.toml'), definition);
  }
  return p;
}

async function agentProblems(p: TestProject): Promise<string[]> {
  const report = await validateProject(p.manifest, [], { herdr: absentHerdr, describe: false });
  return report.problems.filter((problem) => problem.includes('operations.review'));
}

test('a codex operation needs its agent definition, and one the runtime can read', async () => {
  assert.deepEqual(await agentProblems(await reviewProject('model = "gpt-6.1-sol"\ndeveloper_instructions = """\nReview.\n"""\n')), []);
  assert.match((await agentProblems(await reviewProject(undefined)))[0] ?? '', /agent code-reviewer has no \.codex\/agents\/code-reviewer\.toml/);
  assert.match((await agentProblems(await reviewProject('model = "a"\ntools = ["x"]\n')))[0] ?? '', /unsupported value for tools on line 2/);
});

test('a codex operation with fallback: claude needs the claude engine too, and warns when Claude lacks its agent', async () => {
  const p = await createTestProject({ extraOperations: '      review: { kind: agent, engine: codex, agent: code-reviewer, schema: review.json, fallback: claude }' });
  projects.push(p);
  await writeFile(join(p.root, 'review.json'), '{"type":"object"}');
  await mkdir(join(p.root, '.codex', 'agents'), { recursive: true });
  await writeFile(join(p.root, '.codex', 'agents', 'code-reviewer.toml'), 'model = "gpt-test"\n');
  const bin = join(p.root, 'bin');
  await mkdir(bin);
  await symlink('/bin/sh', join(bin, 'sh'));
  await writeFile(join(bin, 'codex'), '#!/bin/sh\n');
  await chmod(join(bin, 'codex'), 0o755);
  const path = process.env['PATH'];
  process.env['PATH'] = bin;
  try {
    const report = await validateProject(p.manifest, [], { herdr: absentHerdr, describe: false });
    assert.deepEqual(report.problems.filter((problem) => problem.includes('operations.review')), []);
    assert.ok(report.warnings.includes('engine claude is not on PATH for this user'));
    assert.ok(!report.warnings.includes('engine codex is not on PATH for this user'));
    assert.ok(report.warnings.some((warning) => warning.includes('operations.review: the claude fallback runs without agent code-reviewer')));
    await mkdir(join(p.root, '.claude', 'agents'), { recursive: true });
    await writeFile(join(p.root, '.claude', 'agents', 'code-reviewer.md'), '---\nname: code-reviewer\n---\n');
    const defined = await validateProject(p.manifest, [], { herdr: absentHerdr, describe: false });
    assert.ok(!defined.warnings.some((warning) => warning.includes('the claude fallback runs without agent')));
  } finally {
    process.env['PATH'] = path;
  }
});

test('the demo project validates without problems', async () => {
  const p = await createTestProject();
  projects.push(p);
  const report = await validateProject(p.manifest, [], { herdr: absentHerdr, describe: true });
  assert.deepEqual(report.problems, []);
});

test('a host no workspace names is warned that no workspace directory was checked', async () => {
  const p = await createTestProject({
    pools: '  host-slot:\n    workspaces:\n      h: { count: 1, host: vm1, cwd: "../missing-{name}" }\n',
    extraOperations: '      hosted: { kind: agent, engine: command, command: node scripts/fake-agent.mjs, pool: host-slot, timeout: 30m }',
  });
  projects.push(p);
  const saved = process.env['OPERATOR_HOST'];
  try {
    process.env['OPERATOR_HOST'] = 'laptop';
    const elsewhere = await validateProject(p.manifest, [], { herdr: absentHerdr, describe: false });
    assert.match(elsewhere.warnings.join('\n'), /no workspace names host laptop \(hosts: vm1\), so no workspace directory was checked/);
    assert.deepEqual(elsewhere.problems.filter((problem) => problem.includes('missing-h1')), []);
    process.env['OPERATOR_HOST'] = 'vm1';
    const here = await validateProject(p.manifest, [], { herdr: absentHerdr, describe: false });
    assert.equal(here.warnings.some((warning) => warning.includes('no workspace names host')), false);
    assert.match(here.problems.join('\n'), /fake-agent\.mjs does not exist in .*missing-h1/);
  } finally {
    if (saved === undefined) delete process.env['OPERATOR_HOST']; else process.env['OPERATOR_HOST'] = saved;
  }
});
