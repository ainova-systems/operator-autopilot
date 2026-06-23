import { describe, it, expect } from "vitest";
import { parseFrontmatter, getAgentBody, getAgentName } from "./frontmatter.js";

const SAMPLE_MD = `---
title: Code quality analysis
path: Source/Backend/**
schedule: daily
enabled: true
---

# Analyzer Instructions

Check for code quality issues in the backend.

Focus on:
- Unused imports
- Dead code`;

describe("parseFrontmatter", () => {
  it("extracts key from frontmatter", () => {
    expect(parseFrontmatter(SAMPLE_MD, "title")).toBe("Code quality analysis");
    expect(parseFrontmatter(SAMPLE_MD, "path")).toBe("Source/Backend/**");
    expect(parseFrontmatter(SAMPLE_MD, "schedule")).toBe("daily");
    expect(parseFrontmatter(SAMPLE_MD, "enabled")).toBe("true");
  });

  it("returns undefined for missing key", () => {
    expect(parseFrontmatter(SAMPLE_MD, "nonexistent")).toBeUndefined();
  });

  it("returns undefined when no frontmatter", () => {
    expect(parseFrontmatter("# Just a heading\n\nSome text", "title")).toBeUndefined();
  });

  it("strips quotes from values", () => {
    const md = '---\ntitle: "Quoted Value"\nname: \'Single Quoted\'\n---\nBody';
    expect(parseFrontmatter(md, "title")).toBe("Quoted Value");
    expect(parseFrontmatter(md, "name")).toBe("Single Quoted");
  });

  it("handles empty frontmatter", () => {
    expect(parseFrontmatter("---\n---\nBody", "title")).toBeUndefined();
  });
});

describe("getAgentBody", () => {
  it("returns body after second ---", () => {
    const body = getAgentBody(SAMPLE_MD);
    expect(body).toContain("# Analyzer Instructions");
    expect(body).toContain("Unused imports");
    expect(body).not.toContain("title:");
  });

  it("returns empty string when no frontmatter", () => {
    expect(getAgentBody("Just some text")).toBe("");
  });

  it("returns empty string when only one ---", () => {
    expect(getAgentBody("---\ntitle: test\nno closing")).toBe("");
  });

  it("handles body with --- separator inside", () => {
    const md = "---\ntitle: test\n---\nBody part 1\n---\nBody part 2";
    const body = getAgentBody(md);
    expect(body).toContain("Body part 1");
    expect(body).toContain("Body part 2");
  });
});

describe("getAgentName", () => {
  it("extracts name from file path", () => {
    expect(getAgentName("/path/to/code-quality.md")).toBe("code-quality");
  });

  it("handles simple filename", () => {
    expect(getAgentName("analyzer.md")).toBe("analyzer");
  });

  it("handles nested path", () => {
    expect(getAgentName(".operator/analyst/security-audit.md")).toBe("security-audit");
  });
});
