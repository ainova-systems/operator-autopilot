import { describe, it, expect } from "vitest";
import type { AgentEventDiagnostic } from "@operator/core";
import {
  parseAgentOutput,
  partitionDiagnostics,
} from "./agent-output-protocol.js";

// ── Helpers ──────────────────────────────────────────────────────────

function block(type: string, body: string): string {
  return `=== EMIT ${type} ===\n${body}\n=== END EMIT ===`;
}

// ── Empty / no-op input ──────────────────────────────────────────────

describe("parseAgentOutput — empty / no-op", () => {
  it("returns empty events on empty input", () => {
    const r = parseAgentOutput("");
    expect(r.events).toEqual([]);
    expect(r.diagnostics).toEqual([]);
  });

  it("ignores free-form text without any EMIT block", () => {
    const r = parseAgentOutput(
      "Some long explanation from the agent.\n\nRefactored basket logic; no further changes needed.",
    );
    expect(r.events).toEqual([]);
    expect(r.diagnostics).toEqual([]);
  });

  it("tolerates CRLF line endings", () => {
    const text = `=== EMIT verdict ===\r\nvalue: approved\r\nsummary: ok\r\n=== END EMIT ===\r\n`;
    const r = parseAgentOutput(text);
    expect(r.events).toHaveLength(1);
    expect(r.events[0]).toMatchObject({ type: "verdict", value: "approved", summary: "ok" });
  });
});

// ── Each EMIT type ───────────────────────────────────────────────────

describe("parseAgentOutput — every EMIT type", () => {
  it("parses child-item with all fields", () => {
    const text = block(
      "child-item",
      [
        "kind: task",
        "parent: F20260502-0001",
        "title: \"Add unit tests for hospitals search\"",
        "priority: 3",
        "source: planner",
        "body: |",
        "  Cover the regression case where",
        "  selector renders empty results.",
      ].join("\n"),
    );
    const r = parseAgentOutput(text);
    expect(r.diagnostics).toEqual([]);
    expect(r.events).toEqual([
      {
        type: "child-item",
        kind: "task",
        parent: "F20260502-0001",
        title: "Add unit tests for hospitals search",
        priority: 3,
        source: "planner",
        body: "Cover the regression case where\nselector renders empty results.\n",
      },
    ]);
  });

  it("parses child-item with body defaulting to empty string", () => {
    const text = block("child-item", "kind: task\nparent: self\ntitle: t");
    const r = parseAgentOutput(text);
    expect(r.diagnostics).toEqual([]);
    expect(r.events[0]).toMatchObject({ type: "child-item", body: "" });
  });

  it("parses status-update", () => {
    const text = block("status-update", "target: self\nstatus: in-progress\nreason: planning complete");
    const r = parseAgentOutput(text);
    expect(r.events[0]).toEqual({
      type: "status-update",
      target: "self",
      status: "in-progress",
      reason: "planning complete",
    });
  });

  it("parses body-update with default mergeStrategy", () => {
    const text = block("body-update", "target: T20260502-0001\nbody: \"Updated description\"");
    const r = parseAgentOutput(text);
    expect(r.events[0]).toEqual({
      type: "body-update",
      target: "T20260502-0001",
      body: "Updated description",
      mergeStrategy: "replace",
    });
  });

  it("parses note with explicit visibility", () => {
    const text = block("note", "target: F20260502-0001\nvisibility: pr-comment\nbody: heads-up");
    const r = parseAgentOutput(text);
    expect(r.events[0]).toEqual({
      type: "note",
      target: "F20260502-0001",
      visibility: "pr-comment",
      body: "heads-up",
    });
  });

  it("parses error with default recoverable=true", () => {
    const text = block("error", "code: ENV_BUILD_OFFLINE\nmessage: CI runner unreachable");
    const r = parseAgentOutput(text);
    expect(r.events[0]).toEqual({
      type: "error",
      code: "ENV_BUILD_OFFLINE",
      message: "CI runner unreachable",
      recoverable: true,
    });
  });

  it("parses recovery", () => {
    const text = block(
      "recovery",
      "target: T20260502-0001\naction: retry-with-context\ncontext: missing import detected",
    );
    const r = parseAgentOutput(text);
    expect(r.events[0]).toEqual({
      type: "recovery",
      target: "T20260502-0001",
      action: "retry-with-context",
      context: "missing import detected",
    });
  });

  it("parses verdict approved", () => {
    const text = block("verdict", "value: approved\nsummary: refactor complete");
    const r = parseAgentOutput(text);
    expect(r.events[0]).toEqual({
      type: "verdict",
      value: "approved",
      summary: "refactor complete",
    });
  });

  it("rejects verdict with invalid value", () => {
    const text = block("verdict", "value: maybe");
    const r = parseAgentOutput(text);
    expect(r.events).toEqual([]);
    expect(r.diagnostics[0].code).toBe("validation-failed");
  });
});

