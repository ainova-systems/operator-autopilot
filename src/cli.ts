#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { hostname, userInfo } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { CLAIMS_COLLECTION, isStateKey, liveClaims, redactClaim, releaseClaim, renewClaim, showClaim, takeClaim, type ClaimResult } from './claims.ts';
import { isMemberName, type JsonObject } from './contract.ts';
import { Daemon, SUBJECT_TABS_COLLECTION, type SubjectTab } from './daemon.ts';
import { parseDuration } from './duration.ts';
import { loadEnvFile } from './env.ts';
import { OperatorError } from './errors.ts';
import { createHerdr } from './herdr.ts';
import { runJobExec } from './job-exec.ts';
import { enqueue, JobStore, type JobStatus } from './jobs.ts';
import { createLogger, errorText, type LogLevel } from './log.ts';
import { loadManifest, manifestPath, type Manifest } from './manifest.ts';
import { clearPause, CONTROL_COLLECTION, readPause, requestPause } from './pause.ts';
import { addQueueItem, getQueueItem, listQueue, QUEUE_COLLECTION, queuePriority, queueSourceKind, queueStatus, takeQueueItem, updateQueueItem, type QueueItem, type QueueWrite } from './queue.ts';
import { installService, serviceStatus, uninstallService } from './service.ts';
import { capabilityProblems, checkCapabilities, openState } from './state/open.ts';
import type { StateBackend } from './state/types.ts';
import { fireTrigger } from './triggers.ts';
import { validateProject } from './validate.ts';
import { WaitStore } from './waits.ts';

