import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { loadEnvFile } from './env.ts';
import { OperatorError } from './errors.ts';
import { readJsonFile, runPath, writeJsonAtomic, type CommandInfo, type ExitInfo, type LaunchSpec, type WrapperInfo } from './runfiles.ts';

const HEARTBEAT_MS = 5_000;
const KILL_GRACE_MS = 10_000;

/** Signals the command's whole process group, so a shell's children end with it. */
export function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
}

/**
 * The job wrapper. It runs where the job is placed - a detached child of the daemon or a herdr
 * pane - executes the engine command in a process group of its own, and leaves the proof of
 * completion in the run directory: a heartbeat while it lives and `exit.json` when the command
 * ends. It never talks to the state backend, so a pane needs no credentials beyond what the
 * command itself loads.
 */
export async function runJobExec(runDir: string): Promise<number> {
  const launch = await readJsonFile<LaunchSpec>(runPath(runDir, 'launch'));
  if (!launch) throw new OperatorError('RUN_DIR_INVALID', `no launch.json in ${runDir}`);
  if (launch.envFile) loadEnvFile(launch.envFile, launch.envKeys);

  // The heartbeat exists before wrapper.json does, so an observer never sees a wrapper without one.
  const beat = (): Promise<void> => writeFile(runPath(runDir, 'heartbeat'), new Date().toISOString());
  await beat();
  const wrapper: WrapperInfo = { pid: process.pid, host: hostname(), startedAt: new Date().toISOString() };
  await writeJsonAtomic(runPath(runDir, 'wrapper'), wrapper);
  const heartbeat = setInterval(() => {
    beat().catch((error: unknown) => process.stderr.write(`operator: heartbeat write failed: ${(error as Error).message}\n`));
  }, HEARTBEAT_MS);

  const output = createWriteStream(runPath(runDir, 'output'), { flags: 'a' });
  output.on('error', (error) => process.stderr.write(`operator: output.log write failed: ${error.message}\n`));
  const banner = `operator: job ${launch.jobId} attempt ${launch.attempt} - ${launch.title}\n`;
  process.stdout.write(banner);
  output.write(banner);

  const [command, ...args] = launch.argv;
  let timedOut = false;
  const exit = await new Promise<ExitInfo>((resolveExit) => {
    const child = spawn(command ?? 'false', args, { cwd: launch.cwd, env: { ...process.env, ...launch.env }, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    const pid = child.pid;
    if (pid !== undefined) void writeJsonAtomic(runPath(runDir, 'command'), { pid } satisfies CommandInfo).catch(() => undefined);
    child.stdout.on('data', (chunk: Buffer) => { process.stdout.write(chunk); output.write(chunk); });
    child.stderr.on('data', (chunk: Buffer) => { process.stderr.write(chunk); output.write(chunk); });
    const timer = setTimeout(() => {
      timedOut = true;
      if (pid === undefined) return;
      signalGroup(pid, 'SIGTERM');
      setTimeout(() => signalGroup(pid, 'SIGKILL'), KILL_GRACE_MS).unref();
    }, launch.timeoutMs);
    const forward = (signal: NodeJS.Signals): void => { if (pid !== undefined) signalGroup(pid, signal); };
    process.on('SIGTERM', forward);
    process.on('SIGHUP', forward);
    process.on('SIGINT', forward);
    child.on('error', (error) => {
      clearTimeout(timer);
      resolveExit({ exitCode: 127, signal: null, timedOut: false, finishedAt: new Date().toISOString(), error: error.message });
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      // Whatever the command left behind in its group ends with it.
      if (pid !== undefined) signalGroup(pid, 'SIGKILL');
      resolveExit({ exitCode: code, signal, timedOut, finishedAt: new Date().toISOString() });
    });
  });

  clearInterval(heartbeat);
  const footer = `operator: exit ${exit.exitCode ?? exit.signal}${exit.timedOut ? ' (timed out)' : ''}${exit.error ? ` (${exit.error})` : ''} - the runtime collects the result and closes this tab\n`;
  process.stdout.write(footer);
  output.write(footer);
  await new Promise<void>((resolveEnd) => output.end(resolveEnd));
  await writeJsonAtomic(runPath(runDir, 'exit'), exit);
  return exit.exitCode ?? 1;
}
