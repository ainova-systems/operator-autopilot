import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { getActiveKV } from "@/lib/active-kv-registry";
import { loadAgentRequirements } from "@/lib/setup/agent-config-source";
import { probeEngineDb } from "@/lib/setup/db-probe";
import { checkGitHubToken } from "@/lib/setup/github-check";
import { preflightRequestSchema, runPreflight } from "@/lib/setup/preflight";
import { findOnPath } from "@/lib/setup/which";

/**
 * Host readiness for the guided setup screen.
 *
 * POST rather than GET because the body may carry a token the caller wants
 * validated without persisting it — it is used for the GitHub round-trip and
 * then dropped. Nothing from this request is written anywhere.
 *
 * An active connection is optional: the preflight has to work before one
 * exists, which is precisely when a first-time user needs it.
 */
export async function POST(request: Request): Promise<NextResponse> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  try {
    const input = preflightRequestSchema.parse(body);
    const active = await getActiveKV();
    const requirements = await loadAgentRequirements(active?.kv ?? null);

    const report = await runPreflight(input, {
      env: process.env,
      locate: (command) => findOnPath(command),
      requirements,
      probeDb: probeEngineDb,
      checkToken: (tokenInput) => checkGitHubToken(tokenInput, { fetchImpl: fetch }),
    });

    console.info(
      `setup-preflight: ${report.checks.length} check(s), ok=${report.ok}` +
        ` [${report.checks.map((c) => `${c.id}=${c.status}`).join(" ")}]`,
    );
    return NextResponse.json(report);
  } catch (err) {
    if (err instanceof ZodError) {
      return NextResponse.json({ error: "Validation failed", issues: err.issues }, { status: 400 });
    }
    console.error("setup-preflight failed", err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
