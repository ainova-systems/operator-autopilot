#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { isMemberName, type JsonObject } from './contract.ts';
import { Daemon } from './daemon.ts';
import { loadEnvFile } from './env.ts';
import { OperatorError } from './errors.ts';
import { createHerdr } from './herdr.ts';
import { runJobExec } from './job-exec.ts';
import { enqueue, JobStore, type JobStatus } from './jobs.ts';
import { createLogger, errorText, type LogLevel } from './log.ts';
import { loadManifest, manifestPath, type Manifest } from './manifest.ts';
import { capabilityProblems, checkCapabilities, openState } from './state/open.ts';
import type { StateBackend } from './state/types.ts';
import { fireTrigger } from './triggers.ts';
import { validateProject } from './validate.ts';
import { WaitStore } from './waits.ts';

const VERSION = (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version;
const RESERVED_COLLECTIONS = new Set(['jobs', 'waits', 'threads', 'deliveries', 'tabs']);

const HELP = `operator ${VERSION} - runs a project's workflow operations on timers and triggers

Usage: operator <command> [options]

Commands:
  validate                         Check the manifest, its scripts, skills, schemas and the state backend
  run                              Run the daemon (one active daemon per project)
  trigger <workflow> <name>        Deliver a named trigger: resume a matching wait, or start the "on:" operation
  enqueue <workflow> <operation>   Queue one operation by hand
  jobs                             List jobs (newest last)
  job <id>                         Show one job record
  waits                            List open waits
  state <get|put|list|delete> <collection> [key]
                                   Project state for scripts and skills (reserved: jobs, waits, threads, deliveries, tabs)
  job-exec <run-dir>               Internal: the job wrapper the daemon starts

Options:
  --manifest <path>     Manifest file (default: $OPERATOR_MANIFEST or ./operator.yaml)
  --subject <s>         Subject key for trigger/enqueue (opaque to the runtime)
  --input <json>        Input pointers as a JSON object
  --key <k>             Wait key a trigger answers (e.g. a question id)
  --id <id>             Trigger id; the same id twice is one job
  --member <m>          enqueue: the workspace member the job runs in
  --status <s>          jobs: only this status
  --dry-run             run: start scripts, never agents, on a separate file state
  --describe            validate: run each script with --describe
  --offline             validate: do not contact the state backend
  --allow-file-state    run: accept state.provider file (tests only)
  --if-match <etag>     state put: write only if unchanged
  --prefix <p>          state list: key prefix
  --where <k=v>         state list: top-level equality filter (repeatable)
  --json                Machine-readable output
  --log-level <level>   debug, info, warn or error (default info)
  -h, --help            This help
  -v, --version         Print the version
`;

const options = {
  manifest: { type: 'string' },
  subject: { type: 'string' },
  input: { type: 'string' },
  key: { type: 'string' },
  id: { type: 'string' },
  member: { type: 'string' },
  status: { type: 'string' },
  'dry-run': { type: 'boolean' },
  describe: { type: 'boolean' },
  offline: { type: 'boolean' },
  'allow-file-state': { type: 'boolean' },
  'if-match': { type: 'string' },
  prefix: { type: 'string' },
  where: { type: 'string', multiple: true },
  json: { type: 'boolean' },
  'log-level': { type: 'string' },
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean', short: 'v' },
} as const;

type Values = ReturnType<typeof parseArgs<{ options: typeof options; allowPositionals: true }>>['values'];

class UsageError extends OperatorError {
  constructor(message: string) {
    super('USAGE', message);
  }
}

function parseInput(text: string | undefined): JsonObject {
  if (text === undefined) return {};
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { throw new UsageError('--input must be a JSON object'); }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new UsageError('--input must be a JSON object');
  return parsed as JsonObject;
}

function load(values: Values): Manifest {
  const { manifest, warnings } = loadManifest(manifestPath(values.manifest));
  for (const warning of warnings) process.stderr.write(`warning: ${warning}\n`);
  if (manifest.envFile) loadEnvFile(manifest.envFile, manifest.envKeys);
  return manifest;
}

function print(values: Values, data: unknown, text: () => string): void {
  process.stdout.write(values.json ? `${JSON.stringify(data, null, 2)}\n` : `${text()}\n`);
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

async function commandValidate(values: Values): Promise<number> {
  const { manifest, warnings } = loadManifest(manifestPath(values.manifest));
  if (manifest.envFile) loadEnvFile(manifest.envFile, manifest.envKeys);
  let stateProblems: string[] | undefined;
  if (!values.offline) {
    try {
      const backend = openState(manifest, { allowFileState: true });
      stateProblems = capabilityProblems(manifest, await backend.capabilities());
    } catch (error) {
      stateProblems = [errorText(error)];
    }
  }
  const report = await validateProject(manifest, warnings, { herdr: createHerdr(), describe: values.describe === true, ...(stateProblems ? { stateProblems } : {}) });
  const operations = [...manifest.workflows.values()].reduce((sum, workflow) => sum + workflow.operations.size, 0);
  print(values, { manifest: manifest.path, ...report }, () => [
    ...report.warnings.map((warning) => `warning: ${warning}`),
    ...report.problems.map((problem) => `problem: ${problem}`),
    report.problems.length === 0
      ? `ok: ${manifest.path} - project ${manifest.project}, ${manifest.workflows.size} workflow(s), ${operations} operation(s), ${manifest.pools.size} pool(s)${values.offline ? ', state not checked' : `, state ${manifest.state.provider} ready`}`
      : `${report.problems.length} problem(s) in ${manifest.path}`,
  ].join('\n'));
  return report.problems.length === 0 ? 0 : 1;
}

async function commandRun(values: Values): Promise<number> {
  const level = (values['log-level'] ?? 'info') as LogLevel;
  if (!['debug', 'info', 'warn', 'error'].includes(level)) throw new UsageError('--log-level must be debug, info, warn or error');
  let manifest = load(values);
  const log = createLogger({ level, fields: { project: manifest.project } });
  const dryRun = values['dry-run'] === true;
  let backend: StateBackend;
  if (dryRun) {
    const stateDir = join(manifest.runtime.stateDir, 'dry-run');
    manifest = { ...manifest, runtime: { ...manifest.runtime, stateDir } };
    backend = openState(manifest, { fileStateDir: join(stateDir, 'state') });
    log.info('dry run: scripts run, agents are only logged, state is a local file store', { stateDir });
  } else {
    backend = openState(manifest, { allowFileState: values['allow-file-state'] === true || process.env['OPERATOR_ALLOW_FILE_STATE'] === '1' });
    await checkCapabilities(manifest, backend);
  }
  const daemon = new Daemon({ manifest, backend, log, herdr: createHerdr(), dryRun });
  const stop = (signal: string): void => { log.info('stopping', { signal }); daemon.stop(); };
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));
  await daemon.run();
  return 0;
}

