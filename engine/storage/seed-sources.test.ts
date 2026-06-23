import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadAgentProviders } from "./seed-sources.js";

/**
 * Contract tests over the SHIPPED `engine/content/defaults/agents.yaml`.
 *
 * These read the real bundled file (no `OPERATOR_CONTENT_DIR` override) so a
 * future edit to the shipped provider config that drops a Windows-critical
 * flag trips here rather than only in a live cycle on a Windows host.
 */
describe("loadAgentProviders (shipped agents.yaml contract)", () => {
  let priorContentDir: string | undefined;

  beforeEach(() => {
    // Read the real shipped content, not any harness override another test left.
    priorContentDir = process.env.OPERATOR_CONTENT_DIR;
    delete process.env.OPERATOR_CONTENT_DIR;
  });

  afterEach(() => {
    if (priorContentDir === undefined) delete process.env.OPERATOR_CONTENT_DIR;
    else process.env.OPERATOR_CONTENT_DIR = priorContentDir;
  });

  function entryFor(candidates: Awaited<ReturnType<typeof loadAgentProviders>>, id: string) {
    const found = candidates.find((c) => c.key === id);
    if (!found) throw new Error(`provider ${id} missing from shipped agents.yaml`);
    return found.entry as Record<string, unknown>;
  }

  it("emits one candidate per provider plus the synthetic _default pointer", async () => {
    const candidates = await loadAgentProviders();
    const keys = candidates.map((c) => c.key);
    expect(keys).toContain("claude");
    expect(keys).toContain("cursor");
    expect(keys).toContain("_default");
  });

  // Regression: the cursor provider shipped WITHOUT `promptFromStdin`, so the
  // code-writing roles (creator / improver / supervisor) passed the whole
  // folded system+user prompt in argv. cursor-agent has no system-prompt flag,
  // so the body folds to 70 KB+ on context-heavy runs (the weekly retrospective
  // improver) and blew past the Windows ~32 KB argv limit with `spawn
  // ENAMETOOLONG`, failing the retrospective stage. Piping via stdin is the fix;
  // this pins it so a future edit that drops the flag re-trips here.
  it("pipes the cursor prompt via stdin so large folded prompts dodge the Windows argv limit", async () => {
    const cursor = entryFor(await loadAgentProviders(), "cursor");
    expect(cursor.promptFromStdin).toBe(true);
  });

  it("keeps the claude provider on stdin as well (both writers exceed argv on big prompts)", async () => {
    const claude = entryFor(await loadAgentProviders(), "claude");
    expect(claude.promptFromStdin).toBe(true);
  });
});
