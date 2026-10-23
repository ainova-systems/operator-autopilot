import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { Herdr } from './herdr.ts';
import type { Manifest, OperationSpec } from './manifest.ts';

const execFileAsync = promisify(execFile);

export interface ValidationReport {
  problems: string[];
  warnings: string[];
}

export interface ValidateOptions {
  herdr: Herdr;
  /** Runs every script with `--describe` and expects `{"contract": 1}` on stdout. */
  describe: boolean;
  /** Problems reported by the state backend, or undefined when it was not checked. */
  stateProblems?: string[];
}

async function onPath(binary: string): Promise<boolean> {
  try { await execFileAsync('sh', ['-c', `command -v ${binary}`]); return true; } catch { return false; }
}

function workingDirectories(manifest: Manifest, op: OperationSpec): string[] {
  const pool = op.pool ? manifest.pools.get(op.pool) : undefined;
  return pool?.kind === 'workspaces' ? pool.members.map((member) => member.cwd) : [manifest.root];
}

/** File arguments in a command line, e.g. the script of `node scripts/discover.mjs`. */
export function scriptFiles(command: string): string[] {
  return command.split(/\s+/).filter((token) => /^[^-$][^\s]*\.(m?js|cjs|ts|sh|py)$/.test(token));
}

/**
 * Checks everything a manifest names before anything runs: scripts, skills, agent definitions,
 * schemas, engine binaries, herdr workspaces and the state backend.
 */
export async function validateProject(manifest: Manifest, warnings: string[], options: ValidateOptions): Promise<ValidationReport> {
  const report: ValidationReport = { problems: [], warnings: [...warnings] };
  const engines = new Set<string>();
  const herdrWorkspaces = new Set<string>();
  for (const workflow of manifest.workflows.values()) {
    if (!workflow.enabled) continue;
    for (const op of workflow.operations.values()) {
      const where = `workflows.${workflow.name}.operations.${op.name}`;
      const cwds = workingDirectories(manifest, op);
      if (op.command) {
        for (const file of scriptFiles(op.command)) {
          for (const cwd of cwds) if (!existsSync(resolve(cwd, file))) report.problems.push(`${where}: ${file} does not exist in ${cwd}`);
        }
      }
      if (op.engine === 'claude' || op.engine === 'codex') engines.add(op.engine);
      if (op.skill) {
        for (const cwd of cwds) if (!existsSync(join(cwd, '.claude', 'skills', op.skill, 'SKILL.md'))) report.problems.push(`${where}: skill ${op.skill} is not installed in ${cwd} (.claude/skills/${op.skill}/SKILL.md)`);
      }
      if (op.agent) {
        for (const cwd of cwds) if (!existsSync(join(cwd, '.codex', 'agents', `${op.agent}.toml`))) report.problems.push(`${where}: agent ${op.agent} has no .codex/agents/${op.agent}.toml in ${cwd}`);
      }
      if (op.schema && !existsSync(resolve(manifest.root, op.schema))) report.problems.push(`${where}: schema ${op.schema} does not exist`);
      if (op.placement === 'herdr') {
        const pool = op.pool ? manifest.pools.get(op.pool) : undefined;
        if (pool?.kind === 'workspaces') for (const member of pool.members) herdrWorkspaces.add(member.herdr);
        else if (manifest.herdr.workspace) herdrWorkspaces.add(manifest.herdr.workspace);
        else report.warnings.push(`${where}: placement herdr without a herdr workspace (herdr.workspace or a workspaces pool); it will run headless`);
      }
      if (options.describe && op.kind === 'script' && op.command) {
        try {
          const { stdout } = await execFileAsync('/bin/sh', ['-c', `${op.command} --describe`], { cwd: manifest.root, timeout: 20_000 });
          const described = JSON.parse(stdout) as { contract?: unknown };
          if (described.contract !== manifest.contract) report.problems.push(`${where}: --describe reports contract ${JSON.stringify(described.contract)}, expected ${manifest.contract}`);
        } catch (error) {
          report.problems.push(`${where}: --describe did not answer with contract JSON (${(error as Error).message.split('\n')[0]})`);
        }
      }
    }
  }
  for (const engine of engines) if (!(await onPath(engine))) report.warnings.push(`engine ${engine} is not on PATH for this user`);
  if (herdrWorkspaces.size > 0) {
    if (!(await options.herdr.available())) report.warnings.push('herdr is not reachable; herdr placements will run headless');
    else for (const workspace of herdrWorkspaces) if (!(await options.herdr.findWorkspace(workspace))) report.warnings.push(`herdr workspace ${workspace} does not exist; jobs placed there will run headless`);
  }
  if (options.stateProblems) report.problems.push(...options.stateProblems.map((problem) => `state: ${problem}`));
  return report;
}
