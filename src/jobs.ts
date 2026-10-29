import { createHash } from 'node:crypto';
import type { JsonObject, ResultStatus, TriggerKind } from './contract.ts';
import { OperatorError } from './errors.ts';
import type { Manifest } from './manifest.ts';
import type { DocStore } from './state/types.ts';

export type JobStatus = 'queued' | 'running' | 'done' | 'noop' | 'waiting' | 'needs-input' | 'failed' | 'cancelled';

export const TERMINAL_STATUSES: readonly JobStatus[] = ['done', 'noop', 'waiting', 'needs-input', 'failed', 'cancelled'];

export interface SlotHold {
  pool: string;
  kind: 'limit' | 'workspaces';
  key: string;
  token: string;
  global: boolean;
  member?: string;
  /** A read placement: the member's directory without its lease, so nothing is renewed or released. */
  read?: boolean;
}

export interface JobRun {
  attempt: number;
  host: string;
  runDir: string;
  startedAt: string;
  placement: { kind: 'headless' | 'herdr'; workspace?: string; tabId?: string; paneId?: string; degraded?: string };
  /** A limit pool held alongside the operation's main pool, e.g. an engine's concurrency. */
  limitSlot?: SlotHold;
  slot?: SlotHold;
  lease?: { key: string; token: string };
}

export interface JobOutcome {
  finishedAt: string;
  status: ResultStatus;
  message?: string;
  evidence: string[];
  /** Ids of the follow-on jobs this run enqueued. */
  next: string[];
  exitCode?: number | null;
  failure?: { reason: string; retryable: boolean };
}

export interface JobRecord {
  id: string;
  project: string;
  workflow: string;
  operation: string;
  subject: string;
  input: JsonObject;
  trigger: { id: string; name: string; kind: TriggerKind };
  status: JobStatus;
  attempt: number;
  createdAt: string;
  updatedAt: string;
  notBefore?: string;
  /** Why a queued job has not started yet, e.g. a full pool. */
  waitingFor?: string;
  /** The workspace member the job runs in, when its request named one. */
  member?: string;
  run?: JobRun;
  outcome?: JobOutcome;
  history: { at: string; event: string; detail?: string }[];
}

const COLLECTION = 'jobs';
const ACTIVE_TTL_MS = 30 * 86_400_000;
const HISTORY_LIMIT = 25;

export function stableId(prefix: string, ...parts: string[]): string {
  return `${prefix}${createHash('sha256').update(parts.join('\u0000')).digest('hex').slice(0, 24)}`;
}

/** The dedupe key of D2: one job per (workflow, operation, subject, trigger id). */
export function jobId(project: string, workflow: string, operation: string, subject: string, triggerId: string): string {
  return stableId('j', project, workflow, operation, subject, triggerId);
}

export function addHistory(job: JobRecord, event: string, detail?: string): void {
  job.history.push({ at: new Date().toISOString(), event, ...(detail ? { detail } : {}) });
  if (job.history.length > HISTORY_LIMIT) job.history.splice(0, job.history.length - HISTORY_LIMIT);
}

export class JobStore {
  readonly docs: DocStore;
  readonly retention: Manifest['runtime']['retentionMs'];

  constructor(docs: DocStore, retention: Manifest['runtime']['retentionMs']) {
    this.docs = docs;
    this.retention = retention;
  }

  ttlFor(status: JobStatus): number {
    switch (status) {
      case 'done': return this.retention.done;
      case 'noop': return this.retention.noop;
      case 'failed':
      case 'cancelled': return this.retention.failed;
      case 'waiting':
      case 'needs-input': return this.retention.waiting;
      default: return ACTIVE_TTL_MS;
    }
  }

  async create(job: JobRecord): Promise<'created' | 'duplicate'> {
    return (await this.docs.create(COLLECTION, job.id, job, this.ttlFor(job.status))) === 'created' ? 'created' : 'duplicate';
  }

  async get(id: string): Promise<JobRecord | undefined> {
    return (await this.docs.get<JobRecord>(COLLECTION, id))?.value;
  }

  /**
   * Read-modify-write with compare-and-swap. `mutate` receives a copy and returns the new record,
   * or undefined to leave the job as it is. A concurrent writer makes it re-read and try again.
   */
  async update(id: string, mutate: (job: JobRecord) => JobRecord | undefined): Promise<JobRecord | undefined> {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const current = await this.docs.get<JobRecord>(COLLECTION, id);
      if (!current) return undefined;
      const next = mutate(structuredClone(current.value));
      if (!next) return undefined;
      next.updatedAt = new Date().toISOString();
      if ((await this.docs.replace(COLLECTION, id, next, { etag: current.etag, ttlMs: this.ttlFor(next.status) })) === 'written') return next;
    }
    throw new OperatorError('STATE_CONTENTION', `job ${id} kept changing under eight consecutive updates`);
  }

  async list(status?: JobStatus): Promise<JobRecord[]> {
    const items = await this.docs.list<JobRecord>(COLLECTION, status ? { where: { status } } : {});
    return items.map((item) => item.value).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
}

export interface EnqueueRequest {
  project: string;
  workflow: string;
  operation: string;
  subject: string;
  input: JsonObject;
  trigger: { id: string; name: string; kind: TriggerKind };
  notBefore?: string;
  member?: string;
}

/** Creates the job unless one with the same dedupe key exists; answers which happened. */
export async function enqueue(store: JobStore, request: EnqueueRequest): Promise<{ id: string; created: boolean }> {
  const now = new Date().toISOString();
  const id = jobId(request.project, request.workflow, request.operation, request.subject, request.trigger.id);
  const job: JobRecord = {
    id,
    project: request.project,
    workflow: request.workflow,
    operation: request.operation,
    subject: request.subject,
    input: request.input,
    trigger: request.trigger,
    status: 'queued',
    attempt: 1,
    createdAt: now,
    updatedAt: now,
    history: [{ at: now, event: 'queued', detail: `${request.trigger.kind} ${request.trigger.name}` }],
    ...(request.notBefore ? { notBefore: request.notBefore } : {}),
    ...(request.member ? { member: request.member } : {}),
  };
  return { id, created: (await store.create(job)) === 'created' };
}
