import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { loadEnvFile } from './env.ts';
import { OperatorError } from './errors.ts';
import { readJsonFile, runPath, writeJsonAtomic, type CommandInfo, type ExitInfo, type LaunchSpec, type WrapperInfo } from './runfiles.ts';

const HEARTBEAT_MS = 5_000;
const KILL_GRACE_MS = 10_000;
const RESULT_POLL_MS = 1_000;

/** Signals the command's whole process group, so a shell's children end with it. */
export function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
}

/** Signals a command: its whole process group when it leads one, otherwise the process alone. */
export function signalCommand(command: CommandInfo, signal: NodeJS.Signals): void {
  if (command.group !== false) { signalGroup(command.pid, signal); return; }
  try {
    process.kill(command.pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
}

/** True once the result file holds a complete JSON object with a status; a half-written file is not yet. */
export async function resultWritten(path: string): Promise<boolean> {
  return (await resultStatus(path)) !== null;
}

/** The status of a complete result file, or null while there is none. */
export async function resultStatus(path: string): Promise<string | null> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  try {
    const parsed = JSON.parse(text) as { status?: unknown } | null;
    return typeof parsed?.status === 'string' ? parsed.status : null;
  } catch {
    // Still being written: the next poll reads it again.
    return null;
  }
}

/**
 * The job wrapper. It runs where the job is placed - a detached child of the daemon or a herdr
 * pane - executes the engine command in a process group of its own, and leaves the proof of
 * completion in the run directory: a heartbeat while it lives and `exit.json` when the command
 * ends. It never talks to the state backend, so a pane needs no credentials beyond what the
 * command itself loads. An attended command owns the terminal instead and stays in the wrapper's
 * process group, so the terminal's keys and resizes reach it; the wrapper ends it once its result
 * file is written, because the slot it holds goes to the next run.
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
  const attended = launch.attended;
  let timedOut = false;
  let closedAfterResult = false;
  let released = false;
  const exit = await new Promise<ExitInfo>((resolveExit) => {
    const child = spawn(command ?? 'false', args, { cwd: launch.cwd, env: { ...process.env, ...launch.env }, stdio: attended ? 'inherit' : ['ignore', 'pipe', 'pipe'], detached: !attended });
    const info: CommandInfo | undefined = child.pid === undefined ? undefined : { pid: child.pid, ...(attended ? { group: false } : {}) };
    if (info) void writeJsonAtomic(runPath(runDir, 'command'), info).catch(() => undefined);
    child.stdout?.on('data', (chunk: Buffer) => { process.stdout.write(chunk); output.write(chunk); });
    child.stderr?.on('data', (chunk: Buffer) => { process.stderr.write(chunk); output.write(chunk); });
    const end = (): void => {
      if (!info) return;
      signalCommand(info, 'SIGTERM');
      setTimeout(() => signalCommand(info, 'SIGKILL'), KILL_GRACE_MS).unref();
    };
    const timer = setTimeout(() => { timedOut = true; end(); }, launch.timeoutMs);
    let closing = false;
    const watcher = attended ? setInterval(() => {
      resultStatus(attended.resultPath).then((status) => {
        if (status === null || closing) return;
        closing = true;
        // A noop run did nothing a person could ask about, so its session closes like any other.
        const keepMs = status === 'noop' ? 0 : attended.keepMs ?? 0;
        if (keepMs > 0) {
          // The pipeline goes on now; the session stays for questions until keepTab runs out.
          setTimeout(() => {
            released = true;
            const exit: ExitInfo = { exitCode: null, signal: null, timedOut: false, finishedAt: new Date().toISOString(), released: true };
            void writeJsonAtomic(runPath(runDir, 'exit'), exit).catch((error: unknown) => process.stderr.write(`operator: exit.json write failed: ${(error as Error).message}\n`));
            const kept = `\noperator: result handed over - the pipeline continues; this session stays open ${Math.round(keepMs / 60_000)} min for questions\n`;
            process.stdout.write(kept);
            output.write(kept);
            setTimeout(end, keepMs).unref();
          }, attended.graceMs).unref();
          return;
        }
        const note = `\noperator: result written - closing the session in ${Math.round(attended.graceMs / 1000)}s\n`;
        process.stdout.write(note);
        output.write(note);
        setTimeout(() => { closedAfterResult = true; end(); }, attended.graceMs).unref();
      }, (error: unknown) => process.stderr.write(`operator: result check failed: ${(error as Error).message}\n`));
    }, RESULT_POLL_MS) : undefined;
    const forward = (signal: NodeJS.Signals): void => { if (info) signalCommand(info, signal); };
    process.on('SIGTERM', forward);
    process.on('SIGHUP', forward);
    // The terminal delivers Ctrl-C to an attended command itself; the wrapper must only survive it.
    process.on('SIGINT', attended ? () => undefined : forward);
    child.on('error', (error) => {
      clearTimeout(timer);
      clearInterval(watcher);
      resolveExit({ exitCode: 127, signal: null, timedOut: false, finishedAt: new Date().toISOString(), error: error.message });
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      clearInterval(watcher);
      // Whatever the command left behind in its own group ends with it; an attended one has none.
      if (info?.group !== false && info) signalGroup(info.pid, 'SIGKILL');
      resolveExit({ exitCode: code, signal, timedOut, finishedAt: new Date().toISOString(), ...(closedAfterResult ? { closedAfterResult: true } : {}) });
    });
  });

  clearInterval(heartbeat);
  const footer = `operator: exit ${exit.exitCode ?? exit.signal}${exit.timedOut ? ' (timed out)' : ''}${exit.closedAfterResult ? ' (closed after its result)' : ''}${exit.error ? ` (${exit.error})` : ''} - the runtime collects the result and closes this tab\n`;
  process.stdout.write(footer);
  output.write(footer);
  await new Promise<void>((resolveEnd) => output.end(resolveEnd));
  // A released run was collected already; its exit.json stays the one the daemon read.
  if (!released) await writeJsonAtomic(runPath(runDir, 'exit'), exit);
  return exit.exitCode ?? 1;
}
