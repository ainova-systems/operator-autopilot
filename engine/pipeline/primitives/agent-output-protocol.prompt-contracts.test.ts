import { readFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveContentPath } from "../../infra/content-path.js";
import {
  parseAgentOutput,
  partitionDiagnostics,
} from "./agent-output-protocol.js";

function extractMarkdownFenceContaining(markdown: string, needle: string): string {
  const fenceRe = /```[^\n]*\n([\s\S]*?)```/g;
  for (const match of markdown.matchAll(fenceRe)) {
    const body = match[1];
    if (body.includes(needle)) {
      return body.trimEnd();
    }
  }
  throw new Error(`no markdown fence contains ${needle}`);
}

/**
 * Contract tests over SHIPPED agent prompts under `engine/content/prompts/`.
 *
 * These read the real bundled files (no `OPERATOR_CONTENT_DIR` override) so a
 * future prompt edit that breaks the documented AOP examples trips here rather
 * than only in a live improver cycle.
 */
describe("parseAgentOutput — bundled prompt contracts", () => {
  let priorContentDir: string | undefined;

  beforeEach(() => {
    priorContentDir = process.env.OPERATOR_CONTENT_DIR;
    delete process.env.OPERATOR_CONTENT_DIR;
  });

  afterEach(() => {
    if (priorContentDir === undefined) delete process.env.OPERATOR_CONTENT_DIR;
    else process.env.OPERATOR_CONTENT_DIR = priorContentDir;
  });

  it("improver.md status-update example parses as a fenced AOP status-update event", async () => {
    const improverPath = resolveContentPath("prompts", "agents/improver.md");
    const improverMd = await readFile(improverPath, "utf-8");
    expect(improverMd).not.toMatch(/EMIT:/);

    const example = extractMarkdownFenceContaining(
      improverMd,
      "=== EMIT status-update ===",
    );
    const r = parseAgentOutput(example);

    expect(partitionDiagnostics(r.diagnostics).errors).toEqual([]);
    expect(r.events).toHaveLength(1);
    expect(r.events[0]).toMatchObject({
      type: "status-update",
      target: "F20260416-0002",
      status: "in-progress",
      reason: expect.any(String),
    });
    const reason = (r.events[0] as { reason: string }).reason;
    expect(reason.length).toBeGreaterThan(0);
  });
});
