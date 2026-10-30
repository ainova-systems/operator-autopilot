/**
 * The runtime's one state interface. Every key and collection is relative to the backend's
 * namespace; a native Ainoflow feature replaces a driver method without touching its callers.
 */
export interface StoredDoc<T> {
  key: string;
  value: T;
  etag: string;
}

export interface DocStore {
  get<T>(collection: string, key: string): Promise<StoredDoc<T> | undefined>;
  /** Create-only: answers `exists` when the key is already taken, which is how dedupe works. */
  create<T>(collection: string, key: string, value: T, ttlMs?: number): Promise<'created' | 'exists'>;
  /**
   * With `etag`, writes only if the document is unchanged and answers `conflict` otherwise. With
   * `missingIsConflict`, a document that vanished meanwhile is a conflict too, for callers that read
   * again after one; without it a provider may refuse that write as an error.
   */
  replace<T>(collection: string, key: string, value: T, options?: { etag?: string; ttlMs?: number; missingIsConflict?: boolean }): Promise<'written' | 'conflict'>;
  list<T>(collection: string, filter?: { prefix?: string; where?: Record<string, string> }): Promise<{ key: string; value: T }[]>;
  delete(collection: string, key: string): Promise<boolean>;
}

export type Acquired = { acquired: true; token: string } | { acquired: false };

export interface LockStore {
  acquire(key: string, ttlMs: number, reference?: string): Promise<Acquired>;
  renew(key: string, token: string, ttlMs: number): Promise<'renewed' | 'lost' | 'lifetime-exceeded'>;
  /** Marks the key done; a completed key answers every later acquire as a duplicate. */
  complete(key: string, token: string): Promise<void>;
  exists(key: string): Promise<boolean>;
  /** Releases without completing, so the key can be acquired again at once. */
  release(key: string): Promise<void>;
}

export type SlotGrant = { granted: true; token: string } | { granted: false; retryAfterMs: number };

export interface SlotStore {
  /** A counting semaphore: at most `max` live slots per key, each expiring after `slotTtlMs`. */
  acquire(key: string, max: number, slotTtlMs: number, options?: { global?: boolean }): Promise<SlotGrant>;
  release(key: string, token: string, options?: { global?: boolean }): Promise<void>;
}

export interface Capabilities {
  features: Record<string, boolean>;
  limits: Record<string, number | null>;
}

export interface StateBackend {
  readonly kind: 'ainoflow' | 'file';
  readonly namespace: string;
  readonly docs: DocStore;
  readonly locks: LockStore;
  readonly slots: SlotStore;
  capabilities(): Promise<Capabilities>;
}
