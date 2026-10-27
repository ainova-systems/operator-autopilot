import { randomBytes } from 'node:crypto';
import { readFile, rename, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** What the job wrapper needs to execute one run; written by the daemon, read by `job-exec`. */
export interface LaunchSpec {
  jobId: string;
  attempt: number;
  title: string;
  argv: string[];
  cwd: string;
  env: Record<string, string>;
  envFile?: string;
  envKeys?: string[];
  timeoutMs: number;
  /**
   * An interactive run: the command owns the terminal, and the wrapper ends it `graceMs` after
   * a result file appears at `resultPath`.
   */
  attended?: { resultPath: string; graceMs: number };
}

export interface WrapperInfo { pid: number; host: string; startedAt: string }
/** `group: false` when the command shares the wrapper's process group, as an attended session does. */
export interface CommandInfo { pid: number; group?: boolean }
/** `closedAfterResult`: the wrapper ended an attended session because its result file was written. */
export interface ExitInfo { exitCode: number | null; signal: string | null; timedOut: boolean; finishedAt: string; error?: string; closedAfterResult?: boolean }

export const RUN_FILES = {
  launch: 'launch.json',
  input: 'input.json',
  result: 'result.json',
  wrapper: 'wrapper.json',
  command: 'command.json',
  heartbeat: 'heartbeat',
  exit: 'exit.json',
  output: 'output.log',
} as const;

export function runPath(runDir: string, file: keyof typeof RUN_FILES): string {
  return join(runDir, RUN_FILES[file]);
}

export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const temp = `${path}.${randomBytes(4).toString('hex')}.tmp`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`);
  await rename(temp, path);
}

export async function readJsonFile<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

export async function ageMs(path: string): Promise<number | undefined> {
  try {
    return Date.now() - (await stat(path)).mtimeMs;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}
