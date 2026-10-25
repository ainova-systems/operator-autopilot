import { after, test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdir, writeFile } from 'node:fs/promises';
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

test('the demo project validates without problems', async () => {
  const p = await createTestProject();
  projects.push(p);
  const report = await validateProject(p.manifest, [], { herdr: absentHerdr, describe: true });
  assert.deepEqual(report.problems, []);
});
