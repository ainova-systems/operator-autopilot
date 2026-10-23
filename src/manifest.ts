import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { CONTRACT_VERSION, type JsonObject } from './contract.ts';
import { parseCron, type CronSchedule } from './cron.ts';
import { parseDuration } from './duration.ts';
import { OperatorError } from './errors.ts';

export type Placement = 'headless' | 'herdr';
export type Engine = 'claude' | 'codex' | 'command';

export interface LimitPool { kind: 'limit'; name: string; limit: number; slotTtlMs: number; shared: boolean }
export interface WorkspaceMember { name: string; cwd: string; herdr: string }
export interface WorkspacePool { kind: 'workspaces'; name: string; members: WorkspaceMember[] }
export type PoolSpec = LimitPool | WorkspacePool;

export type TriggerSpec =
  | { kind: 'every'; index: number; intervalMs: number; run: string; subject: string; input: JsonObject }
  | { kind: 'cron'; index: number; schedule: CronSchedule; run: string; subject: string; input: JsonObject }
  | { kind: 'on'; index: number; name: string; run: string };

export interface OperationSpec {
  name: string;
  kind: 'script' | 'agent';
  engine: Engine;
  command?: string;
  skill?: string;
  agent?: string;
  prompt?: string;
  model?: string;
  args: string[];
  schema?: string;
  thread: 'per-subject' | 'none';
  pool?: string;
  placement: Placement;
  timeoutMs: number;
  retries: number;
  retryDelayMs: number;
  then?: string;
  env: Record<string, string>;
}

export interface WorkflowSpec {
  name: string;
  enabled: boolean;
  timezone: string;
  triggers: TriggerSpec[];
  operations: Map<string, OperationSpec>;
}

export interface Manifest {
  contract: typeof CONTRACT_VERSION;
  path: string;
  root: string;
  project: string;
  envFile?: string;
  envKeys?: string[];
  state: {
    provider: 'ainoflow' | 'file';
    namespace: string;
    dir?: string;
    baseUrl: string;
    require: Record<string, number>;
  };
  runtime: {
    stateDir: string;
    tickMs: number;
    pollMs: number;
    leaseTtlMs: number;
    retentionMs: { done: number; noop: number; failed: number; waiting: number };
  };
  herdr: { workspace?: string };
  pools: Map<string, PoolSpec>;
  workflows: Map<string, WorkflowSpec>;
}

export class ManifestError extends OperatorError {
  readonly problems: string[];

