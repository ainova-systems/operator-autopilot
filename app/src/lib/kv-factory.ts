import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { LocalStorageBundle } from "@operator/adapters/kvstore-sqlite";
import type { KVStore } from "@operator/core";
import type { Connection, ConnectionInput } from "./connection-types";

// Server-only — imports a Node native module (better-sqlite3).

/**
 * Single backend choke point for the app.
 *
 * MVP has only one adapter (`LocalStorageBundle`), so this is a one-line
 * factory. When a second backend lands, the whole factory grows a switch
 * on `conn.backend` (or similar discriminator) AND `Connection` gets
 * rewritten into a union in the same PR. Until then there is no switch,
 * no "future" enum value, no backend field on Connection.
 *
 * See architecture-v5.md §15a.2 and invariant 13 (no future-shaped code).
 */
export function createKVStoreForConnection(conn: Connection): KVStore {
  mkdirSync(dirname(conn.dbPath), { recursive: true });
  return new LocalStorageBundle({ dbPath: conn.dbPath });
}

/**
 * Temporary KVStore from an unsaved {@link ConnectionInput}. Used by
 * `testConnection` to probe a path before persisting a Connection record —
 * the caller is responsible for `close()`ing the returned store.
 */
export function createTransientKVStore(input: ConnectionInput): KVStore {
  mkdirSync(dirname(input.dbPath), { recursive: true });
  return new LocalStorageBundle({ dbPath: input.dbPath });
}
