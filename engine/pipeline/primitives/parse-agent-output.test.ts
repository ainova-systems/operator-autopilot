import { describe, it, expect } from "vitest";
import { AgentError } from "@operator/core";
import { parseAgentOutput } from "./parse-agent-output.js";

describe("parseAgentOutput", () => {
  describe("code-changes", () => {
    it("returns empty documents regardless of stdout content", () => {
      expect(parseAgentOutput("Modified 3 files", "code-changes")).toEqual({ documents: [] });
      expect(parseAgentOutput("", "code-changes")).toEqual({ documents: [] });
      expect(parseAgentOutput("---\nkind: task\n---\nbody", "code-changes")).toEqual({ documents: [] });
    });
  });

  describe("single-document", () => {
    it("parses one frontmatter document", () => {
      const out = [
        "preamble chatter",
        "---",
        "id: T20260420-0001",
        "kind: task",
        "priority: 3",
        "---",
        "Body paragraph.",
        "",
        "More body.",
      ].join("\n");

      const result = parseAgentOutput(out, "single-document");
      expect(result.documents).toHaveLength(1);
      expect(result.documents[0].frontmatter).toEqual({
        id: "T20260420-0001",
        kind: "task",
        priority: 3,
      });
      expect(result.documents[0].body).toBe("Body paragraph.\n\nMore body.");
    });

    it("throws when zero documents present", () => {
      expect(() => parseAgentOutput("just text no frontmatter", "single-document"))
        .toThrowError(AgentError);
    });

    it("throws when more than one document present", () => {
      const out = [
        "---",
        "id: A",
        "kind: task",
        "---",
        "body A",
        "---",
        "id: B",
        "kind: task",
        "---",
        "body B",
      ].join("\n");
      expect(() => parseAgentOutput(out, "single-document"))
        .toThrowError(/expected exactly 1/);
    });

    it("throws on malformed YAML frontmatter", () => {
      const out = [
        "---",
        "id: [unclosed",
        "---",
        "body",
      ].join("\n");
      expect(() => parseAgentOutput(out, "single-document"))
        .toThrowError(/invalid YAML frontmatter/);
    });

    it("throws when fence is opened but never closed", () => {
      const out = "---\nkind: task\nbody with no closing fence";
      expect(() => parseAgentOutput(out, "single-document"))
        .toThrowError(/never closed/);
    });

    it("handles CRLF line endings", () => {
      const out = "---\r\nid: X\r\nkind: task\r\n---\r\nbody\r\n";
      const result = parseAgentOutput(out, "single-document");
      expect(result.documents[0].frontmatter.id).toBe("X");
      expect(result.documents[0].body).toBe("body");
    });

    it("rejects list-style root frontmatter (must be a mapping)", () => {
      const out = "---\n- a\n- b\n---\nbody";
      expect(() => parseAgentOutput(out, "single-document"))
        .toThrowError(/mapping/);
    });
  });

  describe("multi-document", () => {
    it("parses N documents separated by fences", () => {
      const out = [
        "intro text",
        "---",
        "id: F20260420-0001",
        "kind: finding",
        "---",
        "Finding A body.",
        "---",
        "id: F20260420-0002",
        "kind: finding",
        "---",
        "Finding B body.",
      ].join("\n");

      const result = parseAgentOutput(out, "multi-document");
      expect(result.documents).toHaveLength(2);
      expect(result.documents[0].frontmatter.id).toBe("F20260420-0001");
      expect(result.documents[0].body).toBe("Finding A body.");
      expect(result.documents[1].frontmatter.id).toBe("F20260420-0002");
      expect(result.documents[1].body).toBe("Finding B body.");
    });

    it("returns empty documents when no frontmatter blocks found", () => {
      expect(parseAgentOutput("nothing structured here", "multi-document"))
        .toEqual({ documents: [] });
    });

    it("ignores trailing narration after the last document", () => {
      const out = [
        "---",
        "id: X",
        "kind: finding",
        "---",
        "body",
      ].join("\n");
      const result = parseAgentOutput(out + "\n\ntrailing commentary", "multi-document");
      expect(result.documents).toHaveLength(1);
      expect(result.documents[0].body).toContain("body");
    });

    it("supports complex YAML structures in frontmatter", () => {
      const out = [
        "---",
        "id: T1",
        "kind: task",
        "labels:",
        "  - bug",
        "  - high",
        "meta:",
        "  owner: alice",
        "---",
        "body",
      ].join("\n");

      const result = parseAgentOutput(out, "multi-document");
      expect(result.documents[0].frontmatter.labels).toEqual(["bug", "high"]);
      expect(result.documents[0].frontmatter.meta).toEqual({ owner: "alice" });
    });
  });

  describe("structured-report", () => {
    it("parses one document with large body (retrospective-style)", () => {
      const out = [
        "---",
        "id: W2026W17",
        "kind: retrospective",
        "weekScope: 2026W17",
        "---",
        "## Weekly Optimization",
        "",
        "### Metrics",
        "- tasks completed: 10",
      ].join("\n");

      const result = parseAgentOutput(out, "structured-report");
      expect(result.documents).toHaveLength(1);
      expect(result.documents[0].frontmatter.weekScope).toBe("2026W17");
      expect(result.documents[0].body).toContain("Weekly Optimization");
      expect(result.documents[0].body).toContain("tasks completed: 10");
    });

    it("throws when zero documents present", () => {
      expect(() => parseAgentOutput("just prose", "structured-report"))
        .toThrowError(/expected exactly 1/);
    });
  });
});
