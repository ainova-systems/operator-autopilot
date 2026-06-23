import { describe, it, expect, vi } from "vitest";
import {
  formatAgentOutput,
  substituteVars,
} from "./output-formatter.js";
import type { FormatterConfig } from "./output-formatter.js";
import type { TemplateSource } from "./kv-template-source.js";

// ── Test fixtures ────────────────────────────────────────────────────

const VALID_FINDING = `---
id: F20260402-0001
title: Missing test coverage
type: code-quality
priority: 3
source: test-analyzer
status: pending
created_at: 2026-04-02T10:00:00Z
---

## Description

No tests for helper class.`;

const PREAMBLE_FINDING = `I analyzed the codebase and found this issue.

Based on my analysis:
1. The helper has 4 methods
2. No test coverage

---
id: F20260402-0001
title: Missing test coverage
type: code-quality
priority: 3
source: test-analyzer
status: pending
created_at: 2026-04-02T10:00:00Z
---

## Description

No tests for helper class.`;

const VALID_IMPROVER = `---
week: "2026W15"
date: "2026-04-06"
analyzer: copilot
---

## Analysis

Report content here.`;

// ── Helpers ──────────────────────────────────────────────────────────

function makeTemplates(): TemplateSource {
  return {
    load: vi.fn(async (name: string) => {
      if (name.startsWith("formats/improver")) return "Format this report.\nLANGUAGE: {LANGUAGE}\nWeek: {WEEK}\n";
      return `Template for ${name}`;
    }),
  };
}

function makeConfig(overrides?: Partial<FormatterConfig>): FormatterConfig {
  return {
    templates: makeTemplates(),
    ...overrides,
  };
}

// ── substituteVars ───────────────────────────────────────────────────

describe("substituteVars", () => {
  it("substitutes LANGUAGE placeholder", () => {
    const result = substituteVars("Text in {LANGUAGE}.", "Russian");
    expect(result).toBe("Text in Russian.");
  });

  it("defaults language to English", () => {
    const result = substituteVars("Text in {LANGUAGE}.");
    expect(result).toBe("Text in English.");
  });

  it("substitutes custom variables", () => {
    const result = substituteVars("Week: {WEEK}", undefined, { WEEK: "2026W15" });
    expect(result).toBe("Week: 2026W15");
  });

  it("handles multiple substitutions", () => {
    const result = substituteVars("{LANGUAGE} report for {WEEK}", "Russian", { WEEK: "2026W15" });
    expect(result).toBe("Russian report for 2026W15");
  });
});

// ── formatAgentOutput (no API key — structural cleanup only) ────────

describe("formatAgentOutput without API key", () => {
  it("passes through valid finding output", async () => {
    const result = await formatAgentOutput(VALID_FINDING, "finding", makeConfig());
    expect(result.llmReformatted).toBe(false);
    expect(result.parsed.frontmatter.id).toBe("F20260402-0001");
    expect(result.content).toContain("---");
  });

  it("strips preamble from finding output", async () => {
    const result = await formatAgentOutput(PREAMBLE_FINDING, "finding", makeConfig());
    expect(result.llmReformatted).toBe(false);
    expect(result.parsed.frontmatter.id).toBe("F20260402-0001");
    expect(result.content).not.toContain("I analyzed");
    expect(result.content.startsWith("---")).toBe(true);
  });

  it("strips code fences wrapping output", async () => {
    const wrapped = `\`\`\`markdown\n${VALID_FINDING}\n\`\`\``;
    const result = await formatAgentOutput(wrapped, "finding", makeConfig());
    expect(result.parsed.frontmatter.id).toBe("F20260402-0001");
  });

  it("validates improver output", async () => {
    const result = await formatAgentOutput(VALID_IMPROVER, "improver", makeConfig());
    expect(result.parsed.frontmatter.week).toBe("2026W15");
    expect(result.parsed.frontmatter.analyzer).toBe("copilot");
  });

  it("throws for invalid output that cannot be cleaned", async () => {
    await expect(
      formatAgentOutput("No frontmatter at all", "finding", makeConfig()),
    ).rejects.toThrow("finding output requires YAML frontmatter");
  });

  it("passes through comment format without validation", async () => {
    const result = await formatAgentOutput("LGTM, looks good!", "comment", makeConfig());
    expect(result.parsed.raw).toBe("LGTM, looks good!");
  });
});

// ── formatAgentOutput (with API key — LLM reformat) ─────────────────

describe("formatAgentOutput with API key", () => {
  it("falls back to structural cleanup when API fails", async () => {
    // Use an unreachable URL so fetch fails
    const config = makeConfig({
      apiKey: "test-key",
      apiBaseUrl: "http://127.0.0.1:1",
      timeoutMs: 500,
    });
    const result = await formatAgentOutput(PREAMBLE_FINDING, "finding", config);
    expect(result.llmReformatted).toBe(false);
    expect(result.parsed.frontmatter.id).toBe("F20260402-0001");
  });

  it("queries TemplateSource for the format snippet when LLM reformat runs", async () => {
    const templates = makeTemplates();
    const config: FormatterConfig = {
      templates,
      apiKey: "test-key",
      apiBaseUrl: "http://127.0.0.1:1", // unreachable — we only care about the load() call
      timeoutMs: 200,
    };
    await formatAgentOutput(PREAMBLE_FINDING, "finding", config);
    expect(templates.load).toHaveBeenCalledWith("formats/finding.txt");
  });
});
