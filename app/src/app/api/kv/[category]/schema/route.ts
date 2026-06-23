import { NextResponse } from "next/server";
import { z } from "zod";
import { isKnownCategory, schemaForCategory } from "@/lib/kv-write";
import { isResponse, requireActiveKV } from "@/lib/require-active-kv";

interface RouteContext {
  readonly params: Promise<{ readonly category: string }>;
}

/**
 * GET /api/kv/:category/schema — return the Zod schema for the category
 * rendered as a JSON Schema document. The client JSON editor uses it to
 * seed validation hints (Monaco's JSON schema integration reads the
 * `$schema` draft the same way).
 */
export async function GET(_request: Request, ctx: RouteContext): Promise<NextResponse> {
  const resolved = await requireActiveKV();
  if (isResponse(resolved)) return resolved;

  const { category } = await ctx.params;
  if (!isKnownCategory(category)) {
    return NextResponse.json({ error: `Unknown category: ${category}` }, { status: 404 });
  }
  const schema = schemaForCategory(category);
  if (!schema) {
    return NextResponse.json({ error: `No schema for category: ${category}` }, { status: 404 });
  }
  const jsonSchema = z.toJSONSchema(schema);
  return NextResponse.json({ category, schema: jsonSchema });
}
