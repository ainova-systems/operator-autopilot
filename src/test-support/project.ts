import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { Daemon } from '../daemon.ts';
import type { Herdr } from '../herdr.ts';
import type { JobRecord } from '../jobs.ts';
import { createLogger, type Logger } from '../log.ts';
import { parseManifest, type Manifest } from '../manifest.ts';
import { createFileBackend } from '../state/file.ts';
import type { StateBackend } from '../state/types.ts';

export const FIXTURE = fileURLToPath(new URL('../../fixtures/demo', import.meta.url));

/** A herdr that is not there: every herdr placement degrades to headless. */
export const absentHerdr: Herdr = {
  available: async () => false,
  findWorkspace: async () => undefined,
  createTab: async () => { throw new Error('no herdr'); },
  runInPane: async () => { throw new Error('no herdr'); },
  setTitle: async () => undefined,
  closeTab: async () => 'gone',
  paneExists: async () => false,
  agentStatus: async () => undefined,
  notify: async () => undefined,
};

export interface TestProject {
  root: string;
  data: string;
  manifest: Manifest;
  backend: StateBackend;
  lines: string[];
  log: Logger;
  daemon(options?: { dryRun?: boolean; herdr?: Herdr; backend?: StateBackend }): Daemon;
  drop(name: string, content?: string): Promise<void>;
  launches(): Promise<string[]>;
  cleanup(): Promise<void>;
}

/**
 * Copies the demo fixture into a temporary directory with a file state backend and a fast poll.
 * `extra` is appended to the demo workflow's operations block.
 */
export async function createTestProject(options: { extraOperations?: string; pools?: string } = {}): Promise<TestProject> {
  const root = await mkdtemp(join(tmpdir(), 'operator-test-'));
  await cp(FIXTURE, root, { recursive: true, filter: (source) => !source.includes(`${join('demo', 'data')}`) || source.endsWith('data') });
  const data = join(root, 'data');
  await mkdir(join(data, 'inbox'), { recursive: true });
  const text = (await readFile(join(FIXTURE, 'operator.yaml'), 'utf8'))
    .replace(/state:\n {2}provider: ainoflow\n {2}namespace: op-demo/, `state:\n  provider: file\n  dir: ${join(root, '.state')}`)
    .replace(/runtime:\n {2}tick: 2s\n {2}poll: 2s\n {2}leaseTtl: 60s/, `runtime:\n  stateDir: ${join(root, '.runtime')}\n  tick: 100ms\n  poll: 100ms\n  leaseTtl: 6s`)
    .replace('  checks: { limit: 1, slotTtl: 30m }', `  checks: { limit: 1, slotTtl: 30m }\n${options.pools ?? ''}`)
    .replace(/      answered: \{[^\n]*\}/, (line) => `${line}\n${options.extraOperations ?? ''}`);
  const manifestPath = join(root, 'operator.yaml');
  await writeFile(manifestPath, text);
  const { manifest } = parseManifest(text, manifestPath);
  const backend = createFileBackend(join(root, '.state'), manifest.state.namespace);
  const lines: string[] = [];
  const log = createLogger({ level: 'debug', write: (line) => { lines.push(line); } });
  return {
    root,
    data,
    manifest,
    backend,
    lines,
    log,
    daemon: (daemonOptions = {}) => new Daemon({ manifest, backend, log, herdr: absentHerdr, ...daemonOptions }),
    drop: async (name, content = '1') => { await writeFile(join(data, 'inbox', name), content); },
    launches: async () => {
      try { return (await readFile(join(data, 'launches.log'), 'utf8')).trim().split('\n').filter(Boolean); } catch { return []; }
    },
    cleanup: async () => { await rm(root, { recursive: true, force: true }); },
  };
}

/** Polls the daemon until `done` holds, failing after `timeoutMs`. */
export async function pollUntil(daemon: Daemon, done: () => Promise<boolean>, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await daemon.poll();
    if (await done()) return;
    await sleep(100);
  }
  throw new Error(`condition not reached within ${timeoutMs}ms`);
}

export async function jobsBy(daemon: Daemon, operation: string, subject?: string): Promise<JobRecord[]> {
  return (await daemon.jobs.list()).filter((job) => job.operation === operation && (subject === undefined || job.subject === subject));
}

export async function listDir(path: string): Promise<string[]> {
  try { return (await readdir(path)).sort(); } catch { return []; }
}
