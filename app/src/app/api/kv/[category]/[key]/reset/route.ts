import { NextResponse } from "next/server";
import { BaselineNotFoundError, BaselineUnsupportedError, loadBaselineValue } from "@/lib/baseline";
import { createAuditWriter } from "@/lib/audit-log";
import { applyReset } from "@/lib/kv-write";
import { isResponse, requireActiveKV } from "@/lib/require-active-kv";

interface RouteContext {
  readonly params: Promise<{ readonly category: string; readonly key: string }>;
}

/**
 * POST /api/kv/:category/:key/reset — revert a row to the shipped
 * baseline under `engine/content/`.
 *
 * Only works for `source: "content"` rows. Yaml-sourced rows are
 * rejected with HTTP 405 — the correct fix there is to edit
 * `config/repos.yaml` and restart the engine.
 *
 * Success: 200 `{ category, key, metadata, value }` — metadata reset to
 * `{ source: "content", readonly: false, modifiedFromBaseline: false,
 * version: prev+1 }`.
 */
export async function POST(_request: Request, ctx: RouteContext): Promise<NextResponse> {
  const resolved = await requireActiveKV();
  if (isResponse(resolved)) return resolved;

  const { category, key } = await ctx.params;
  const decodedKey = decodeURIComponent(key);

  let baselineValue: unknown;
  try {
    baselineValue = await loadBaselineValue(category, decodedKey);
  } catch (err) {
    if (err instanceof BaselineNotFoundError) {
      return NextResponse.json(
        { error: `No baseline for ${category}/${decodedKey}` },
        { status: 404 },
      );
    }
    if (err instanceof BaselineUnsupportedError) {
      return NextResponse.json(
        { error: `Reset not supported for category ${category}` },
        { status: 405 },
      );
    }
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }

  const audit = createAuditWriter(resolved.kv);
  const outcome = await applyReset({
    kv: resolved.kv,
    category,
    key: decodedKey,
    baselineValue,
    connectionId: resolved.connection.id,
    audit,
  });
  if (!outcome.ok) {
    return NextResponse.json(outcome.body, { status: outcome.status });
  }
  return NextResponse.json(outcome.result);
}
