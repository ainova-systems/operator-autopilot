import { setTimeout as sleep } from 'node:timers/promises';
import { OperatorError } from '../errors.ts';
import type { Acquired, Capabilities, DocStore, LockStore, SlotGrant, SlotStore, StateBackend, StoredDoc } from './types.ts';

/** A refusal from the Ainoflow API, carrying its HTTP status and problem code. */
export class AinoflowError extends OperatorError {
  readonly status: number;
  readonly problemCode: string | undefined;
  readonly title: string | undefined;

  constructor(method: string, path: string, status: number, problem: { code?: string; title?: string }) {
    super('AINOFLOW_REQUEST_FAILED', `Ainoflow ${method} ${path} answered ${status}${problem.title ? `: ${problem.title}` : ''}`);
    this.status = status;
    this.problemCode = problem.code;
    this.title = problem.title;
  }
}

interface Response {
  status: number;
  headers: Headers;
  body: unknown;
}

export interface AinoflowOptions {
  apiKey: string;
  namespace: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

const GLOBAL_NAMESPACE = 'operator';
const PAGE_SIZE = 500;

/** Keys go into URL paths; they are limited to characters that survive routing unencoded. */
function checkKey(key: string): string {
  if (!/^[A-Za-z0-9._:-]+$/.test(key) || /^\.+$/.test(key)) throw new OperatorError('INVALID_STATE_KEY', `state key ${JSON.stringify(key)} may only use letters, digits, '.', '_', ':' and '-'`);
  return key;
}

export function createAinoflowBackend(options: AinoflowOptions): StateBackend {
  const baseUrl = (options.baseUrl ?? 'https://api.ainoflow.io').replace(/\/$/, '');
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const namespace = checkKey(options.namespace);
  const category = (collection: string): string => checkKey(`${namespace}.${collection}`);
  const scoped = (key: string, global = false): string => checkKey(`${global ? GLOBAL_NAMESPACE : namespace}.${key}`);

  /**
   * One HTTP call. Network failures and 5xx answers are retried twice with a short backoff; every
   * other status is returned to the caller, which decides what it means for that endpoint.
   */
  async function call(method: string, path: string, init: { query?: Record<string, string | number | boolean | string[] | undefined>; headers?: Record<string, string>; body?: unknown } = {}): Promise<Response> {
    // A lost answer to a POST (create, acquire, slot) or a tokenless DELETE leaves its outcome
    // unknown, and repeating it could take a second slot or delete a successor's lock; only reads
    // and PUTs are repeated.
    const attempts = method === 'GET' || method === 'PUT' ? 3 : 1;
    const url = new URL(`${baseUrl}${path}`);
    for (const [name, value] of Object.entries(init.query ?? {})) {
      if (value === undefined) continue;
      for (const item of Array.isArray(value) ? value : [value]) url.searchParams.append(name, String(item));
    }
    const headers: Record<string, string> = { Authorization: `Bearer ${options.apiKey}`, Accept: 'application/json', ...init.headers };
    if (init.body !== undefined) headers['Content-Type'] = 'application/json';
    let lastError: unknown;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (attempt > 0) await sleep(500 * 2 ** attempt);
      try {
        const response = await fetchImpl(url, {
          method,
          headers,
          signal: AbortSignal.timeout(timeoutMs),
          ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
        });
        const text = await response.text();
        const body: unknown = text === '' ? undefined : JSON.parse(text);
        if (response.status >= 500) { lastError = new AinoflowError(method, path, response.status, (body ?? {}) as { title?: string }); continue; }
        return { status: response.status, headers: response.headers, body };
      } catch (error) {
        lastError = error;
      }
    }
    throw new OperatorError('AINOFLOW_UNREACHABLE', `Ainoflow ${method} ${path} failed after ${attempts} attempt(s)`, { cause: lastError });
  }

  const fail = (method: string, path: string, response: Response): never => {
    throw new AinoflowError(method, path, response.status, (response.body ?? {}) as { code?: string; title?: string });
  };
  const itemPath = (collection: string, key: string): string => `/api/v1/storage/json/${category(collection)}/${checkKey(key)}`;
  const ttlQuery = (ttlMs: number | undefined): Record<string, number | undefined> => ({ expiresMs: ttlMs && ttlMs > 0 ? Math.round(ttlMs) : undefined });