  constructor(path: string, problems: string[]) {
    super('INVALID_MANIFEST', `${path}: ${problems.length} problem(s)\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    this.problems = problems;
  }
}

const NAME = /^[a-z][a-z0-9-]{0,62}$/;
const ENGINES: readonly Engine[] = ['claude', 'codex', 'command'];
const DEFAULT_TIMEOUT_MS = { script: 15 * 60_000, agent: 4 * 3_600_000 };
const DAY = 86_400_000;

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function expandHome(path: string): string {
  return path === '~' || path.startsWith('~/') ? join(homedir(), path.slice(1)) : path;
}

class Reader {
  readonly problems: string[] = [];
  readonly warnings: string[] = [];

  problem(path: string, message: string): void {
    this.problems.push(`${path}: ${message}`);
  }

  string(obj: JsonObject, key: string, path: string, options: { required?: boolean; pattern?: RegExp } = {}): string | undefined {
    const value = obj[key];
    if (value === undefined) {
      if (options.required) this.problem(`${path}.${key}`, 'is required');
      return undefined;
    }
    if (typeof value !== 'string' || value === '') { this.problem(`${path}.${key}`, 'expected a non-empty string'); return undefined; }
    if (options.pattern && !options.pattern.test(value)) { this.problem(`${path}.${key}`, `${JSON.stringify(value)} must match ${options.pattern}`); return undefined; }
    return value;
  }

  duration(obj: JsonObject, key: string, path: string, fallback: number): number {
    if (obj[key] === undefined) return fallback;
    try { return parseDuration(obj[key], `${path}.${key}`); } catch (error) { this.problems.push((error as Error).message); return fallback; }
  }

  integer(obj: JsonObject, key: string, path: string, fallback: number, min: number): number {
    const value = obj[key];
    if (value === undefined) return fallback;
    if (typeof value !== 'number' || !Number.isInteger(value) || value < min) { this.problem(`${path}.${key}`, `expected an integer >= ${min}`); return fallback; }
    return value;
  }

  object(obj: JsonObject, key: string, path: string): JsonObject {
    const value = obj[key];
    if (value === undefined) return {};
    if (!isObject(value)) { this.problem(`${path}.${key}`, 'expected a mapping'); return {}; }
    return value;
  }

  unknownKeys(obj: JsonObject, allowed: readonly string[], path: string): void {
    for (const key of Object.keys(obj)) if (!allowed.includes(key)) this.problem(`${path}.${key}`, 'unknown field');
  }
}

function readPools(reader: Reader, raw: JsonObject, root: string): Map<string, PoolSpec> {
  const pools = new Map<string, PoolSpec>();
  for (const [name, value] of Object.entries(raw)) {
    const path = `pools.${name}`;
    if (!NAME.test(name)) { reader.problem(path, 'pool names are lower-case letters, digits and dashes'); continue; }
    if (!isObject(value)) { reader.problem(path, 'expected a mapping'); continue; }
    reader.unknownKeys(value, ['limit', 'slotTtl', 'shared', 'workspaces'], path);
    const hasLimit = value['limit'] !== undefined;
    const hasWorkspaces = value['workspaces'] !== undefined;
    if (hasLimit === hasWorkspaces) { reader.problem(path, 'set exactly one of limit or workspaces'); continue; }
    if (hasLimit) {
      const limit = reader.integer(value, 'limit', path, 1, 1);
      const slotTtlMs = reader.duration(value, 'slotTtl', path, 4 * 3_600_000);
      if (slotTtlMs > DAY) reader.problem(`${path}.slotTtl`, 'Guard slot leases cannot exceed 24h');
      if (value['shared'] !== undefined && typeof value['shared'] !== 'boolean') reader.problem(`${path}.shared`, 'expected true or false');
      pools.set(name, { kind: 'limit', name, limit, slotTtlMs, shared: value['shared'] === true });
      continue;
    }
    const rawMembers = value['workspaces'];
    const members: WorkspaceMember[] = [];
    const entries: [string, unknown][] = Array.isArray(rawMembers) ? rawMembers.map((member) => [String(member), {}]) : isObject(rawMembers) ? Object.entries(rawMembers) : [];
    if (entries.length === 0) reader.problem(`${path}.workspaces`, 'expected a non-empty list or mapping of workspace names');
    for (const [member, spec] of entries) {
      const memberPath = `${path}.workspaces.${member}`;
      if (!NAME.test(member)) { reader.problem(memberPath, 'workspace names are lower-case letters, digits and dashes'); continue; }
      const memberSpec = isObject(spec) ? spec : {};
      if (spec !== null && spec !== undefined && !isObject(spec)) reader.problem(memberPath, 'expected a mapping with cwd and herdr');
      reader.unknownKeys(memberSpec, ['cwd', 'herdr'], memberPath);
      const cwd = reader.string(memberSpec, 'cwd', memberPath);
      const herdr = reader.string(memberSpec, 'herdr', memberPath);
      members.push({ name: member, cwd: cwd === undefined ? root : resolve(root, expandHome(cwd)), herdr: herdr ?? member });
    }
    pools.set(name, { kind: 'workspaces', name, members });
  }
  return pools;
}

function readOperation(reader: Reader, name: string, value: unknown, path: string): OperationSpec | undefined {
  if (!NAME.test(name)) { reader.problem(path, 'operation names are lower-case letters, digits and dashes'); return undefined; }
  if (!isObject(value)) { reader.problem(path, 'expected a mapping'); return undefined; }
  reader.unknownKeys(value, ['kind', 'engine', 'command', 'skill', 'agent', 'prompt', 'model', 'args', 'schema', 'thread', 'pool', 'placement', 'timeout', 'retries', 'retryDelay', 'then', 'env'], path);
  const kind = value['kind'];
  if (kind !== 'script' && kind !== 'agent') { reader.problem(`${path}.kind`, 'expected script or agent'); return undefined; }
  const engineValue = value['engine'] ?? (kind === 'script' ? 'command' : undefined);
  if (typeof engineValue !== 'string' || !ENGINES.includes(engineValue as Engine)) { reader.problem(`${path}.engine`, `expected one of ${ENGINES.join(', ')}`); return undefined; }
  const engine = engineValue as Engine;
  if (kind === 'script' && engine !== 'command') reader.problem(`${path}.engine`, 'a script runs its command; engines are for agents');

  const command = reader.string(value, 'command', path, { required: engine === 'command' });
  const skill = reader.string(value, 'skill', path);
  const agent = reader.string(value, 'agent', path);
  const prompt = reader.string(value, 'prompt', path);
  const model = reader.string(value, 'model', path);
  const schema = reader.string(value, 'schema', path);
  const pool = reader.string(value, 'pool', path);
  const then = reader.string(value, 'then', path);
  if (engine === 'claude' && !skill && !prompt) reader.problem(path, 'a claude operation needs skill or prompt');
  if (engine === 'codex' && !agent && !prompt) reader.problem(path, 'a codex operation needs agent or prompt');
  if (engine !== 'codex' && (schema || value['thread'] !== undefined)) reader.problem(path, 'schema and thread apply to codex operations only');
  if (then && !(engine === 'codex' && schema)) reader.problem(`${path}.then`, 'then is for codex schema operations, which cannot write a result file; other operations request next themselves');

  const args = value['args'] ?? [];
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string')) reader.problem(`${path}.args`, 'expected a list of strings');
  const thread = value['thread'] ?? 'none';
  if (thread !== 'per-subject' && thread !== 'none') reader.problem(`${path}.thread`, 'expected per-subject or none');
  const placement = value['placement'] ?? 'headless';
  if (placement !== 'headless' && placement !== 'herdr') reader.problem(`${path}.placement`, 'expected headless or herdr');
  const env = reader.object(value, 'env', path);
  for (const [key, envValue] of Object.entries(env)) if (typeof envValue !== 'string') reader.problem(`${path}.env.${key}`, 'expected a string');

  return {
    name,
    kind,
    engine,
    args: Array.isArray(args) ? args.map(String) : [],
    thread: thread === 'per-subject' ? 'per-subject' : 'none',
    placement: placement === 'herdr' ? 'herdr' : 'headless',
    timeoutMs: reader.duration(value, 'timeout', path, DEFAULT_TIMEOUT_MS[kind]),
    retries: reader.integer(value, 'retries', path, 0, 0),
    retryDelayMs: reader.duration(value, 'retryDelay', path, 60_000),
    env: env as Record<string, string>,
    ...(command ? { command } : {}),
    ...(skill ? { skill } : {}),
    ...(agent ? { agent } : {}),
    ...(prompt ? { prompt } : {}),
    ...(model ? { model } : {}),
    ...(schema ? { schema } : {}),
    ...(pool ? { pool } : {}),
    ...(then ? { then } : {}),
  };
}

function readWorkflow(reader: Reader, name: string, value: unknown, pools: Map<string, PoolSpec>): WorkflowSpec | undefined {
  const path = `workflows.${name}`;
  if (!NAME.test(name)) { reader.problem(path, 'workflow names are lower-case letters, digits and dashes'); return undefined; }
  if (!isObject(value)) { reader.problem(path, 'expected a mapping'); return undefined; }
  reader.unknownKeys(value, ['enabled', 'timezone', 'triggers', 'operations'], path);
  if (value['enabled'] !== undefined && typeof value['enabled'] !== 'boolean') reader.problem(`${path}.enabled`, 'expected true or false');
  const enabled = value['enabled'] !== false;
  const timezone = reader.string(value, 'timezone', path) ?? 'UTC';
  try { new Intl.DateTimeFormat('en-US', { timeZone: timezone }); } catch { reader.problem(`${path}.timezone`, `unknown time zone ${JSON.stringify(timezone)}`); }

  const operations = new Map<string, OperationSpec>();
  for (const [opName, opValue] of Object.entries(reader.object(value, 'operations', path))) {
    const op = readOperation(reader, opName, opValue, `${path}.operations.${opName}`);
    if (op) operations.set(opName, op);
  }
  // A disabled workflow is a sketch: its dangling references are reported as warnings, not errors.
  const reference = (where: string, message: string): void => {
    if (enabled) reader.problem(where, message); else reader.warnings.push(`${where}: ${message} (workflow disabled)`);
  };
  for (const op of operations.values()) {
    const opPath = `${path}.operations.${op.name}`;
    if (op.pool && !pools.has(op.pool)) reference(`${opPath}.pool`, `unknown pool ${JSON.stringify(op.pool)}`);
    if (op.then && !operations.has(op.then)) reference(`${opPath}.then`, `unknown operation ${JSON.stringify(op.then)}`);
    const pool = op.pool ? pools.get(op.pool) : undefined;
    // Guard slots cannot be renewed: the run must end (the wrapper kills it at its timeout) before its slot expires.
    if (pool?.kind === 'limit' && op.timeoutMs > pool.slotTtlMs) {
      reference(`${opPath}.timeout`, `${op.timeoutMs / 1000}s exceeds pool ${pool.name} slotTtl ${pool.slotTtlMs / 1000}s; a run could outlive its slot`);
    }
  }

  const triggers: TriggerSpec[] = [];
  const rawTriggers = value['triggers'] ?? [];
  if (!Array.isArray(rawTriggers)) reader.problem(`${path}.triggers`, 'expected a list');
  else rawTriggers.forEach((trigger: unknown, index: number) => {
    const triggerPath = `${path}.triggers[${index}]`;
    if (!isObject(trigger)) { reader.problem(triggerPath, 'expected a mapping'); return; }
    reader.unknownKeys(trigger, ['every', 'cron', 'on', 'run', 'subject', 'input'], triggerPath);
    const kinds = ['every', 'cron', 'on'].filter((key) => trigger[key] !== undefined);
    if (kinds.length !== 1) { reader.problem(triggerPath, 'set exactly one of every, cron or on'); return; }
    const run = reader.string(trigger, 'run', triggerPath, { required: true });
    if (!run) return;
    if (!operations.has(run)) reference(`${triggerPath}.run`, `unknown operation ${JSON.stringify(run)}`);
    const subject = typeof trigger['subject'] === 'string' ? trigger['subject'] : '';
    const input = reader.object(trigger, 'input', triggerPath);
    if (trigger['every'] !== undefined) {
      triggers.push({ kind: 'every', index, intervalMs: reader.duration(trigger, 'every', triggerPath, 300_000), run, subject, input });
    } else if (trigger['cron'] !== undefined) {
      const expression = reader.string(trigger, 'cron', triggerPath);
      if (!expression) return;
      try { triggers.push({ kind: 'cron', index, schedule: parseCron(expression, timezone), run, subject, input }); } catch (error) { reader.problem(`${triggerPath}.cron`, (error as Error).message); }
    } else {
      const on = reader.string(trigger, 'on', triggerPath, { pattern: NAME });
      if (on) triggers.push({ kind: 'on', index, name: on, run });
    }
  });
  return { name, enabled, timezone, triggers, operations };
}

export interface LoadedManifest { manifest: Manifest; warnings: string[] }

/** Reads and validates a manifest. Every problem is reported at once, each with its field path. */
export function parseManifest(text: string, path: string): LoadedManifest {
  const reader = new Reader();
  let raw: unknown;
  try { raw = parseYaml(text); } catch (error) { throw new ManifestError(path, [`not valid YAML: ${(error as Error).message}`]); }
  if (!isObject(raw)) throw new ManifestError(path, ['expected a YAML mapping at the top level']);
  const root = dirname(resolve(path));
  reader.unknownKeys(raw, ['contract', 'project', 'envFile', 'envKeys', 'state', 'runtime', 'herdr', 'pools', 'workflows'], 'manifest');
  if (raw['contract'] !== CONTRACT_VERSION) reader.problem('contract', `this runtime speaks contract ${CONTRACT_VERSION}, the manifest says ${JSON.stringify(raw['contract'])}`);
  const project = reader.string(raw, 'project', 'manifest', { required: true, pattern: NAME }) ?? 'invalid';
  // OPERATOR_ENV_FILE / OPERATOR_ENV_KEYS supply the env file when the manifest names none, so a
  // host can point at its own secrets without committing a machine path.
  const envFile = reader.string(raw, 'envFile', 'manifest') ?? process.env['OPERATOR_ENV_FILE'];
  const envKeys = raw['envKeys'] ?? process.env['OPERATOR_ENV_KEYS']?.split(',').map((key) => key.trim()).filter(Boolean);
  if (envKeys !== undefined && (!Array.isArray(envKeys) || envKeys.some((key) => typeof key !== 'string'))) reader.problem('envKeys', 'expected a list of variable names');

  const stateRaw = reader.object(raw, 'state', 'manifest');
  reader.unknownKeys(stateRaw, ['provider', 'namespace', 'dir', 'baseUrl', 'require'], 'state');
  const provider = stateRaw['provider'] ?? 'ainoflow';
  if (provider !== 'ainoflow' && provider !== 'file') reader.problem('state.provider', 'expected ainoflow or file');
  const dir = reader.string(stateRaw, 'dir', 'state', { required: provider === 'file' });
  const requireRaw = reader.object(stateRaw, 'require', 'state');
  const require: Record<string, number> = {};
  for (const [key, value] of Object.entries(requireRaw)) {
    if (typeof value !== 'number' || value < 0) reader.problem(`state.require.${key}`, 'expected a number >= 0'); else require[key] = value;
  }

  const runtimeRaw = reader.object(raw, 'runtime', 'manifest');
  reader.unknownKeys(runtimeRaw, ['stateDir', 'tick', 'poll', 'leaseTtl', 'retention'], 'runtime');
  const retentionRaw = reader.object(runtimeRaw, 'retention', 'runtime');
  reader.unknownKeys(retentionRaw, ['done', 'noop', 'failed', 'waiting'], 'runtime.retention');
  const stateDir = reader.string(runtimeRaw, 'stateDir', 'runtime');
  const stateHome = process.env['XDG_STATE_HOME'] ?? join(homedir(), '.local', 'state');

  const herdrRaw = reader.object(raw, 'herdr', 'manifest');
  reader.unknownKeys(herdrRaw, ['workspace'], 'herdr');
  const herdrWorkspace = reader.string(herdrRaw, 'workspace', 'herdr');

  const pools = readPools(reader, reader.object(raw, 'pools', 'manifest'), root);
  const workflows = new Map<string, WorkflowSpec>();
  for (const [name, value] of Object.entries(reader.object(raw, 'workflows', 'manifest'))) {
    const workflow = readWorkflow(reader, name, value, pools);
    if (workflow) workflows.set(name, workflow);
  }
  if (workflows.size === 0) reader.problem('workflows', 'define at least one workflow');

  const namespace = reader.string(stateRaw, 'namespace', 'state', { pattern: /^[a-z][a-z0-9-]{0,62}$/ }) ?? `op-${project}`;
  const manifest: Manifest = {
    contract: CONTRACT_VERSION,
    path: resolve(path),
    root,
    project,
    ...(envFile ? { envFile: resolve(root, expandHome(envFile)) } : {}),
    ...(Array.isArray(envKeys) ? { envKeys: envKeys.map(String) } : {}),
    state: {
      provider: provider === 'file' ? 'file' : 'ainoflow',
      namespace,
      baseUrl: reader.string(stateRaw, 'baseUrl', 'state') ?? 'https://api.ainoflow.io',
      require,
      ...(dir ? { dir: resolve(root, expandHome(dir)) } : {}),
    },
    runtime: {
      stateDir: stateDir ? resolve(root, expandHome(stateDir)) : join(stateHome, 'operator', project),
      tickMs: reader.duration(runtimeRaw, 'tick', 'runtime', 5_000),
      pollMs: reader.duration(runtimeRaw, 'poll', 'runtime', 10_000),
      leaseTtlMs: reader.duration(runtimeRaw, 'leaseTtl', 'runtime', 120_000),
      retentionMs: {
        done: reader.duration(retentionRaw, 'done', 'runtime.retention', 14 * DAY),
        noop: reader.duration(retentionRaw, 'noop', 'runtime.retention', DAY),
        failed: reader.duration(retentionRaw, 'failed', 'runtime.retention', 30 * DAY),
        waiting: reader.duration(retentionRaw, 'waiting', 'runtime.retention', 30 * DAY),
      },
    },
    herdr: herdrWorkspace ? { workspace: herdrWorkspace } : {},
    pools,
    workflows,
  };
  // Checked last, so a bad runtime or state value is reported instead of silently defaulted.
  if (reader.problems.length > 0) throw new ManifestError(path, reader.problems);
  return { manifest, warnings: reader.warnings };
}

export function loadManifest(path: string): LoadedManifest {
  let text: string;
  try { text = readFileSync(path, 'utf8'); } catch (error) { throw new OperatorError('MANIFEST_NOT_FOUND', `cannot read manifest ${path}`, { cause: error }); }
  return parseManifest(text, path);
}

/** Resolves the manifest path from an explicit flag, OPERATOR_MANIFEST, or ./orchestrator.yaml. */
export function manifestPath(flag: string | undefined): string {
  const path = flag ?? process.env['OPERATOR_MANIFEST'] ?? 'orchestrator.yaml';
  return isAbsolute(path) ? path : resolve(process.cwd(), path);
}
