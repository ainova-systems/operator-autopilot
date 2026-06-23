import type { KVStore } from "@operator/core";

// Server-only — holds live KVStore handles for the Next.js process.
import type { Connection } from "./connection-types";
import { createKVStoreForConnection } from "./kv-factory";
import { getActiveConnection, listConnections, setActiveConnection } from "./connections";

/**
 * Lazy map of connection-id → active KVStore instance.
 *
 * A connection's KVStore is created on first access and cached for the
 * lifetime of the Next.js process. Switching active connections keeps both
 * alive so re-opening a past selection is instant. Process restart drops
 * the cache (trivial cold-start; SQLite file on disk is untouched).
 */
const mounted = new Map<string, KVStore>();

function mount(conn: Connection): KVStore {
  const existing = mounted.get(conn.id);
  if (existing) return existing;
  const kv = createKVStoreForConnection(conn);
  mounted.set(conn.id, kv);
  return kv;
}

/**
 * Test-only: close every mounted KVStore, drop the cache, and clear the
 * memoized auto-provision promise so the next `getActiveKV()` call starts
 * fresh. Used by unit tests that swap env vars between cases.
 *
 * Never call from production code.
 */
export function __resetActiveKVRegistry(): void {
  for (const kv of mounted.values()) {
    kv.close();
  }
  mounted.clear();
  autoProvisionPromise = null;
}

/**
 * Return the KVStore of the currently-active connection, or `null` when
 * no connection is selected (empty app state). Callers render an empty
 * state in that case.
 */
export async function getActiveKV(): Promise<
  { kv: KVStore; connection: Connection } | null
> {
  await autoProvisionFromEnv();
  const active = await getActiveConnection();
  if (!active) return null;
  return { kv: mount(active), connection: active };
}

/**
 * Dev-convenience bootstrap per architecture-v5.md §15a.4.
 *
 * If `OPERATOR_DB_PATH` is set AND the connections registry is empty,
 * create a connection named `default` pointing at that path and mark it
 * active. Subsequent calls are a no-op — the active connection is always
 * read from KV via `getActiveConnection()`, so user-initiated switches in
 * the UI take effect immediately.
 *
 * Memoized per process: concurrent callers share the same in-flight
 * promise so we never race two `createConnection` calls on first load.
 */
let autoProvisionPromise: Promise<void> | null = null;

async function autoProvisionFromEnv(): Promise<void> {
  if (autoProvisionPromise) return autoProvisionPromise;
  const envPath = process.env["OPERATOR_DB_PATH"];
  if (!envPath) return;

  autoProvisionPromise = (async () => {
    const existing = await listConnections();
    if (existing.length > 0) return;
    const { createConnection } = await import("./connections");
    const conn = await createConnection({ name: "default", dbPath: envPath });
    await setActiveConnection(conn.id);
  })();
  return autoProvisionPromise;
}
