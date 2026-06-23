import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { LocalStorageBundle } from "@operator/adapters/kvstore-sqlite";
import type { KVStore } from "@operator/core";
import { resolveAppDbPath } from "./env-paths";

// Server-only module — uses Node built-ins and must never ship to the
// browser bundle. Enforced structurally: nothing under app/src/lib imports
// React; the `(shell)` pages reach in through server component boundaries.

/**
 * Module-level singleton for the app's internal KVStore.
 *
 * Stores connection registry, active-connection pointer, and UI preferences
 * at `${OPERATOR_APP_DB_PATH ?? envPaths('operator-app').config + '/app.db'}`.
 *
 * This KVStore is completely separate from any operator instance's state —
 * see architecture-v5.md §15a for the two-KVStore design.
 */
let instance: LocalStorageBundle | null = null;

export function getAppKV(): KVStore {
  if (instance) return instance;
  const dbPath = resolveAppDbPath();
  mkdirSync(dirname(dbPath), { recursive: true });
  instance = new LocalStorageBundle({ dbPath });
  return instance;
}

/**
 * Test-only: close and clear the singleton so the next `getAppKV()` call
 * opens a fresh bundle. Used in unit tests that redirect `OPERATOR_APP_DB_PATH`
 * per test and need to release SQLite's WAL lock on the previous file.
 *
 * Never call from production code.
 */
export function __resetAppKV(): void {
  instance?.close();
  instance = null;
}
