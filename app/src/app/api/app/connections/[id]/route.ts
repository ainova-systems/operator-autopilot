import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { connectionPatchSchema } from "@/lib/connection-types";
import { deleteConnection, getConnection, updateConnection } from "@/lib/connections";

interface RouteContext {
  readonly params: Promise<{ readonly id: string }>;
}

export async function GET(_request: Request, ctx: RouteContext): Promise<NextResponse> {
  const { id } = await ctx.params;
  const connection = await getConnection(id);
  if (!connection) {
    return NextResponse.json({ error: "Connection not found" }, { status: 404 });
  }
  return NextResponse.json({ connection });
}

export async function PUT(request: Request, ctx: RouteContext): Promise<NextResponse> {
  const { id } = await ctx.params;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  try {
    const patch = connectionPatchSchema.parse(body);
    const updated = await updateConnection(id, patch);
    if (!updated) {
      return NextResponse.json({ error: "Connection not found" }, { status: 404 });
    }
    return NextResponse.json({ connection: updated });
  } catch (err) {
    if (err instanceof ZodError) {
      return NextResponse.json(
        { error: "Validation failed", issues: err.issues },
        { status: 400 },
      );
    }
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

export async function DELETE(_request: Request, ctx: RouteContext): Promise<NextResponse> {
  const { id } = await ctx.params;
  const ok = await deleteConnection(id);
  if (!ok) {
    return NextResponse.json({ error: "Connection not found" }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}
