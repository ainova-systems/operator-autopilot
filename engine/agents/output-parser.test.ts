import { describe, it, expect } from "vitest";
import {
  stripPreamble,
  stripCodeFences,
  parseFrontmatterMap,
  hasFrontmatter,
  validateRequiredFields,
  extractSections,
  parseAgentOutput,
  extractField,
  FORMAT_REQUIRED_FIELDS,
} from "./output-parser.js";

// ── Sample outputs ──────────────────────────────────────────────────────

const FINDING_OUTPUT = `---
id: F20260322-0001
title: Unused import in AuthService
type: code-quality
priority: 3
source: code-quality-analyzer
status: pending
created_at: 2026-03-22T10:00:00Z
---

## Description

The AuthService imports \`Logger\` but never uses it.

## Recommendation

Remove the unused import.`;

const TASK_OUTPUT = `---
id: T20260322-00101
title: Remove unused Logger import from AuthService
priority: 3
status: pending
---

## Implementation

Remove the import statement on line 5 of AuthService.ts.`;

const WRAPPED_OUTPUT = `\`\`\`markdown
---
id: T001
title: Fix bug
priority: 2
status: pending
---

Body content
\`\`\``;

// ── stripPreamble ───────────────────────────────────────────────────────

describe("stripPreamble", () => {
  it("returns content unchanged when already starting with ---", () => {
    expect(stripPreamble(FINDING_OUTPUT)).toBe(FINDING_OUTPUT);
  });

  it("strips chain-of-thought text before frontmatter", () => {
    const withPreamble = `Based on my analysis, this is a finding.\n\nLet me write the output:\n\n---\nid: F001\ntitle: Bug\n---\n\nBody`;
    const result = stripPreamble(withPreamble);
    expect(result).toBe("---\nid: F001\ntitle: Bug\n---\n\nBody");
  });

  it("strips multi-line reasoning before frontmatter", () => {
    const withReasoning = [
      "StockRequestCodeGenerationService already has tests!",
      "",
      "Now I need to find a NEW finding.",
      "",
      "Based on my analysis:",
      "1. CompanyRoleEnsureHelper has 4 methods",
      "2. It has no test coverage",
      "",
      "---",
      "id: F20260402-0001",
      "title: CompanyRoleEnsureHelper lacks unit test coverage",
      "---",
      "",
      "Body content",
    ].join("\n");
    const result = stripPreamble(withReasoning);
    expect(result.startsWith("---")).toBe(true);
    expect(result).toContain("id: F20260402-0001");
    expect(result).not.toContain("StockRequestCodeGenerationService");
  });

  it("returns content unchanged when no frontmatter delimiter found", () => {
    const plain = "Just some plain text without frontmatter";
    expect(stripPreamble(plain)).toBe(plain);
  });

  it("handles content with only preamble and opening ---", () => {
    const partial = "Preamble\n---\nsome content without closing";
    const result = stripPreamble(partial);
    expect(result).toBe("---\nsome content without closing");
  });
});

// ── stripCodeFences ─────────────────────────────────────────────────────

describe("stripCodeFences", () => {
  it("strips wrapping ```markdown fences", () => {
    const result = stripCodeFences(WRAPPED_OUTPUT);
    expect(result).toContain("---");
    expect(result).toContain("Body content");
    expect(result).not.toContain("```markdown");
    expect(result).not.toMatch(/^```$/m);
  });

  it("strips ```yaml fences", () => {
    const result = stripCodeFences("```yaml\nkey: value\n```");
    expect(result).toBe("key: value");
  });

  it("leaves content without fences unchanged", () => {
    expect(stripCodeFences("plain text")).toBe("plain text");
  });

  it("handles single-line content", () => {
    expect(stripCodeFences("short")).toBe("short");
  });

  it("strips opening fence without closing", () => {
    const result = stripCodeFences("```markdown\ncontent here");
    expect(result).toBe("content here");
  });
});

// ── parseFrontmatterMap ─────────────────────────────────────────────────

describe("parseFrontmatterMap", () => {
  it("parses all frontmatter fields", () => {
    const map = parseFrontmatterMap(FINDING_OUTPUT);
    expect(map.id).toBe("F20260322-0001");
    expect(map.title).toBe("Unused import in AuthService");
    expect(map.type).toBe("code-quality");
    expect(map.priority).toBe("3");
    expect(map.source).toBe("code-quality-analyzer");
    expect(map.status).toBe("pending");
    expect(map.created_at).toBe("2026-03-22T10:00:00Z");
  });

  it("returns empty map for content without frontmatter", () => {
    expect(parseFrontmatterMap("no frontmatter here")).toEqual({});
  });

  it("strips quotes from values", () => {
    const map = parseFrontmatterMap('---\nname: "Quoted"\n---\n');
    expect(map.name).toBe("Quoted");
  });
});

// ── hasFrontmatter ──────────────────────────────────────────────────────

describe("hasFrontmatter", () => {
  it("returns true for valid frontmatter", () => {
    expect(hasFrontmatter(FINDING_OUTPUT)).toBe(true);
  });

  it("returns false for plain text", () => {
    expect(hasFrontmatter("Just some text")).toBe(false);
  });

  it("returns false for unclosed frontmatter", () => {
    expect(hasFrontmatter("---\ntitle: test\nno closing")).toBe(false);
  });
});

// ── validateRequiredFields ──────────────────────────────────────────────

describe("validateRequiredFields", () => {
  it("returns empty array for valid finding", () => {
    const fm = parseFrontmatterMap(FINDING_OUTPUT);
    expect(validateRequiredFields(fm, "finding")).toEqual([]);
  });

  it("returns missing fields for incomplete finding", () => {
    const errors = validateRequiredFields({ id: "F001", title: "Bug" }, "finding");
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => e.field === "priority")).toBe(true);
    expect(errors.some((e) => e.field === "source")).toBe(true);
  });

  it("returns empty for comment format (no required fields)", () => {
    expect(validateRequiredFields({}, "comment")).toEqual([]);
  });

  it("returns empty for failure format (no required fields)", () => {
    expect(validateRequiredFields({}, "failure")).toEqual([]);
  });

  it("validates task required fields", () => {
    const errors = validateRequiredFields({ id: "T001" }, "task");
    expect(errors.some((e) => e.field === "title")).toBe(true);
    expect(errors.some((e) => e.field === "priority")).toBe(true);
    expect(errors.some((e) => e.field === "status")).toBe(true);
  });

  it("validates improver required fields", () => {
    const errors = validateRequiredFields({}, "improver");
    expect(errors.some((e) => e.field === "week")).toBe(true);
    expect(errors.some((e) => e.field === "date")).toBe(true);
    expect(errors.some((e) => e.field === "analyzer")).toBe(true);
  });
});

