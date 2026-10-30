import { randomBytes } from 'node:crypto';
import { isStateKey } from './claims.ts';
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
  /** The run that took the item, and an opaque reference to what it delivers the item in. */
  takenBy?: { run: string; ref?: string };
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

function required(value: string, field: string): string {
  if (!value.trim()) throw new OperatorError('INVALID_QUEUE_ITEM', `a queue item's ${field} cannot be empty`);
  return value;
}

function newId(now: Date): string {
  return `q-${now.toISOString().replace(/\D/g, '').slice(0, 14)}-${randomBytes(6).toString('hex')}`;
}

/** Two writes of the same item agree when everything but the moment of writing does. */
function sameItem(a: QueueItem, b: QueueItem): boolean {
  return JSON.stringify({ ...a, updatedAt: '' }) === JSON.stringify({ ...b, updatedAt: '' });
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
  const title = required(input.title, 'title').trim();
  required(input.body, 'body');
  const status = input.status ?? 'ready';
  if (!['ready', 'needs-decision', 'blocked'].includes(status)) throw new OperatorError('INVALID_QUEUE_ITEM', `a new item starts ready, needs-decision or blocked, not ${status}`);
  const at = now.toISOString();
  for (let attempt = 0; attempt < ADD_ATTEMPTS; attempt += 1) {
    const item: QueueItem = {
      id: newId(now),
      title,
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
  if (!isStateKey(id)) throw new OperatorError('INVALID_QUEUE_ITEM', `queue item id ${JSON.stringify(id)} is not a valid key`);
  const doc = await docs.get<QueueItem>(QUEUE_COLLECTION, id);
  if (!doc) throw new OperatorError('NOT_FOUND', `no queue item ${id}`);
  return doc;
}

export type QueueWrite = { ok: true; item: QueueItem; etag: string } | { ok: false; reason: 'conflict' | 'not-takeable'; item: QueueItem };

/**
 * Writes `item` over the version read at `etag`. A conflict is read again: a store that made the
 * write but reported it lost (a repeated conditional request after a timeout answers that way) shows
 * this very item, which is the write's success, not a loss. The answer carries the item's new etag.
 */
async function write(docs: DocStore, item: QueueItem, etag: string): Promise<QueueWrite> {
  const outcome = await docs.replace(QUEUE_COLLECTION, item.id, item, { etag });
  const now = await getQueueItem(docs, item.id);
  if (outcome === 'written' || sameItem(now.value, item)) return { ok: true, item: now.value, etag: now.etag };
  return { ok: false, reason: 'conflict', item: now.value };
}

/**
 * Takes an item for one run: `ready` or `needs-decision` becomes `taken`, compare-and-set on the
 * item as read, so of two runs taking the same item exactly one wins. `ref` is opaque: what the
 * run delivers the item in.
 */
export async function takeQueueItem(docs: DocStore, id: string, run: string, ref?: string, now: Date = new Date()): Promise<QueueWrite> {
  if (!isStateKey(run)) throw new OperatorError('INVALID_RUN_ID', `run id ${JSON.stringify(run)} may only use letters, digits, '.', '_', ':' and '-' (at most 120)`);
  const doc = await getQueueItem(docs, id);
  if (!TAKEABLE.includes(doc.value.status)) return { ok: false, reason: 'not-takeable', item: doc.value };
  return write(docs, { ...doc.value, status: 'taken', takenBy: { run, ...(ref ? { ref } : {}) }, updatedAt: now.toISOString() }, doc.etag);
}

export interface QueueChange {
  status?: QueueStatus;
  title?: string;
  body?: string;
  priority?: QueuePriority;
}

/**
 * Changes an item the caller read at `etag`. A done or cancelled item no longer changes at all; a
 * status change must be a legal transition, and leaving `taken` for anything but `done` drops who
 * took it, since the item is free again.
 */
export async function updateQueueItem(docs: DocStore, id: string, change: QueueChange, etag: string, now: Date = new Date()): Promise<QueueWrite> {
  if (change.title !== undefined) required(change.title, 'title');
  if (change.body !== undefined) required(change.body, 'body');
  const doc = await getQueueItem(docs, id);
  if (doc.etag !== etag) return { ok: false, reason: 'conflict', item: doc.value };
  const current = doc.value;
  if (TRANSITIONS[current.status].length === 0) throw new OperatorError('INVALID_TRANSITION', `queue item ${id} is ${current.status}, which is final`);
  const status = change.status ?? current.status;
  if (status !== current.status && !canMove(current.status, status)) {
    throw new OperatorError('INVALID_TRANSITION', `queue item ${id} cannot move from ${current.status} to ${status}`);
  }
  if (status === 'taken' && current.status !== 'taken') throw new OperatorError('INVALID_TRANSITION', `queue item ${id} is taken with \`queue take\`, which records who took it`);
  const { takenBy, ...rest } = current;
  return write(docs, {
    ...rest,
    ...(change.title !== undefined ? { title: change.title.trim() } : {}),
    ...(change.body !== undefined ? { body: change.body } : {}),
    ...(change.priority !== undefined ? { priority: change.priority } : {}),
    status,
    ...(takenBy && (status === 'taken' || status === 'done') ? { takenBy } : {}),
    updatedAt: now.toISOString(),
  }, etag);
}
