import { describe, it, expect } from "vitest";
import { summarizeMarkdownForPr } from "./pr-summary.js";

describe("summarizeMarkdownForPr", () => {
  it("drops the leading H1 that duplicates the task title", () => {
    const body = "# Add docs page\n\n## Problem\n\nNo guide exists.";
    const out = summarizeMarkdownForPr(body, 1000);
    expect(out).not.toContain("# Add docs page");
    expect(out).toContain("No guide exists.");
  });

  it("demotes remaining headings by two levels so they nest under the H3 Summary", () => {
    const body = "# Title\n\n## Problem\n\nbody\n\n## Solution\n\nmore";
    const out = summarizeMarkdownForPr(body, 1000);
    expect(out).toContain("#### Problem");
    expect(out).toContain("#### Solution");
    expect(out).not.toMatch(/^## Problem/m);
    expect(out).not.toMatch(/^## Solution/m);
  });

  it("caps demotion at H6 instead of producing invalid deeper levels", () => {
    const body = "## Problem\n\n##### Deep\n\n###### Deepest";
    const out = summarizeMarkdownForPr(body, 1000);
    expect(out).toContain("#### Problem");
    expect(out).toContain("###### Deep");
    expect(out).toContain("###### Deepest");
    expect(out).not.toMatch(/#{7}/);
  });

  it("leaves '#' inside fenced code blocks untouched", () => {
    const body = ["## Steps", "", "```bash", "# run the script", "echo hi", "```"].join("\n");
    const out = summarizeMarkdownForPr(body, 1000);
    expect(out).toContain("#### Steps");
    expect(out).toContain("# run the script");
  });

  it("does not treat a non-heading '#' (no following space) as a heading", () => {
    const body = "Issue #42 is open\n\n## Problem\n\nbody";
    const out = summarizeMarkdownForPr(body, 1000);
    expect(out).toContain("Issue #42 is open");
    expect(out).toContain("#### Problem");
  });

  it("truncates an over-long body and appends the marker", () => {
    const longBody = "x".repeat(2000);
    const out = summarizeMarkdownForPr(longBody, 1200);
    expect(out.length).toBeLessThan(longBody.length);
    expect(out).toContain("[…truncated]");
  });

  it("returns a short body unchanged except for trimming", () => {
    const body = "Just a plain one-line summary.";
    expect(summarizeMarkdownForPr(body, 1200)).toBe(body);
  });
});