function openForCommand(manifest: Manifest): StateBackend {
  return openState(manifest, { allowFileState: true });
}

async function commandTrigger(values: Values, positionals: string[]): Promise<number> {
  const [workflow, name] = positionals;
  if (!workflow || !name) throw new UsageError('usage: operator trigger <workflow> <name> [--subject s] [--input json] [--key k] [--id id]');
  const manifest = load(values);
  const backend = openForCommand(manifest);
  const result = await fireTrigger(manifest, new JobStore(backend.docs, manifest.runtime.retentionMs), new WaitStore(backend.docs), {
    workflow,
    name,
    subject: values.subject ?? '',
    input: parseInput(values.input),
    ...(values.key ? { key: values.key } : {}),
    ...(values.id ? { id: values.id } : {}),
  });
  print(values, result, () => [
    ...result.resumed.map((r) => (result.duplicate ? `duplicate, dropped: wait ${r.waitId} was already resumed as job ${r.jobId}` : `resumed wait ${r.waitId} -> job ${r.jobId}${r.created ? '' : ' (already queued)'}`)),
    ...(result.started ? [`${result.started.created && !result.duplicate ? 'queued' : 'duplicate, dropped:'} job ${result.started.jobId}`] : []),
  ].join('\n'));
  return 0;
}

async function commandEnqueue(values: Values, positionals: string[]): Promise<number> {
  const [workflow, operation] = positionals;
  if (!workflow || !operation) throw new UsageError('usage: operator enqueue <workflow> <operation> [--subject s] [--input json] [--id id] [--member m]');
  if (values.member !== undefined && !isMemberName(values.member)) throw new UsageError(`--member expects a workspace member name, got ${JSON.stringify(values.member)}`);
  const manifest = load(values);
  if (!manifest.workflows.get(workflow)?.operations.has(operation)) throw new OperatorError('UNKNOWN_OPERATION', `workflow ${workflow} has no operation ${operation}`);
  const backend = openForCommand(manifest);
  const result = await enqueue(new JobStore(backend.docs, manifest.runtime.retentionMs), {
    project: manifest.project,
    workflow,
    operation,
    subject: values.subject ?? '',
    input: parseInput(values.input),
    trigger: { id: values.id ?? `manual:${new Date().toISOString()}`, name: 'enqueue', kind: 'manual' },
    ...(values.member ? { member: values.member } : {}),
  });
  print(values, result, () => `${result.created ? 'queued' : 'duplicate, dropped:'} job ${result.id}`);
  return 0;
}

