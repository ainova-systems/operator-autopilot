import { NextResponse } from "next/server";
import { isKnownCategory } from "@/lib/kv-write";
import { isResponse, requireActiveKV } from "@/lib/require-active-kv";

interface RouteContext {
  readonly params: Promise<{ readonly category: string }>;
}

/**
 * GET /api/kv/:category — list rows in a category with pagination.
 *
 * Query params:
 *   - `limit`  — max number of rows (default 200, capped at 500)
 *   - `offset` — 0-based offset
 *
 * Returns `{ items: [{key, value, metadata}], total, limit, offset }`.
 */
export async function GET(request: Request, ctx: RouteContext): Promise<NextResponse> {
  const resolved = await requireActiveKV();
  if (isResponse(resolved)) return resolved;

  const { category } = await ctx.params;
  if (!isKnownCategory(category)) {
    return NextResponse.json({ error: `Unknown category: ${category}` }, { status: 404 });
  }

  const url = new URL(request.url);
  const limit = clampLimit(url.searchParams.get("limit"));
  const offset = Math.max(0, parseInt(url.searchParams.get("offset") ?? "0", 10) || 0);

  const allEntries = await resolved.kv.list(category);
  const total = allEntries.length;
  const page = allEntries.slice(offset, offset + limit);

  return NextResponse.json({
    items: page.map((e) => ({ key: e.key, value: e.value, metadata: e.metadata ?? null })),
    total,
    limit,
    offset,
  });
}

function clampLimit(raw: string | null): number {
  const n = parseInt(raw ?? "200", 10);
  if (!Number.isFinite(n) || n <= 0) return 200;
  return Math.min(n, 500);
}
