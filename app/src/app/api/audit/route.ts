import { NextResponse } from "next/server";
import { listAuditLog } from "@/lib/audit-log";
import { isResponse, requireActiveKV } from "@/lib/require-active-kv";

/**
 * GET /api/audit — list config-edit events from the active connection's
 * KV. Query params: `category`, `key`, `limit`, `offset`.
 *
 * The audit page consumes this to render before/after diffs. Events are
 * newest-first and filtered to `op: "config-edit"` so engine-authored
 * execution events do not leak in.
 */
export async function GET(request: Request): Promise<NextResponse> {
  const resolved = await requireActiveKV();
  if (isResponse(resolved)) return resolved;

  const url = new URL(request.url);
  const category = url.searchParams.get("category") ?? undefined;
  const key = url.searchParams.get("key") ?? undefined;
  const limit = clampLimit(url.searchParams.get("limit"));
  const offset = Math.max(0, parseInt(url.searchParams.get("offset") ?? "0", 10) || 0);

  const rows = await listAuditLog(resolved.kv, { category, key, limit, offset });
  return NextResponse.json({ items: rows, total: rows.length, limit, offset });
}

function clampLimit(raw: string | null): number {
  const n = parseInt(raw ?? "100", 10);
  if (!Number.isFinite(n) || n <= 0) return 100;
  return Math.min(n, 500);
}