// ── Multiple events in order ─────────────────────────────────────────

describe("parseAgentOutput — multiple blocks", () => {
  it("collects events in the order they appear", () => {
    const text = [
      "Some prelude.",
      "",
      block("status-update", "target: self\nstatus: in-progress"),
      "",
      "Reasoning continues.",
      "",
      block("child-item", "kind: task\nparent: self\ntitle: t1"),
      block("child-item", "kind: task\nparent: self\ntitle: t2"),
      "",
      block("verdict", "value: approved"),
    ].join("\n");
    const r = parseAgentOutput(text);
    expect(r.diagnostics).toEqual([]);
    expect(r.events.map((e) => e.type)).toEqual([
      "status-update",
      "child-item",
      "child-item",
      "verdict",
    ]);
  });

  it("continues parsing after a malformed block", () => {
    const text = [
      block("status-update", "garbage{not yaml"),
      block("verdict", "value: approved"),
    ].join("\n\n");
    const r = parseAgentOutput(text);
    // First block fails YAML parse OR validation; second one lands.
    expect(r.events).toHaveLength(1);
    expect(r.events[0].type).toBe("verdict");
    expect(r.diagnostics.some((d) => d.severity === "error")).toBe(true);
  });
});

// ── Diagnostics ──────────────────────────────────────────────────────

describe("parseAgentOutput — diagnostics", () => {
  it("emits block-unclosed when END EMIT is missing", () => {
    const text = "=== EMIT verdict ===\nvalue: approved\n";
    const r = parseAgentOutput(text);
    expect(r.events).toEqual([]);
    expect(r.diagnostics[0]).toMatchObject({
      severity: "error",
      code: "block-unclosed",
      line: 1,
      emitType: "verdict",
    });
  });

  it("emits unknown-emit-type as warning + skips", () => {
    const text = block("future-thing", "field: 1");
    const r = parseAgentOutput(text);
    expect(r.events).toEqual([]);
    expect(r.diagnostics[0]).toMatchObject({
      severity: "warning",
      code: "unknown-emit-type",
      emitType: "future-thing",
    });
  });

  it("emits payload-not-mapping when YAML returns a scalar or array", () => {
    const text = block("verdict", "- approved");
    const r = parseAgentOutput(text);
    expect(r.events).toEqual([]);
    expect(r.diagnostics[0]).toMatchObject({
      code: "payload-not-mapping",
    });
  });

  it("emits validation-failed with field-level issues from Zod", () => {
    const text = block("child-item", "kind: task\nparent: self");  // missing title
    const r = parseAgentOutput(text);
    expect(r.events).toEqual([]);
    const d = r.diagnostics[0];
    expect(d.code).toBe("validation-failed");
    expect(d.message).toContain("title");
  });

  it("reports the start line for each block", () => {
    const text =
      "// preamble\n" +
      "// more preamble\n" +
      block("verdict", "value: garbage") +
      "\n";
    const r = parseAgentOutput(text);
    expect(r.diagnostics[0].line).toBe(3);
  });
});

// ── partitionDiagnostics ─────────────────────────────────────────────

describe("partitionDiagnostics", () => {
  it("splits errors and warnings", () => {
    const diagnostics: AgentEventDiagnostic[] = [
      { severity: "warning", code: "unknown-emit-type", line: 1, message: "warn" },
      { severity: "error", code: "validation-failed", line: 2, message: "err" },
      { severity: "error", code: "block-unclosed", line: 3, message: "err2" },
    ];
    const { errors, warnings } = partitionDiagnostics(diagnostics);
    expect(errors).toHaveLength(2);
    expect(warnings).toHaveLength(1);
    expect(errors.map((e) => e.code)).toEqual(["validation-failed", "block-unclosed"]);
  });

  it("returns empty arrays for empty input", () => {
    const r = partitionDiagnostics([]);
    expect(r.errors).toEqual([]);
    expect(r.warnings).toEqual([]);
  });
});

// ── Edge cases ───────────────────────────────────────────────────────

