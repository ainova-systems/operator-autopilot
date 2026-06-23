import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { connectionInputSchema } from "@/lib/connection-types";
import { createConnection, listConnections } from "@/lib/connections";

export async function GET(): Promise<NextResponse> {
  const connections = await listConnections();
  return NextResponse.json({ connections });
}

export async function POST(request: Request): Promise<NextResponse> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  try {
    const input = connectionInputSchema.parse(body);
    const connection = await createConnection(input);
    return NextResponse.json({ connection }, { status: 201 });
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