const VERSION = (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version;
const RESERVED_COLLECTIONS = new Set(['jobs', 'waits', 'threads', 'deliveries', 'tabs', SUBJECT_TABS_COLLECTION, CONTROL_COLLECTION, CLAIMS_COLLECTION, QUEUE_COLLECTION]);
const PAUSE_POLL_MS = 5_000;
const DEFAULT_CLAIM_TTL = '1h';

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
  tabs                             List per-subject herdr tabs: subject, operation, member, tab and session
  pause                            Start no new job while running ones finish; --wait until none runs.
                                   The service resumes by itself when it starts again
  resume                           End a pause
  service <install|uninstall|status> <project>
                                   Run the daemon as the systemd user service operator@<project> (Linux)
  state <get|put|list|delete> <collection> [key]
                                   Project state for scripts and skills (reserved: jobs, waits, threads, deliveries,
                                   tabs, subject-tabs, control, subject-claims, work-queue)
  claim <take|renew|release|show> [subject] --run <id> [--ttl 1h]
                                   A compare-and-set lease on an opaque subject; show without a subject lists live claims
  queue <add|list|get|take|update> [id]
                                   The project's private work queue (see Claims and queue)
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
  --reason <text>       pause: why, for the log and the owner
  --wait                pause: return once no job runs
  --timeout <duration>  pause --wait: give up after this long (default: wait as long as it takes)
  --run <id>            claim, queue take: the run taking or holding it
  --ref <r>             queue take: an opaque reference to what the run delivers the item in
  --ttl <duration>      claim take/renew: how long the lease lasts (default 1h)
  --env-file <path>     service install: secrets file the service reads (OPERATOR_ENV_FILE)
  --no-start            service install: enable the service without starting it now
  --json                Machine-readable output
  --log-level <level>   debug, info, warn or error (default info)
  -h, --help            This help
  -v, --version         Print the version

Claims and queue:
  Subjects, run ids and item ids use letters, digits, '.', '_', ':' and '-' (at most 120).
  A lease lasts at most 24h (renew to keep a subject longer); expiry is judged by the reading host's clock.
  claim take|renew|release <subject> --run <id> [--ttl 1h]   exit 3 when another run holds it
  queue add --title <t> --body-file <f|-> [--priority critical|high|medium|low]
            [--status ready|needs-decision|blocked] [--source-kind owner|project-session] [--source-ref r]
  queue list [--status s]  |  queue get <id>
  queue take <id> --run <id> [--ref <r>]           ready or needs-decision -> taken; --ref is opaque
  queue update <id> --if-match <etag> [--status s] [--title t] [--body-file f|-] [--priority p]
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
  reason: { type: 'string' },
  wait: { type: 'boolean' },
  timeout: { type: 'string' },
  'env-file': { type: 'string' },
  run: { type: 'string' },
  ttl: { type: 'string' },
  title: { type: 'string' },
  'body-file': { type: 'string' },
  priority: { type: 'string' },
  'source-kind': { type: 'string' },
  'source-ref': { type: 'string' },
  ref: { type: 'string' },
  'no-start': { type: 'boolean' },
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

/** Lists the per-subject herdr tabs the runtime keeps, with their sessions. */
async function commandTabs(values: Values): Promise<number> {
  const manifest = load(values);
  const tabs = (await openForCommand(manifest).docs.list<SubjectTab>(SUBJECT_TABS_COLLECTION)).map((item) => item.value).sort((a, b) => a.since.localeCompare(b.since));
  print(values, tabs, () => tabs.map((t) => `${t.workflow}  ${t.subject || '-'}  ${t.operation}  member ${t.member ?? '-'}  tab ${t.tabId}  pane ${t.paneId}  session ${t.sessionId ?? '-'}  last ${t.jobId}  since ${t.since}`).join('\n') || 'no per-subject tabs');
  return 0;
}

/** Pauses the project; with --wait returns once no job runs (0), or after --timeout (3). */
async function commandPause(values: Values): Promise<number> {
  const manifest = load(values);
  const docs = openForCommand(manifest).docs;
  const store = new JobStore(docs, manifest.runtime.retentionMs);
  const timeoutMs = values.timeout === undefined ? undefined : parseDuration(values.timeout, '--timeout');
  const { pause, created } = await requestPause(docs, `${userInfo().username}@${hostname()}`, values.reason);
  const running = async (): Promise<number> => (await store.list('running')).length;
  const count = await running();
  print(values, { pause, created, running: count }, () => `${created ? 'pausing' : `already paused since ${pause.since} by ${pause.by}`}: no new job starts; ${count} running job(s) finish first`);
  if (!values.wait) return 0;
  const deadline = timeoutMs === undefined ? Infinity : Date.now() + timeoutMs;
  for (let left = count; ; left = await running()) {
    if (!(await readPause(docs))) { process.stderr.write('the pause was ended while waiting\n'); return 1; }
    if (left === 0) { process.stdout.write('paused: no job running\n'); return 0; }
    if (Date.now() >= deadline) { process.stdout.write(`still ${left} job(s) running\n`); return 3; }
    await sleep(PAUSE_POLL_MS);
  }
}

async function commandResume(values: Values): Promise<number> {
  const manifest = load(values);
  const ended = await clearPause(openForCommand(manifest).docs);
  print(values, { resumed: ended }, () => (ended ? 'resumed: queued jobs start on the next poll' : 'not paused'));
  return 0;
}

async function commandService(values: Values, positionals: string[]): Promise<number> {
  const [action, project] = positionals;
  if (!action || !project) throw new UsageError('usage: operator service <install|uninstall|status> <project>');
  switch (action) {
    case 'install': {
      const report = installService({
        project,
        manifest: manifestPath(values.manifest),
        ...(values['env-file'] !== undefined ? { envFile: values['env-file'] } : {}),
        start: !values['no-start'],
      });
      print(values, report, () => [
        `${report.instance}: ${report.started ? 'enabled and started' : 'enabled'} (unit ${report.unit}, env file ${report.env}: ${report.envPath})`,
        ...(report.env === 'kept' ? ['the existing env file was kept as it is; edit it to change the manifest or PATH'] : []),
        ...(report.linger ? [] : ['linger is off: the service stops when you log out; enable it with `loginctl enable-linger`']),
      ].join('\n'));
      return 0;
    }
    case 'uninstall': {
      const report = uninstallService(project);
      print(values, report, () => [
        `${report.instance}: stopped and disabled; running jobs were detached and finish on their own`,
        report.unitRemoved ? 'no other project uses the unit, so it was removed' : 'the unit stays for the other enabled projects',
        `kept ${report.envPath}`,
      ].join('\n'));
      return 0;
    }
    case 'status': {
      const report = serviceStatus(project);
      print(values, report, () => `${report.instance}: ${report.enabled}, ${report.active}; unit ${report.unit ? 'present' : 'missing'}, env file ${report.env ? 'present' : 'missing'}, linger ${report.linger ? 'on' : 'off'}`);
      return report.active === 'active' ? 0 : 3;
    }
    default:
      throw new UsageError(`unknown service action ${action}`);
  }
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
      const value = collection === CLAIMS_COLLECTION ? redactClaim(doc.value) : doc.value;
      process.stdout.write(`${JSON.stringify(values.json ? { ...doc, value } : value, null, 2)}\n`);
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
      const shown = collection === CLAIMS_COLLECTION ? items.map((item) => ({ ...item, value: redactClaim(item.value) })) : items;
      process.stdout.write(`${JSON.stringify(shown, null, 2)}\n`);
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

function claimText(subject: string, result: ClaimResult): string {
  if (result.ok) return `${result.claim.releasedAt ? 'released' : 'held'}: ${result.claim.subject} by ${result.claim.run} until ${result.claim.expiresAt}`;
  if (result.reason === 'absent') return 'no claim';
  if (!result.holder) return `${result.reason}: ${subject} is held; the holder is unknown`;
  return `${result.reason}: ${result.holder.subject} is held by ${result.holder.run} until ${result.holder.expiresAt}`;
}

/** A claim answers 0 when the call took effect and 3 when another run holds the subject or none does. */
async function commandClaim(values: Values, positionals: string[]): Promise<number> {
  const [action, subject] = positionals;
  if (!action) throw new UsageError('usage: operator claim <take|renew|release|show> [subject] --run <id> [--ttl 1h]');
  const manifest = load(values);
  const store = openForCommand(manifest);
  if (action === 'show') {
    if (!subject) {
      const claims = await liveClaims(store);
      print(values, claims, () => claims.map((c) => `${c.subject}  ${c.run}  until ${c.expiresAt}`).join('\n') || 'no live claims');
      return 0;
    }
    const shown = await showClaim(store, key(subject, 'subject'));
    print(values, shown, () => {
      const state = shown.locked ? 'held' : 'free';
      const record = shown.claim ? ` - record: ${shown.claim.run} until ${shown.claim.expiresAt}${shown.claim.releasedAt ? ', released' : ''}` : ' - no record';
      const disagree = shown.claim && shown.live !== shown.locked ? ` (the record says ${shown.live ? 'held' : 'free'}; the lock decides)` : '';
      return `${state}: ${subject}${record}${disagree}`;
    });
    return 0;
  }
  if (!subject) throw new UsageError(`claim ${action} needs a subject`);
  if (!values.run) throw new UsageError(`claim ${action} needs --run <id>`);
  key(subject, 'subject');
  key(values.run, '--run');
  const ttlMs = parseDuration(values.ttl ?? DEFAULT_CLAIM_TTL, '--ttl');
  let result: ClaimResult;
  switch (action) {
    case 'take': result = await takeClaim(store, subject, values.run, ttlMs); break;
    case 'renew': result = await renewClaim(store, subject, values.run, ttlMs); break;
    case 'release': result = await releaseClaim(store, subject, values.run); break;
    default: throw new UsageError(`unknown claim action ${action}`);
  }
  print(values, result, () => claimText(subject, result));
  return result.ok ? 0 : 3;
}

async function readBody(path: string): Promise<string> {
  if (path === '') throw new UsageError('--body-file needs a path, or - for stdin');
  const body = path === '-' ? await readStdin() : readFileSync(path, 'utf8');
  if (!body.trim()) throw new UsageError(`the body read from ${path === '-' ? 'stdin' : path} is empty`);
  return body;
}

/** Subjects and run ids become state keys; a malformed one is a usage error, before any call. */
function key(value: string, what: string): string {
  if (!isStateKey(value)) throw new UsageError(`${what} ${JSON.stringify(value)} may only use letters, digits, '.', '_', ':' and '-' (at most 120)`);
  return value;
}

function queueLine(item: QueueItem): string {
  return [item.id, item.status.padEnd(14), item.priority.padEnd(8), item.title, item.takenBy ? `(taken by ${item.takenBy.run}${item.takenBy.ref ? `, ${item.takenBy.ref}` : ''})` : ''].join('  ').trimEnd();
}

function queueWritten(values: Values, result: QueueWrite): number {
  print(values, result, () => (result.ok ? `${queueLine(result.item)}\netag ${result.etag ?? 'unknown: changed since by another writer'}` : `${result.reason}: ${queueLine(result.item)}`));
  return result.ok ? 0 : 3;
}

/** The private work queue; a lost compare-and-set or an item that cannot be taken answers 3. */
async function commandQueue(values: Values, positionals: string[]): Promise<number> {
  const [action, id] = positionals;
  if (!action) throw new UsageError('usage: operator queue <add|list|get|take|update> [id] (see operator --help)');
  const manifest = load(values);
  const docs = openForCommand(manifest).docs;
  const needId = (): string => { if (!id) throw new UsageError(`queue ${action} needs an item id`); return id; };
  switch (action) {
    case 'add': {
      if (!values.title?.trim() || values['body-file'] === undefined) throw new UsageError('queue add needs --title and --body-file');
      if (values['source-ref'] !== undefined && values['source-kind'] === undefined) throw new UsageError('--source-ref goes with --source-kind');
      const item = await addQueueItem(docs, {
        title: values.title,
        body: await readBody(values['body-file']),
        ...(values.priority ? { priority: queuePriority(values.priority) } : {}),
        ...(values.status ? { status: queueStatus(values.status) } : {}),
        ...(values['source-kind'] ? { source: { kind: queueSourceKind(values['source-kind']), ...(values['source-ref'] ? { ref: values['source-ref'] } : {}) } } : {}),
      });
      print(values, item, () => `added ${queueLine(item)}`);
      return 0;
    }
    case 'list': {
      const items = await listQueue(docs, values.status ? queueStatus(values.status) : undefined);
      print(values, items, () => items.map(queueLine).join('\n') || 'queue is empty');
      return 0;
    }
    case 'get': {
      const doc = await getQueueItem(docs, needId());
      print(values, { ...doc.value, etag: doc.etag }, () => `${queueLine(doc.value)}\netag ${doc.etag}\n\n${doc.value.body}`);
      return 0;
    }
    case 'take': {
      if (!values.run) throw new UsageError('queue take needs --run <id>');
      return queueWritten(values, await takeQueueItem(docs, needId(), key(values.run, '--run'), values.ref));
    }
    case 'update': {
      if (!values['if-match']) throw new UsageError('queue update needs --if-match <etag> from queue get');
      if (values.title !== undefined && !values.title.trim()) throw new UsageError('--title cannot be empty');
      return queueWritten(values, await updateQueueItem(docs, needId(), {
        ...(values.status ? { status: queueStatus(values.status) } : {}),
        ...(values.title !== undefined ? { title: values.title } : {}),
        ...(values['body-file'] !== undefined ? { body: await readBody(values['body-file']) } : {}),
        ...(values.priority ? { priority: queuePriority(values.priority) } : {}),
      }, values['if-match']));
    }
    default:
      throw new UsageError(`unknown queue action ${action}`);
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
      case 'tabs': return await commandTabs(values);
      case 'pause': return await commandPause(values);
      case 'resume': return await commandResume(values);
      case 'service': return await commandService(values, rest);
      case 'state': return await commandState(values, rest);
      case 'claim': return await commandClaim(values, rest);
      case 'queue': return await commandQueue(values, rest);
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
