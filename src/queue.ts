import { randomBytes } from 'node:crypto';
import { OperatorError } from './errors.ts';
import type { DocStore, StoredDoc } from './state/types.ts';

/**
 * A private work queue in the project's namespace, for a project whose queue must not be public.
 * The runtime keeps the items and enforces their transitions; which item is worth taking is the
 * consuming operation's decision.
 */
export const QUEUE_COLLECTION = 'work-queue';

export const QUEUE_PRIORITIES = ['critical', 'high', 'medium', 'low'] as const;
export const QUEUE_STATUSES = ['ready', 'needs-decision', 'blocked', 'taken', 'done', 'cancelled'] as const;
export const QUEUE_SOURCES = ['owner', 'project-session'] as const;
export type QueuePriority = (typeof QUEUE_PRIORITIES)[number];
export type QueueStatus = (typeof QUEUE_STATUSES)[number];
export type QueueSourceKind = (typeof QUEUE_SOURCES)[number];

export interface QueueItem {
  id: string;
  title: string;
  /** The spec: the problem, what is expected, and the evidence. */
  body: string;
  priority: QueuePriority;
  status: QueueStatus;
  source: { kind: QueueSourceKind; ref?: string };
  createdAt: string;
  updatedAt: string;
  takenBy?: { run: string; pr?: string };
}

/** Where an item may go from each status; done and cancelled are final. */
const TRANSITIONS: Record<QueueStatus, readonly QueueStatus[]> = {
  ready: ['taken', 'needs-decision', 'blocked', 'cancelled'],
  'needs-decision': ['ready', 'taken', 'blocked', 'cancelled'],
  blocked: ['ready', 'needs-decision', 'cancelled'],
  taken: ['done', 'ready', 'needs-decision', 'blocked', 'cancelled'],
  done: [],
  cancelled: [],
};

const TAKEABLE: readonly QueueStatus[] = ['ready', 'needs-decision'];
const ADD_ATTEMPTS = 5;

function oneOf<T extends string>(allowed: readonly T[], value: string, field: string): T {
  if (!(allowed as readonly string[]).includes(value)) throw new OperatorError('INVALID_QUEUE_ITEM', `${field} must be one of ${allowed.join(', ')}, got ${JSON.stringify(value)}`);
  return value as T;
}

export const queuePriority = (value: string): QueuePriority => oneOf(QUEUE_PRIORITIES, value, 'priority');
export const queueStatus = (value: string): QueueStatus => oneOf(QUEUE_STATUSES, value, 'status');
export const queueSourceKind = (value: string): QueueSourceKind => oneOf(QUEUE_SOURCES, value, 'source kind');

