import { NextResponse } from "next/server";
import { z, ZodError } from "zod";
import { clearActiveConnection, getActiveConnectionState, setActiveConnection } from "@/lib/connections";

const setActiveSchema = z.object({ id: z.string().min(1) });

export async function GET(): Promise<NextResponse> {
  const state = await getActiveConnectionState();
  return NextResponse.json({ active: state });
}

export async function PUT(request: Request): Promise<NextResponse> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  try {
    const { id } = setActiveSchema.parse(body);
    const state = await setActiveConnection(id);
    if (!state) {
      return NextResponse.json({ error: "Connection not found" }, { status: 404 });
    }
    return NextResponse.json({ active: state });
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

/**
 * DELETE /api/app/active-connection — clear the active-connection pointer
 * so the shell lands on the empty state. Added in Step 16 to back the
 * "Disconnect" button on `/connections`.
 */
export async function DELETE(): Promise<NextResponse> {
  await clearActiveConnection();
  return NextResponse.json({ active: null });
}