describe("parseAgentOutput — edge cases", () => {
  it("ignores stray END EMIT markers without a matching start", () => {
    const text = "=== END EMIT ===\nfree text\n=== END EMIT ===";
    const r = parseAgentOutput(text);
    expect(r.events).toEqual([]);
    expect(r.diagnostics).toEqual([]);
  });

  it("treats nested === inside YAML body literal as content (not a marker)", () => {
    const text = block(
      "note",
      [
        "target: self",
        "body: |",
        "  This is a doc with === ASCII art ===",
        "  inside it; should not break parsing.",
      ].join("\n"),
    );
    const r = parseAgentOutput(text);
    expect(r.diagnostics).toEqual([]);
    expect(r.events[0]).toMatchObject({
      type: "note",
      body: expect.stringContaining("=== ASCII art ==="),
    });
  });

  it("tolerates extra whitespace in start marker", () => {
    const text = "===   EMIT   verdict   ===\nvalue: approved\n=== END EMIT ===";
    const r = parseAgentOutput(text);
    expect(r.events).toHaveLength(1);
  });

  it("rejects child-item priority outside [1,8]", () => {
    const text = block("child-item", "kind: task\nparent: self\ntitle: t\npriority: 9");
    const r = parseAgentOutput(text);
    expect(r.events).toEqual([]);
    expect(r.diagnostics[0].code).toBe("validation-failed");
    expect(r.diagnostics[0].message).toContain("priority");
  });
});

// ── Frontmatter ownership boundary (F3.5) ────────────────────────────

describe("parseAgentOutput — raw-frontmatter-leak guard", () => {
  it("flags a leaked work-item frontmatter block outside any EMIT", () => {
    // Agent output that pre-AOP planners produced verbatim — this MUST
    // now be rejected so the prompt gets corrected to use EMIT child-item.
    const text = [
      "## Verdict: VALID",
      "",
      "---",
      "id: \"T20260502-000101\"",
      "kind: task",
      "status: pending",
      "priority: 3",
      "---",
      "",
      "# Task body",
    ].join("\n");
    const r = parseAgentOutput(text);
    expect(r.events).toEqual([]);
    expect(r.diagnostics).toHaveLength(1);
    const diag = r.diagnostics[0];
    expect(diag.code).toBe("raw-frontmatter-leak");
    expect(diag.severity).toBe("error");
    expect(diag.line).toBe(3);
    expect(diag.message).toContain("EMIT child-item");
    expect(diag.message).toContain("EMIT status-update");
  });

  it("identifies the offending frontmatter field by name in the message", () => {
    const text = "---\nstatus: in-progress\n---";
    const r = parseAgentOutput(text);
    expect(r.diagnostics[0].message).toContain("\"status\"");
  });

  it("triggers on parent_id leak too (one of the orchestrator-owned fields)", () => {
    const text = "---\nparent_id: F20260502-0001\nkind: task\n---";
    const r = parseAgentOutput(text);
    expect(r.diagnostics).toHaveLength(1);
    expect(r.diagnostics[0].code).toBe("raw-frontmatter-leak");
    expect(r.diagnostics[0].message).toContain("\"parent_id\"");
  });

  it("does NOT flag a `---` fence not followed by a frontmatter field within the lookahead window", () => {
    // Common case: markdown horizontal rule used as a section divider.
    // No work-item field name nearby → not a leak.
    const text = [
      "## Section A",
      "",
      "---",
      "",
      "## Section B",
      "",
      "Some prose.",
    ].join("\n");
    const r = parseAgentOutput(text);
    expect(r.diagnostics).toEqual([]);
  });

  it("does NOT flag frontmatter fields that appear inside a valid EMIT block payload", () => {
    // A child-item EMIT block carries `kind:`, `priority:`, etc. — the
    // legitimate orchestrator-bound shape. Guard runs only on lines
    // outside EMIT blocks, so these must not produce a leak diagnostic.
    const text = block("child-item", "kind: task\nparent: F1\ntitle: t\npriority: 3");
    const r = parseAgentOutput(text);
    expect(r.events).toHaveLength(1);
    expect(r.diagnostics).toEqual([]);
  });

  it("flags a leak that surrounds a valid EMIT block (mixed output)", () => {
    // Worst case: agent emitted both shapes. Parser still extracts the
    // valid EMIT block but ALSO surfaces the leak for prompt correction.
    const leak = "---\nstatus: pending\nkind: task\n---";
    const valid = block("verdict", "value: approved\nsummary: ok");
    const text = `${leak}\n\n${valid}`;
    const r = parseAgentOutput(text);
    expect(r.events).toHaveLength(1);
    expect(r.events[0]).toMatchObject({ type: "verdict", value: "approved" });
    const leaks = r.diagnostics.filter((d: AgentEventDiagnostic) => d.code === "raw-frontmatter-leak");
    expect(leaks).toHaveLength(1);
  });

  it("emits at most one leak diagnostic per fence (does not double-fire on each matching field)", () => {
    const text = "---\nstatus: pending\nid: T1\nkind: task\n---";
    const r = parseAgentOutput(text);
    const leaks = r.diagnostics.filter((d: AgentEventDiagnostic) => d.code === "raw-frontmatter-leak");
    expect(leaks).toHaveLength(1);
  });
});
