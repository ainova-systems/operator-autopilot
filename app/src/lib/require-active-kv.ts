import { NextResponse } from "next/server";
import type { KVStore } from "@operator/core";
import type { Connection } from "./connection-types";
import { getActiveKV } from "./active-kv-registry";

/**
 * Resolve the active operator KVStore for a request. API routes that
 * mutate or list KV rows reject with HTTP 401 when no connection is
 * selected — same behavior the shell pages surface as the "No connection
 * selected" empty state.
 *
 * Returns either `{ kind: "active", kv, connection }` on success or a
 * ready-to-return `NextResponse` carrying the 401 payload. Callers
 * short-circuit:
 *
 *     const resolved = await requireActiveKV();
 *     if (isResponse(resolved)) return resolved;
 *     const { kv, connection } = resolved;
 */
export interface ActiveKVResolved {
  readonly kind: "active";
  readonly kv: KVStore;
  readonly connection: Connection;
}

export type RequireActiveKVResult = ActiveKVResolved | NextResponse;

export function isResponse(value: RequireActiveKVResult): value is NextResponse {
  return (value as ActiveKVResolved).kind !== "active";
}

export async function requireActiveKV(): Promise<RequireActiveKVResult> {
  const active = await getActiveKV();
  if (!active) {
    return NextResponse.json(
      { error: "No active connection. Select one in the left rail first." },
      { status: 401 },
    );
  }
  return { kind: "active", kv: active.kv, connection: active.connection };
}
