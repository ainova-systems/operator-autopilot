import { randomUUID } from "node:crypto";

// Server-only — writes to the app-internal KVStore singleton.
import {
  activeConnectionStateSchema,
  connectionInputSchema,
  connectionPatchSchema,
  connectionSchema,
  type ActiveConnectionState,
  type Connection,
  type ConnectionInput,
  type ConnectionPatch,
} from "./connection-types";
import { getAppKV } from "./app-kv";
import { createTransientKVStore } from "./kv-factory";

const CATEGORY_CONNECTIONS = "connections";
const CATEGORY_APP_STATE = "app-state";
const KEY_LAST_ACTIVE = "last-active";

/**
 * Server-only CRUD operations against the app-internal KVStore.
 *
 * Validates input through Zod schemas at every write. Never touches the
 * active operator instance's KV — that is `/api/kv/*`'s job (Step 16).
 * See architecture-v5.md §15a.3 for the two-surface separation.
 */

export async function listConnections(): Promise<Connection[]> {
  const kv = getAppKV();
  const entries = await kv.list(CATEGORY_CONNECTIONS);
  return entries.map((e) => connectionSchema.parse(e.value));
}

export async function getConnection(id: string): Promise<Connection | null> {
  const kv = getAppKV();
  const entry = await kv.get(CATEGORY_CONNECTIONS, id);
  return entry ? connectionSchema.parse(entry.value) : null;
}

export async function createConnection(input: ConnectionInput): Promise<Connection> {
  const parsed = connectionInputSchema.parse(input);
  const kv = getAppKV();
  const conn: Connection = {
    id: randomUUID(),
    name: parsed.name,
    dbPath: parsed.dbPath,
    createdAt: new Date().toISOString(),
  };
  await kv.put(CATEGORY_CONNECTIONS, conn.id, conn, {
    metadata: { source: "ui", readonly: false },
  });
  return conn;
}

export async function updateConnection(id: string, patch: ConnectionPatch): Promise<Connection | null> {
  const parsedPatch = connectionPatchSchema.parse(patch);
  const existing = await getConnection(id);
  if (!existing) return null;
  const next: Connection = {
    ...existing,
    ...parsedPatch,
    lastUsedAt: existing.lastUsedAt,
  };
  const kv = getAppKV();
  await kv.put(CATEGORY_CONNECTIONS, id, next, {
    metadata: { source: "ui", readonly: false },
  });
  return next;
}

export async function deleteConnection(id: string): Promise<boolean> {
  const existing = await getConnection(id);
  if (!existing) return false;
  const kv = getAppKV();
  await kv.delete(CATEGORY_CONNECTIONS, id);
  const active = await getActiveConnectionState();
  if (active?.id === id) {
    await kv.delete(CATEGORY_APP_STATE, KEY_LAST_ACTIVE);
  }
  return true;
}

export interface ConnectionTestResult {
  readonly ok: boolean;
  readonly message: string;
}

export async function testConnection(input: ConnectionInput): Promise<ConnectionTestResult> {
  const parsed = connectionInputSchema.parse(input);
  let store: ReturnType<typeof createTransientKVStore> | null = null;
  try {
    store = createTransientKVStore(parsed);
    await store.list("work-items", { limit: 1 });
    return { ok: true, message: "Connection OK" };
  } catch (err) {
    return {
      ok: false,
      message: err instanceof Error ? err.message : String(err),
    };
  } finally {
    store?.close();
  }
}

export async function setActiveConnection(id: string): Promise<ActiveConnectionState | null> {
  const existing = await getConnection(id);
  if (!existing) return null;
  const state: ActiveConnectionState = { id, at: new Date().toISOString() };
  const kv = getAppKV();
  await kv.put(CATEGORY_APP_STATE, KEY_LAST_ACTIVE, state, {
    metadata: { source: "ui", readonly: false },
  });
  const touched: Connection = { ...existing, lastUsedAt: state.at };
  await kv.put(CATEGORY_CONNECTIONS, id, touched, {
    metadata: { source: "ui", readonly: false },
  });
  return state;
}

export async function getActiveConnectionState(): Promise<ActiveConnectionState | null> {
  const kv = getAppKV();
  const entry = await kv.get(CATEGORY_APP_STATE, KEY_LAST_ACTIVE);
  if (!entry) return null;
  return activeConnectionStateSchema.parse(entry.value);
}

export async function getActiveConnection(): Promise<Connection | null> {
  const state = await getActiveConnectionState();
  if (!state) return null;
  return getConnection(state.id);
}

/**
 * Remove the active-connection pointer without touching any connection row.
 * Used by the "Disconnect" button on `/connections` so the shell can
 * return to the empty state without removing a saved connection.
 */
export async function clearActiveConnection(): Promise<void> {
  const kv = getAppKV();
  await kv.delete(CATEGORY_APP_STATE, KEY_LAST_ACTIVE);
}
