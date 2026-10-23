import { randomBytes } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Acquired, Capabilities, DocStore, LockStore, SlotGrant, SlotStore, StateBackend, StoredDoc } from './types.ts';

interface DocFile<T> { value: T; etag: string; expiresAt: number | null }
interface LockFile { token: string; expiresAt: number; acquiredAt: number; completed: boolean }
interface SlotFile { leases: Record<string, number> }

const COMPLETED_RETENTION_MS = 30 * 86_400_000;
const LOCK_LIFETIME_MS = 86_400_000;

function encode(key: string): string {
  return encodeURIComponent(key).replaceAll('.', '%2E');
}

async function readJson<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  const temp = `${path}.${randomBytes(4).toString('hex')}.tmp`;
  await writeFile(temp, JSON.stringify(value));
  await rename(temp, path);
}

/**
 * A file-backed driver with the same semantics as the Ainoflow one, for tests and dry runs only.
 * Processes on one host serialise through a directory mutex.
 */
export function createFileBackend(dir: string, namespace: string): StateBackend {
  const base = join(dir, encode(namespace));
  const mutexPath = join(base, '.mutex');

  async function exclusive<T>(work: () => Promise<T>): Promise<T> {
    await mkdir(base, { recursive: true });
    const deadline = Date.now() + 10_000;
    for (;;) {
      try {
        await mkdir(mutexPath);
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        if (Date.now() > deadline) await rm(mutexPath, { recursive: true, force: true });
        await sleep(5);
      }
    }
    try {
      return await work();
    } finally {
      await rm(mutexPath, { recursive: true, force: true });
    }
  }

  const docPath = async (collection: string, key: string): Promise<string> => {
    const folder = join(base, 'docs', encode(collection));
    await mkdir(folder, { recursive: true });
    return join(folder, `${encode(key)}.json`);
  };
  const live = <T>(doc: DocFile<T> | undefined): DocFile<T> | undefined => (doc && (doc.expiresAt === null || doc.expiresAt > Date.now()) ? doc : undefined);
  const newEtag = (): string => randomBytes(8).toString('hex');

  const docs: DocStore = {
    async get<T>(collection: string, key: string): Promise<StoredDoc<T> | undefined> {
      const doc = live(await readJson<DocFile<T>>(await docPath(collection, key)));
      return doc ? { key, value: doc.value, etag: doc.etag } : undefined;
    },
    async create<T>(collection: string, key: string, value: T, ttlMs?: number): Promise<'created' | 'exists'> {
      return exclusive(async () => {
        const path = await docPath(collection, key);
        if (live(await readJson<DocFile<T>>(path))) return 'exists';
        await writeJson(path, { value, etag: newEtag(), expiresAt: ttlMs ? Date.now() + ttlMs : null });
        return 'created';
      });
    },
    async replace<T>(collection: string, key: string, value: T, options: { etag?: string; ttlMs?: number } = {}): Promise<'written' | 'conflict'> {
      return exclusive(async () => {
        const path = await docPath(collection, key);
        const current = live(await readJson<DocFile<T>>(path));
        if (options.etag !== undefined && current?.etag !== options.etag) return 'conflict';
        await writeJson(path, { value, etag: newEtag(), expiresAt: options.ttlMs ? Date.now() + options.ttlMs : null });
        return 'written';
      });
    },
    async list<T>(collection: string, filter: { prefix?: string; where?: Record<string, string> } = {}): Promise<{ key: string; value: T }[]> {
      const folder = join(base, 'docs', encode(collection));
      let names: string[];
      try { names = await readdir(folder); } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
        throw error;
      }
      const items: { key: string; value: T }[] = [];
      for (const name of names.filter((n) => n.endsWith('.json')).sort()) {
        const key = decodeURIComponent(name.slice(0, -5));
        if (filter.prefix && !key.startsWith(filter.prefix)) continue;
        const doc = live(await readJson<DocFile<T>>(join(folder, name)));
        if (!doc) continue;
        const record = doc.value as Record<string, unknown>;
        if (Object.entries(filter.where ?? {}).every(([field, expected]) => String(record[field]) === expected)) items.push({ key, value: doc.value });
      }
      return items;
    },
    async delete(collection: string, key: string): Promise<boolean> {
      return exclusive(async () => {
        const path = await docPath(collection, key);
        if (!live(await readJson<DocFile<unknown>>(path))) return false;
        await rm(path, { force: true });
        return true;
      });
    },
  };

  const lockPath = async (key: string): Promise<string> => {
    const folder = join(base, 'locks');
    await mkdir(folder, { recursive: true });
    return join(folder, `${encode(key)}.json`);
  };
  const liveLock = (lock: LockFile | undefined): LockFile | undefined => (lock && lock.expiresAt > Date.now() ? lock : undefined);

  const locks: LockStore = {
    async acquire(key: string, ttlMs: number): Promise<Acquired> {
      return exclusive(async () => {
        const path = await lockPath(key);
        if (liveLock(await readJson<LockFile>(path))) return { acquired: false };
        const token = randomBytes(16).toString('hex');
        const now = Date.now();
        await writeJson(path, { token, acquiredAt: now, expiresAt: now + Math.min(ttlMs, LOCK_LIFETIME_MS), completed: false });
        return { acquired: true, token };
      });
    },
    async renew(key: string, token: string, ttlMs: number): Promise<'renewed' | 'lost' | 'lifetime-exceeded'> {
      return exclusive(async () => {
        const path = await lockPath(key);
        const lock = liveLock(await readJson<LockFile>(path));
        if (!lock || lock.token !== token || lock.completed) return 'lost';
        const deadline = lock.acquiredAt + LOCK_LIFETIME_MS;
        if (Date.now() >= deadline) return 'lifetime-exceeded';
        await writeJson(path, { ...lock, expiresAt: Math.min(Date.now() + ttlMs, deadline) });
        return 'renewed';
      });
    },
    async complete(key: string, token: string): Promise<void> {
      await exclusive(async () => {
        const path = await lockPath(key);
        const lock = liveLock(await readJson<LockFile>(path));
        if (lock?.token === token) await writeJson(path, { ...lock, completed: true, expiresAt: Date.now() + COMPLETED_RETENTION_MS });
      });
    },
    async exists(key: string): Promise<boolean> {
      return liveLock(await readJson<LockFile>(await lockPath(key))) !== undefined;
    },
    async release(key: string): Promise<void> {
      await exclusive(async () => rm(await lockPath(key), { force: true }));
    },
  };

  const slotPath = async (key: string, global: boolean): Promise<string> => {
    const folder = join(global ? join(dir, '_global') : base, 'slots');
    await mkdir(folder, { recursive: true });
    return join(folder, `${encode(key)}.json`);
  };

  const slots: SlotStore = {
    async acquire(key: string, max: number, slotTtlMs: number, options: { global?: boolean } = {}): Promise<SlotGrant> {
      return exclusive(async () => {
        const path = await slotPath(key, options.global === true);
        const now = Date.now();
        const file = (await readJson<SlotFile>(path)) ?? { leases: {} };
        const leases = Object.fromEntries(Object.entries(file.leases).filter(([, expiresAt]) => expiresAt > now));
        if (Object.keys(leases).length >= max) {
          const earliest = Math.min(...Object.values(leases));
          return { granted: false, retryAfterMs: Math.max(1000, earliest - now) };
        }
        const token = randomBytes(16).toString('hex');
        leases[token] = now + slotTtlMs;
        await writeJson(path, { leases });
        return { granted: true, token };
      });
    },
    async release(key: string, token: string, options: { global?: boolean } = {}): Promise<void> {
      await exclusive(async () => {
        const path = await slotPath(key, options.global === true);
        const file = await readJson<SlotFile>(path);
        if (!file) return;
        delete file.leases[token];
        await writeJson(path, file);
      });
    },
  };

  return {
    kind: 'file',
    namespace,
    docs,
    locks,
    slots,
    capabilities: async (): Promise<Capabilities> => ({
      features: { storageIfMatch: true, storageWhereFilter: true, storageKeyPrefix: true, guardConcurrency: true },
      limits: { shieldLocksMonthly: 0, guardChecksMonthly: 0, storageDocumentCount: 0 },
    }),
  };
}
