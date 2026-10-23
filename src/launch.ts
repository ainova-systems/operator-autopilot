import { spawn } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { CONTRACT_VERSION, type OperationInput } from './contract.ts';
import { buildCommand, type EngineCommand } from './engines.ts';
import { shellQuote, type Herdr, type HerdrTab } from './herdr.ts';
import type { JobRecord } from './jobs.ts';
import type { Manifest, OperationSpec } from './manifest.ts';
import { runPath, writeJsonAtomic, type LaunchSpec } from './runfiles.ts';

/** The CLI entry the wrapper is started from: the built `cli.js`, or `cli.ts` when run from source. */
export const CLI_ENTRY = fileURLToPath(new URL(import.meta.url.endsWith('.ts') ? './cli.ts' : './cli.js', import.meta.url));

export interface PreparedRun {
  runDir: string;
  command: EngineCommand;
  launch: LaunchSpec;
  input: OperationInput;
}

export function jobTitle(job: JobRecord): string {
  return `${job.subject ? `${job.subject} ` : ''}op:${job.operation}`;
}

/** Writes the run directory: the contract input file and the wrapper's launch spec. */
export async function prepareRun(manifest: Manifest, job: JobRecord, op: OperationSpec, options: { cwd: string; threadId?: string; dryRun: boolean }): Promise<PreparedRun> {
  const runDir = join(manifest.runtime.stateDir, 'runs', job.id, `a${job.attempt}`);
  await rm(runDir, { recursive: true, force: true });
  await mkdir(runDir, { recursive: true });
  const inputPath = runPath(runDir, 'input');
  const resultPath = runPath(runDir, 'result');
  const command = buildCommand(op, {
    root: manifest.root,
    runDir,
    inputPath,
    resultPath,
    workflow: job.workflow,
    operation: job.operation,
    subject: job.subject,
    ...(options.threadId ? { threadId: options.threadId } : {}),
  });
  const input: OperationInput = {
    contract: CONTRACT_VERSION,
    run: { id: `${job.id}-a${job.attempt}`, jobId: job.id, project: manifest.project, workflow: job.workflow, operation: job.operation, attempt: job.attempt },
    subject: job.subject,
    input: job.input,
    trigger: job.trigger,
    resultPath,
    dryRun: options.dryRun,
    ...(op.kind === 'agent' ? { agent: { engine: op.engine, ...(op.skill ? { skill: op.skill } : {}), ...(op.agent ? { agent: op.agent } : {}), ...(command.outputPath ? { outputPath: command.outputPath } : {}) } } : {}),
  };
  const launch: LaunchSpec = {
    jobId: job.id,
    attempt: job.attempt,
    title: jobTitle(job),
    argv: command.argv,
    cwd: options.cwd,
    env: {
      ...op.env,
      OPERATOR_INPUT: inputPath,
      OPERATOR_RESULT: resultPath,
      OPERATOR_RUN_ID: input.run.id,
      OPERATOR_MANIFEST: manifest.path,
      ...(options.dryRun ? { OPERATOR_DRY_RUN: '1' } : {}),
    },
    timeoutMs: op.timeoutMs,
    ...(manifest.envFile ? { envFile: manifest.envFile } : {}),
    ...(manifest.envKeys ? { envKeys: manifest.envKeys } : {}),
  };
  await writeJsonAtomic(inputPath, input);
  await writeJsonAtomic(runPath(runDir, 'launch'), launch);
  return { runDir, command, launch, input };
}

/** Starts the wrapper as a detached child, so a daemon restart does not end the run. */
export function startHeadless(runDir: string): number | undefined {
  const child = spawn(process.execPath, [CLI_ENTRY, 'job-exec', runDir], { cwd: runDir, detached: true, stdio: 'ignore' });
  child.unref();
  return child.pid;
}

/** Opens a tab of its own in the target herdr workspace; the wrapper starts there separately. */
export async function openHerdrTab(herdr: Herdr, workspace: string, cwd: string, title: string): Promise<HerdrTab | { degraded: string }> {
  if (!(await herdr.available())) return { degraded: 'herdr is not reachable' };
  const workspaceId = await herdr.findWorkspace(workspace);
  if (!workspaceId) return { degraded: `herdr workspace ${workspace} not found` };
  const tab = await herdr.createTab(workspaceId, cwd, title);
  await herdr.setTitle(tab.paneId, title);
  return tab;
}

export async function startInHerdr(herdr: Herdr, paneId: string, runDir: string): Promise<void> {
  await herdr.runInPane(paneId, [process.execPath, CLI_ENTRY, 'job-exec', runDir].map(shellQuote).join(' '));
}