export function canMove(from: QueueStatus, to: QueueStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

function newId(now: Date): string {
  return `q-${now.toISOString().replace(/\D/g, '').slice(0, 14)}-${randomBytes(3).toString('hex')}`;
}

export interface NewQueueItem {
  title: string;
  body: string;
  priority?: QueuePriority;
  status?: QueueStatus;
  source?: { kind: QueueSourceKind; ref?: string };
}

/** Adds an item; a new item starts `ready`, `needs-decision` or `blocked`, never taken or closed. */
export async function addQueueItem(docs: DocStore, input: NewQueueItem, now: Date = new Date()): Promise<QueueItem> {
  if (!input.title.trim()) throw new OperatorError('INVALID_QUEUE_ITEM', 'a queue item needs a title');
  const status = input.status ?? 'ready';
  if (!['ready', 'needs-decision', 'blocked'].includes(status)) throw new OperatorError('INVALID_QUEUE_ITEM', `a new item starts ready, needs-decision or blocked, not ${status}`);
  const at = now.toISOString();
  for (let attempt = 0; attempt < ADD_ATTEMPTS; attempt += 1) {
    const item: QueueItem = {
      id: newId(now),
      title: input.title.trim(),
      body: input.body,
      priority: input.priority ?? 'medium',
      status,
      source: input.source ?? { kind: 'owner' },
      createdAt: at,
      updatedAt: at,
    };
    try {
      if ((await docs.create(QUEUE_COLLECTION, item.id, item)) === 'created') return item;
    } catch (error) {
      // An error from the store leaves the outcome unknown: the item there now is this one when its
      // content matches, another writer's when it does not (a fresh id is tried), and none is a failure.
      const there = await docs.get<QueueItem>(QUEUE_COLLECTION, item.id);
      if (!there) throw error;
      if (JSON.stringify(there.value) === JSON.stringify(item)) return item;
    }
  }
  throw new OperatorError('QUEUE_CONTENDED', `no free item id after ${ADD_ATTEMPTS} attempts`);
}

/** Items, most urgent first, oldest first within a priority. */
export async function listQueue(docs: DocStore, status?: QueueStatus): Promise<QueueItem[]> {
  const items = (await docs.list<QueueItem>(QUEUE_COLLECTION, status ? { where: { status } } : {})).map((entry) => entry.value);
  const rank = (item: QueueItem): number => QUEUE_PRIORITIES.indexOf(item.priority);
  return items.sort((a, b) => rank(a) - rank(b) || a.createdAt.localeCompare(b.createdAt));
}

export async function getQueueItem(docs: DocStore, id: string): Promise<StoredDoc<QueueItem>> {
  const doc = await docs.get<QueueItem>(QUEUE_COLLECTION, id);
  if (!doc) throw new OperatorError('NOT_FOUND', `no queue item ${id}`);
  return doc;
}

export type QueueWrite = { ok: true; item: QueueItem; etag?: string } | { ok: false; reason: 'conflict' | 'not-takeable'; item: QueueItem };

/**
 * Takes an item for one run: `ready` or `needs-decision` becomes `taken`, compare-and-set on the
 * item as read, so of two runs taking the same item exactly one wins.
 */
export async function takeQueueItem(docs: DocStore, id: string, run: string, pr?: string, now: Date = new Date()): Promise<QueueWrite> {
  const doc = await getQueueItem(docs, id);
  if (!TAKEABLE.includes(doc.value.status)) return { ok: false, reason: 'not-takeable', item: doc.value };
  const item: QueueItem = { ...doc.value, status: 'taken', takenBy: { run, ...(pr ? { pr } : {}) }, updatedAt: now.toISOString() };
  if ((await docs.replace(QUEUE_COLLECTION, id, item, { etag: doc.etag })) === 'conflict') return { ok: false, reason: 'conflict', item: (await getQueueItem(docs, id)).value };
  return { ok: true, item };
}

export interface QueueChange {
  status?: QueueStatus;
  title?: string;
  body?: string;
  priority?: QueuePriority;
}

/**
 * Changes an item the caller read at `etag`. A status change must be a legal transition; leaving
 * `taken` for anything but `done` drops who took it, since the item is free again.
 */
export async function updateQueueItem(docs: DocStore, id: string, change: QueueChange, etag: string, now: Date = new Date()): Promise<QueueWrite> {
  const doc = await getQueueItem(docs, id);
  if (doc.etag !== etag) return { ok: false, reason: 'conflict', item: doc.value };
  const current = doc.value;
  const status = change.status ?? current.status;
  if (status !== current.status && !canMove(current.status, status)) {
    throw new OperatorError('INVALID_TRANSITION', `queue item ${id} cannot move from ${current.status} to ${status}`);
  }
  if (status === 'taken' && current.status !== 'taken') throw new OperatorError('INVALID_TRANSITION', `queue item ${id} is taken with \`queue take\`, which records who took it`);
  const { takenBy, ...rest } = current;
  const item: QueueItem = {
    ...rest,
    ...(change.title !== undefined ? { title: change.title } : {}),
    ...(change.body !== undefined ? { body: change.body } : {}),
    ...(change.priority !== undefined ? { priority: change.priority } : {}),
    status,
    ...(takenBy && (status === 'taken' || status === 'done') ? { takenBy } : {}),
    updatedAt: now.toISOString(),
  };
  if ((await docs.replace(QUEUE_COLLECTION, id, item, { etag })) === 'conflict') return { ok: false, reason: 'conflict', item: (await getQueueItem(docs, id)).value };
  return { ok: true, item };
}
