import type { JsonObject, WaitDescriptor } from './contract.ts';
import { OperatorError } from './errors.ts';
import { stableId } from './jobs.ts';
import type { DocStore } from './state/types.ts';

export type WaitStatus = 'open' | 'resolved' | 'expired';

export interface WaitRecord {
  id: string;
  project: string;
  workflow: string;
  on: string;
  subject: string;
  key?: string;
  resume: string;
  input: JsonObject;
  jobId: string;
  attempt: number;
  createdAt: string;
  expiresAt?: string;
  /** The workspace member the resumed operation runs in. */
  member?: string;
  status: WaitStatus;
  resolvedBy?: string;
  resolvedAt?: string;
}

const COLLECTION = 'waits';
const OPEN_TTL_MS = 90 * 86_400_000;
const CLOSED_TTL_MS = 14 * 86_400_000;

export class WaitStore {
  readonly docs: DocStore;

  constructor(docs: DocStore) {
    this.docs = docs;
  }

  async open(project: string, workflow: string, jobId: string, attempt: number, wait: WaitDescriptor): Promise<WaitRecord> {
    const record: WaitRecord = {
      id: stableId('w', jobId, String(attempt)),
      project,
      workflow,
      on: wait.on,
      subject: wait.subject,
      resume: wait.resume,
      input: wait.input,
      jobId,
      attempt,
      createdAt: new Date().toISOString(),
      status: 'open',
      ...(wait.key ? { key: wait.key } : {}),
      ...(wait.member ? { member: wait.member } : {}),
      ...(wait.expiresAt ? { expiresAt: wait.expiresAt } : {}),
    };
    // Re-collecting the same run after a crash finds the wait already stored, which is fine.
    await this.docs.create(COLLECTION, record.id, record, OPEN_TTL_MS);
    return record;
  }

  async listOpen(filter: { workflow?: string; on?: string; subject?: string } = {}): Promise<WaitRecord[]> {
    const where: Record<string, string> = { status: 'open' };
    for (const [field, value] of Object.entries(filter)) if (value !== undefined) where[field] = value;
    return (await this.docs.list<WaitRecord>(COLLECTION, { where })).map((item) => item.value);
  }

  async close(id: string, status: Exclude<WaitStatus, 'open'>, resolvedBy?: string): Promise<boolean> {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const current = await this.docs.get<WaitRecord>(COLLECTION, id);
      if (!current || current.value.status !== 'open') return false;
      const next: WaitRecord = { ...current.value, status, resolvedAt: new Date().toISOString(), ...(resolvedBy ? { resolvedBy } : {}) };
      if ((await this.docs.replace(COLLECTION, id, next, { etag: current.etag, ttlMs: CLOSED_TTL_MS })) === 'written') return true;
    }
    throw new OperatorError('STATE_CONTENTION', `wait ${id} kept changing under eight consecutive updates`);
  }
}