  const docs: DocStore = {
    async get<T>(collection: string, key: string): Promise<StoredDoc<T> | undefined> {
      const path = itemPath(collection, key);
      const response = await call('GET', path);
      if (response.status === 404) return undefined;
      if (response.status !== 200) return fail('GET', path, response);
      const etag = response.headers.get('etag');
      if (!etag) throw new OperatorError('AINOFLOW_PROTOCOL', `Ainoflow GET ${path} returned no ETag`);
      return { key, value: response.body as T, etag };
    },
    async create<T>(collection: string, key: string, value: T, ttlMs?: number): Promise<'created' | 'exists'> {
      const path = itemPath(collection, key);
      const response = await call('POST', path, { query: ttlQuery(ttlMs), body: value });
      if (response.status === 201) return 'created';
      if (response.status === 409) return 'exists';
      return fail('POST', path, response);
    },
    async replace<T>(collection: string, key: string, value: T, replaceOptions: { etag?: string; ttlMs?: number } = {}): Promise<'written' | 'conflict'> {
      const path = itemPath(collection, key);
      const headers: Record<string, string> = replaceOptions.etag === undefined ? {} : { 'If-Match': replaceOptions.etag.startsWith('"') || replaceOptions.etag.startsWith('W/') ? replaceOptions.etag : `"${replaceOptions.etag}"` };
      const response = await call('PUT', path, { query: ttlQuery(replaceOptions.ttlMs), headers, body: value });
      if (response.status === 200 || response.status === 201) return 'written';
      if (response.status === 409 || response.status === 412) return 'conflict';
      // A conditional write on a key that vanished meanwhile (its TTL ran out) did not apply: the
      // caller reads again, exactly as after any other lost compare-and-set.
      if (replaceOptions.etag !== undefined && (response.status === 404 || response.status === 428)) return 'conflict';
      return fail('PUT', path, response);
    },
    async list<T>(collection: string, filter: { prefix?: string; where?: Record<string, string> } = {}): Promise<{ key: string; value: T }[]> {
      const path = `/api/v1/storage/json/${category(collection)}`;
      const where = Object.entries(filter.where ?? {}).map(([field, value]) => `${field}:${value}`);
      const items: { key: string; value: T }[] = [];
      for (let page = 1; ; page += 1) {
        const response = await call('GET', path, { query: { page, limit: PAGE_SIZE, sortBy: 'createdAt', sortOrder: 'asc', prefix: filter.prefix, where } });
        if (response.status === 404) return items;
        if (response.status !== 200) return fail('GET', path, response);
        const batch = response.body as { key: string; value: T }[];
        items.push(...batch.map((item) => ({ key: item.key, value: item.value })));
        if (batch.length < PAGE_SIZE) return items;
      }
    },
    async delete(collection: string, key: string): Promise<boolean> {
      const path = itemPath(collection, key);
      const response = await call('DELETE', path);
      if (response.status === 200) return true;
      if (response.status === 404) return false;
      return fail('DELETE', path, response);
    },
  };

  const lockPath = (key: string): string => `/api/v1/shield/${scoped(key)}`;
  const seconds = (ms: number): number => Math.max(1, Math.round(ms / 1000));

  const locks: LockStore = {
    async acquire(key: string, ttlMs: number, reference?: string): Promise<Acquired> {
      const path = lockPath(key);
      const response = await call('POST', path, { query: { ttl: seconds(ttlMs), returnSuccess: true, reference } });
      if (response.status === 200 || response.status === 201) {
        const body = response.body as { acquired?: boolean; token?: string | null };
        return body.acquired === true && typeof body.token === 'string' ? { acquired: true, token: body.token } : { acquired: false };
      }
      return fail('POST', path, response);
    },
    async renew(key: string, token: string, ttlMs: number): Promise<'renewed' | 'lost' | 'lifetime-exceeded'> {
      const path = `${lockPath(key)}/renew`;
      const response = await call('PUT', path, { query: { ttl: seconds(ttlMs) }, headers: { 'X-Shield-Token': token } });
      if (response.status === 200) return 'renewed';
      if (response.status === 404) return 'lost';
      if (response.status === 409) return /lifetime/i.test((response.body as { title?: string } | undefined)?.title ?? '') ? 'lifetime-exceeded' : 'lost';
      return fail('PUT', path, response);
    },
    async complete(key: string, token: string): Promise<void> {
      const path = `${lockPath(key)}/complete`;
      const response = await call('PUT', path, { headers: { 'X-Shield-Token': token } });
      if (response.status !== 200) fail('PUT', path, response);
    },
    async exists(key: string): Promise<boolean> {
      const path = lockPath(key);
      const response = await call('GET', path, { query: { allowEmpty: true } });
      if (response.status !== 200) return fail('GET', path, response);
      return (response.body as { exists?: boolean } | undefined)?.exists === true;
    },
    async release(key: string): Promise<void> {
      const path = lockPath(key);
      const response = await call('DELETE', path);
      if (response.status !== 200 && response.status !== 404) fail('DELETE', path, response);
    },
  };

  const slots: SlotStore = {
    async acquire(key: string, max: number, slotTtlMs: number, slotOptions: { global?: boolean } = {}): Promise<SlotGrant> {
      const path = `/api/v1/guard/${scoped(key, slotOptions.global)}/counter`;
      const response = await call('POST', path, { query: { concurrencyMax: max, slotTtl: seconds(slotTtlMs), returnSuccess: true, allowPolicyOverwrite: true } });
      if (response.status !== 200) return fail('POST', path, response);
      const body = response.body as { allowed?: boolean; retryAfter?: number | null; concurrency?: { slotToken?: string | null } | null };
      const token = body.concurrency?.slotToken;
      if (body.allowed === true && typeof token === 'string') return { granted: true, token };
      if (body.allowed === true) throw new OperatorError('AINOFLOW_PROTOCOL', `Guard allowed ${key} without a slot token (fail-open?)`);
      return { granted: false, retryAfterMs: Math.max(1, body.retryAfter ?? 30) * 1000 };
    },
    async release(key: string, token: string, slotOptions: { global?: boolean } = {}): Promise<void> {
      const path = `/api/v1/guard/${scoped(key, slotOptions.global)}/slot/release`;
      const response = await call('PUT', path, { headers: { 'X-Guard-Slot-Token': token } });
      if (response.status !== 200 && response.status !== 404) fail('PUT', path, response);
    },
  };

  return {
    kind: 'ainoflow',
    namespace,
    docs,
    locks,
    slots,
    async capabilities(): Promise<Capabilities> {
      const response = await call('GET', '/api/v1/capabilities');
      if (response.status !== 200) return fail('GET', '/api/v1/capabilities', response);
      const body = response.body as Record<string, unknown>;
      const features: Record<string, boolean> = {};
      for (const [name, value] of Object.entries(body)) if (typeof value === 'boolean') features[name] = value;
      const limits = (body['limits'] ?? {}) as Record<string, number | null>;
      return { features, limits };
    },
  };
}
