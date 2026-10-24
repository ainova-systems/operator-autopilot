import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { OperatorError } from './errors.ts';

const run = promisify(execFile);

export type HerdrExec = (args: string[]) => Promise<string>;

export interface HerdrTab { tabId: string; paneId: string; workspaceId: string }

/** The few herdr CLI calls the runtime makes. It only ever touches tabs it created itself. */
export interface Herdr {
  available(): Promise<boolean>;
  findWorkspace(labelOrId: string): Promise<string | undefined>;
  createTab(workspaceId: string, cwd: string, label: string): Promise<HerdrTab>;
  runInPane(paneId: string, command: string): Promise<void>;
  setTitle(paneId: string, title: string): Promise<void>;
  /** `gone` when the tab was already closed, for example by hand. */
  closeTab(tabId: string): Promise<'closed' | 'gone'>;
  agentStatus(paneId: string): Promise<string | undefined>;
  notify(title: string, body: string): Promise<void>;
}

/** herdr refused a call and named the reason, for example `tab_not_found`. */
export class HerdrRefusal extends OperatorError {
  readonly reason: string;

  constructor(reason: string, message: string) {
    super('HERDR_REFUSED', message);
    this.reason = reason;
  }
}

/** Reads the reason a failed herdr call prints as JSON on stderr, so "already gone" differs from "not reachable". */
export function herdrRefusal(error: unknown): HerdrRefusal | undefined {
  const stderr = (error as { stderr?: unknown } | undefined)?.stderr;
  if (typeof stderr !== 'string') return undefined;
  let parsed: { error?: { code?: unknown; message?: unknown } };
  try {
    parsed = JSON.parse(stderr) as typeof parsed;
  } catch {
    // Not herdr's JSON answer: the caller rethrows the original failure unchanged.
    return undefined;
  }
  const reason = parsed.error?.code;
  if (typeof reason !== 'string') return undefined;
  return new HerdrRefusal(reason, typeof parsed.error?.message === 'string' ? parsed.error.message : reason);
}

export const defaultHerdrExec: HerdrExec = async (args) => {
  try {
    const { stdout } = await run('herdr', args, { timeout: 15_000, maxBuffer: 4 * 1024 * 1024 });
    return stdout;
  } catch (error) {
    throw herdrRefusal(error) ?? error;
  }
};

function result(stdout: string, command: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(stdout) as { result?: Record<string, unknown> };
    if (parsed.result) return parsed.result;
  } catch (error) {
    throw new OperatorError('HERDR_PROTOCOL', `herdr ${command} printed something that is not JSON`, { cause: error });
  }
  throw new OperatorError('HERDR_PROTOCOL', `herdr ${command} answered without a result`);
}

export function createHerdr(exec: HerdrExec = defaultHerdrExec): Herdr {
  return {
    async available(): Promise<boolean> {
      try { await exec(['workspace', 'list']); return true; } catch { return false; }
    },
    async findWorkspace(labelOrId: string): Promise<string | undefined> {
      const list = result(await exec(['workspace', 'list']), 'workspace list');
      const workspaces = (list['workspaces'] ?? []) as { workspace_id: string; label?: string }[];
      return workspaces.find((w) => w.workspace_id === labelOrId || w.label === labelOrId)?.workspace_id;
    },
    async createTab(workspaceId: string, cwd: string, label: string): Promise<HerdrTab> {
      const created = result(await exec(['tab', 'create', '--workspace', workspaceId, '--cwd', cwd, '--label', label, '--no-focus']), 'tab create');
      const pane = created['root_pane'] as { pane_id?: string; tab_id?: string } | undefined;
      if (!pane?.pane_id || !pane.tab_id) throw new OperatorError('HERDR_PROTOCOL', 'herdr tab create returned no pane');
      return { tabId: pane.tab_id, paneId: pane.pane_id, workspaceId };
    },
    async runInPane(paneId: string, command: string): Promise<void> {
      await exec(['pane', 'run', paneId, command]);
    },
    async setTitle(paneId: string, title: string): Promise<void> {
      // herdr reads the pane id only before the options here.
      await exec(['pane', 'report-metadata', paneId, '--source', 'operator', '--title', title]);
    },
    async closeTab(tabId: string): Promise<'closed' | 'gone'> {
      try {
        await exec(['tab', 'close', tabId]);
        return 'closed';
      } catch (error) {
        if (error instanceof HerdrRefusal && error.reason === 'tab_not_found') return 'gone';
        throw error;
      }
    },
    async agentStatus(paneId: string): Promise<string | undefined> {
      const info = result(await exec(['pane', 'get', paneId]), 'pane get');
      return (info['pane'] as { agent_status?: string } | undefined)?.agent_status;
    },
    async notify(title: string, body: string): Promise<void> {
      await exec(['notification', 'show', title, '--body', body, '--sound', 'request']);
    },
  };
}

/** Quotes one argument for the POSIX shell a herdr pane runs. */
export function shellQuote(value: string): string {
  return /^[A-Za-z0-9_./:=@%+-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
}