// ── extractSections ─────────────────────────────────────────────────────

describe("extractSections", () => {
  it("extracts sections by ## headings", () => {
    const sections = extractSections(
      "## Description\n\nSome desc.\n\n## Recommendation\n\nDo this.",
    );
    expect(sections["Description"]).toBe("Some desc.");
    expect(sections["Recommendation"]).toBe("Do this.");
  });

  it("returns empty for text without sections", () => {
    expect(extractSections("just plain text")).toEqual({});
  });
});

// ── parseAgentOutput ────────────────────────────────────────────────────

describe("parseAgentOutput", () => {
  it("parses valid finding output", () => {
    const result = parseAgentOutput(FINDING_OUTPUT, "finding");
    expect(result.frontmatter.id).toBe("F20260322-0001");
    expect(result.body).toContain("## Description");
    expect(result.raw).toContain("---");
  });

  it("parses valid task output", () => {
    const result = parseAgentOutput(TASK_OUTPUT, "task");
    expect(result.frontmatter.id).toBe("T20260322-00101");
    expect(result.body).toContain("## Implementation");
  });

  it("strips code fences before parsing", () => {
    const result = parseAgentOutput(WRAPPED_OUTPUT, "task");
    expect(result.frontmatter.id).toBe("T001");
    expect(result.body).toContain("Body content");
  });

  it("parses comment without frontmatter requirement", () => {
    const result = parseAgentOutput("LGTM, looks good!", "comment");
    expect(result.body).toBe("");
    expect(result.raw).toBe("LGTM, looks good!");
  });

  it("parses failure without frontmatter requirement", () => {
    const result = parseAgentOutput("Build failed: missing dep", "failure");
    expect(result.raw).toBe("Build failed: missing dep");
  });

  it("throws for finding without frontmatter", () => {
    expect(() => parseAgentOutput("no frontmatter", "finding")).toThrow(
      "finding output requires YAML frontmatter",
    );
  });

  it("throws for task with missing required fields", () => {
    expect(() => parseAgentOutput("---\nid: T001\n---\nBody", "task")).toThrow(
      "task output missing required fields: title, priority, status",
    );
  });

  it("trims whitespace before parsing", () => {
    const result = parseAgentOutput(`  \n${TASK_OUTPUT}\n  `, "task");
    expect(result.frontmatter.id).toBe("T20260322-00101");
  });

  it("strips chain-of-thought preamble before parsing", () => {
    const withPreamble = `I analyzed the codebase and found this issue.\n\n${FINDING_OUTPUT}`;
    const result = parseAgentOutput(withPreamble, "finding");
    expect(result.frontmatter.id).toBe("F20260322-0001");
    expect(result.raw).not.toContain("I analyzed");
  });

  it("handles code fences wrapping preamble + frontmatter", () => {
    const wrapped = `\`\`\`markdown\nSome thinking...\n---\nid: T001\ntitle: Fix\npriority: 2\nstatus: pending\n---\n\nBody\n\`\`\``;
    const result = parseAgentOutput(wrapped, "task");
    expect(result.frontmatter.id).toBe("T001");
    expect(result.raw).not.toContain("Some thinking");
  });
});

// ── extractField ────────────────────────────────────────────────────────

describe("extractField", () => {
  it("extracts single field from raw output", () => {
    expect(extractField(FINDING_OUTPUT, "id")).toBe("F20260322-0001");
    expect(extractField(FINDING_OUTPUT, "priority")).toBe("3");
  });

  it("strips code fences before extracting", () => {
    expect(extractField(WRAPPED_OUTPUT, "id")).toBe("T001");
  });

  it("returns undefined for missing field", () => {
    expect(extractField(FINDING_OUTPUT, "nonexistent")).toBeUndefined();
  });
});

// ── FORMAT_REQUIRED_FIELDS ──────────────────────────────────────────────

describe("FORMAT_REQUIRED_FIELDS", () => {
  it("finding requires 7 fields", () => {
    expect(FORMAT_REQUIRED_FIELDS.finding).toHaveLength(7);
  });

  it("task requires 4 fields", () => {
    expect(FORMAT_REQUIRED_FIELDS.task).toHaveLength(4);
  });

  it("improver requires 3 fields", () => {
    expect(FORMAT_REQUIRED_FIELDS.improver).toHaveLength(3);
  });

  it("comment and failure require no fields", () => {
    expect(FORMAT_REQUIRED_FIELDS.comment).toHaveLength(0);
    expect(FORMAT_REQUIRED_FIELDS.failure).toHaveLength(0);
  });
});