async function commandJobs(values: Values, positionals: string[], single: boolean): Promise<number> {
  const manifest = load(values);
  const store = new JobStore(openForCommand(manifest).docs, manifest.runtime.retentionMs);
  if (single) {
    const id = positionals[0];
    if (!id) throw new UsageError('usage: operator job <id>');
    const job = await store.get(id);
    if (!job) throw new OperatorError('NOT_FOUND', `no job ${id}`);
    process.stdout.write(`${JSON.stringify(job, null, 2)}\n`);
    return 0;
  }
  const jobs = await store.list(values.status as JobStatus | undefined);
  print(values, jobs, () => jobs.map((job) => [
    job.updatedAt.slice(0, 19), job.id, job.status.padEnd(11), `${job.workflow}/${job.operation}`, job.subject || '-', `a${job.attempt}`,
    job.waitingFor ?? job.outcome?.failure?.reason ?? job.outcome?.message ?? '',
  ].join('  ')).join('\n') || 'no jobs');
  return 0;
}

async function commandWaits(values: Values): Promise<number> {
  const manifest = load(values);
  const waits = await new WaitStore(openForCommand(manifest).docs).listOpen();
  print(values, waits, () => waits.map((w) => `${w.id}  ${w.workflow}  on ${w.on}${w.key ? `:${w.key}` : ''}  subject ${w.subject || '-'}  resumes ${w.resume}  since ${w.createdAt}`).join('\n') || 'no open waits');
  return 0;
}

async function commandState(values: Values, positionals: string[]): Promise<number> {
  const [action, collection, key] = positionals;
  if (!action || !collection) throw new UsageError('usage: operator state <get|put|list|delete> <collection> [key]');
  if (!/^[a-z][a-z0-9-]{0,40}$/.test(collection)) throw new UsageError('collection names are lower-case letters, digits and dashes');
  const manifest = load(values);
  const docs = openForCommand(manifest).docs;
  const needKey = (): string => { if (!key) throw new UsageError(`state ${action} needs a key`); return key; };
  const writable = (): void => { if (RESERVED_COLLECTIONS.has(collection)) throw new UsageError(`collection ${collection} belongs to the runtime and is read-only here`); };
  switch (action) {
    case 'get': {
      const doc = await docs.get(collection, needKey());
      if (!doc) throw new OperatorError('NOT_FOUND', `no ${collection}/${key}`);
      process.stdout.write(`${JSON.stringify(values.json ? doc : doc.value, null, 2)}\n`);
      return 0;
    }
    case 'put': {
      writable();
      const value: unknown = JSON.parse(await readStdin());
      const outcome = await docs.replace(collection, needKey(), value, values['if-match'] ? { etag: values['if-match'] } : {});
      process.stdout.write(`${outcome}\n`);
      return outcome === 'written' ? 0 : 3;
    }
    case 'list': {
      const where: Record<string, string> = {};
      for (const entry of values.where ?? []) {
        const at = entry.indexOf('=');
        if (at < 1) throw new UsageError('--where takes field=value');
        where[entry.slice(0, at)] = entry.slice(at + 1);
      }
      const items = await docs.list(collection, { ...(values.prefix ? { prefix: values.prefix } : {}), where });
      process.stdout.write(`${JSON.stringify(items, null, 2)}\n`);
      return 0;
    }
    case 'delete':
      writable();
      process.stdout.write(`${(await docs.delete(collection, needKey())) ? 'deleted' : 'absent'}\n`);
      return 0;
    default:
      throw new UsageError(`unknown state action ${action}`);
  }
}

export async function main(argv: string[]): Promise<number> {
  let parsed: ReturnType<typeof parseArgs<{ options: typeof options; allowPositionals: true }>>;
  try {
    parsed = parseArgs({ args: argv, options, allowPositionals: true, strict: true });
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n\n${HELP}`);
    return 2;
  }
  const { values, positionals } = parsed;
  const [command, ...rest] = positionals;
  if (values.version) { process.stdout.write(`${VERSION}\n`); return 0; }
  if (values.help || !command) { process.stdout.write(HELP); return command || values.help ? 0 : 2; }
  try {
    switch (command) {
      case 'validate': return await commandValidate(values);
      case 'run': return await commandRun(values);
      case 'trigger': return await commandTrigger(values, rest);
      case 'enqueue': return await commandEnqueue(values, rest);
      case 'jobs': return await commandJobs(values, rest, false);
      case 'job': return await commandJobs(values, rest, true);
      case 'waits': return await commandWaits(values);
      case 'state': return await commandState(values, rest);
      case 'job-exec': {
        if (!rest[0]) throw new UsageError('usage: operator job-exec <run-dir>');
        return await runJobExec(rest[0]);
      }
      default:
        process.stderr.write(`unknown command ${command}\n\n${HELP}`);
        return 2;
    }
  } catch (error) {
    if (error instanceof UsageError) { process.stderr.write(`${error.message}\n`); return 2; }
    process.stderr.write(`error${error instanceof OperatorError ? ` [${error.code}]` : ''}: ${errorText(error)}\n`);
    return 1;
  }
}

process.exitCode = await main(process.argv.slice(2));
