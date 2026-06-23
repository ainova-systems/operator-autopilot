import { NextResponse } from "next/server";
import { createAuditWriter } from "@/lib/audit-log";
import { applyDelete, applyPut, MAX_ROW_BYTES } from "@/lib/kv-write";
import { isResponse, requireActiveKV } from "@/lib/require-active-kv";

interface RouteContext {
  readonly params: Promise<{ readonly category: string; readonly key: string }>;
}

/**
 * GET /api/kv/:category/:key — return `{ value, metadata }` for one row.
 */
export async function GET(_request: Request, ctx: RouteContext): Promise<NextResponse> {
  const resolved = await requireActiveKV();
  if (isResponse(resolved)) return resolved;

  const { category, key } = await ctx.params;
  const decodedKey = decodeURIComponent(key);
  const entry = await resolved.kv.get(category, decodedKey);
  if (!entry) {
    return NextResponse.json({ error: `Row ${category}/${decodedKey} not found` }, { status: 404 });
  }
  return NextResponse.json({
    key: entry.key,
    value: entry.value,
    metadata: entry.metadata ?? null,
  });
}

/**
 * PUT /api/kv/:category/:key — write a new value with optimistic version check.
 *
 * Body:
 *   - `value`           — required, the payload to store
 *   - `expectedVersion` — optional, must match `metadata.version` of the
 *                          existing row (treated as 0 when the row is new
 *                          or was never versioned)
 *
 * Alternative `If-Match: <version>` header is accepted for the same
 * semantics and takes precedence over the body field when both are set.
 *
 * Success: 200 `{ category, key, metadata, value }`.
 * Failures: 400 (validation), 401 (no connection), 403 (readonly), 404
 * (unknown category), 409 (version mismatch), 413 (payload too large).
 */
export async function PUT(request: Request, ctx: RouteContext): Promise<NextResponse> {
  const resolved = await requireActiveKV();
  if (isResponse(resolved)) return resolved;

  const { category, key } = await ctx.params;
  const decodedKey = decodeURIComponent(key);

  const contentLength = parseContentLength(request.headers.get("content-length"));
  if (contentLength !== null && contentLength > MAX_ROW_BYTES) {
    return NextResponse.json(
      { error: `Payload exceeds ${MAX_ROW_BYTES}-byte limit` },
      { status: 413 },
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const bodyObj = body as { value?: unknown; expectedVersion?: number };
  if (!isRecord(body) || bodyObj.value === undefined) {
    return NextResponse.json({ error: "Body must be { value, expectedVersion? }" }, { status: 400 });
  }

  const ifMatchHeader = request.headers.get("if-match");
  const expectedVersion = resolveExpectedVersion(ifMatchHeader, bodyObj.expectedVersion);

  const audit = createAuditWriter(resolved.kv);
  const outcome = await applyPut({
    kv: resolved.kv,
    category,
    key: decodedKey,
    value: bodyObj.value,
    expectedVersion,
    connectionId: resolved.connection.id,
    audit,
  });

  if (!outcome.ok) {
    return NextResponse.json(outcome.body, { status: outcome.status });
  }
  return NextResponse.json(outcome.result);
}

/**
 * DELETE /api/kv/:category/:key — remove a row.
 *
 * Success: 200 `{ category, key }`.
 * Failures: 401, 403 (readonly), 404.
 */
export async function DELETE(_request: Request, ctx: RouteContext): Promise<NextResponse> {
  const resolved = await requireActiveKV();
  if (isResponse(resolved)) return resolved;

  const { category, key } = await ctx.params;
  const decodedKey = decodeURIComponent(key);

  const audit = createAuditWriter(resolved.kv);
  const outcome = await applyDelete({
    kv: resolved.kv,
    category,
    key: decodedKey,
    connectionId: resolved.connection.id,
    audit,
  });
  if (!outcome.ok) {
    return NextResponse.json(outcome.body, { status: outcome.status });
  }
  return NextResponse.json(outcome.result);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function parseContentLength(raw: string | null): number | null {
  if (!raw) return null;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : null;
}

function resolveExpectedVersion(header: string | null, body: unknown): number | null {
  if (header !== null) {
    const n = parseInt(header, 10);
    return Number.isFinite(n) ? n : null;
  }
  if (typeof body === "number" && Number.isFinite(body)) return body;
  return null;
}

