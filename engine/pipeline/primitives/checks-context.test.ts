import { describe, it, expect } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChecksObservation } from "@operator/core";
import { formatContext, writeChecksContextFile } from "./checks-context.js";

function makeObservation(overrides?: Partial<ChecksObservation>): ChecksObservation {
  return {
    value: "failing",
    observedAt: "2026-04-30T18:00:00Z",
    headSha: "abc12345",
    checks: [
      {
        name: "frontend-e2e",
        conclusion: "failure",
        completedAt: "2026-04-30T17:31:00Z",
        headSha: "abc12345",
        detailsUrl: "https://github.com/owner/repo/actions/runs/25178080594",
        workflowName: "PR Verification",
        workflowRunId: 25178080594,
        title: "1 of 80 feature tests failed",
        summary: "test_basket_add_item: timeout 30s",
        annotations: [
          {
            path: "src/features/basket/basket.ts",
            startLine: 42,
            endLine: 45,
            message: "Element not found: button[data-testid='add-to-basket']",
            severity: "failure",
            title: "Selector missing",
          },
        ],
      },
      {
        name: "lint",
        conclusion: "success",
        completedAt: "2026-04-30T17:25:00Z",
      },
    ],
    ...overrides,
  };
}

describe("formatContext", () => {
  it("renders failing checks first with title, summary, annotations table", () => {
    const md = formatContext({
      observation: makeObservation(),
      prNumber: 812,
      branch: "ai/tasks/T1",
    });
    expect(md).toContain("# CI Pipeline Context — PR #812");
    expect(md).toContain("Aggregate status: **failing**");
    expect(md).toContain("Branch: `ai/tasks/T1`");
    expect(md).toContain("Head SHA: `abc12345`");
    expect(md).toContain("## Failing checks (1)");
    expect(md).toContain("✗ frontend-e2e (failure)");
    expect(md).toContain("Workflow: PR Verification");
    expect(md).toContain("Run id: 25178080594");
    expect(md).toContain("https://github.com/owner/repo/actions/runs/25178080594");
    expect(md).toContain("**1 of 80 feature tests failed**");
    expect(md).toContain("test_basket_add_item: timeout 30s");
    expect(md).toContain("**Annotations (1)**");
    expect(md).toContain("| failure | `src/features/basket/basket.ts` | 42-45 |");
    expect(md).toContain("**Selector missing**");
    expect(md).toContain("Element not found");
    expect(md).toContain("## Passing checks (1)");
    expect(md).toContain("✓ **lint** (success)");
  });

  it("renders pending and passing sections when there are no failures", () => {
    const md = formatContext({
      observation: makeObservation({
        value: "pending",
        checks: [
          { name: "build", conclusion: "in_progress" },
          { name: "lint", conclusion: "success" },
        ],
      }),
      prNumber: 999,
      branch: "ai/tasks/T2",
    });
    expect(md).toContain("Aggregate status: **pending**");
    expect(md).toContain("## Pending checks (1)");
    expect(md).toContain("✗ build (in_progress)");
    expect(md).toContain("## Passing checks (1)");
    expect(md).not.toContain("## Failing checks");
  });

  it("renders an empty-checks notice when the platform reports nothing", () => {
    const md = formatContext({
      observation: { value: "none", observedAt: "2026-04-30T18:00:00Z", checks: [] },
      prNumber: 1,
      branch: "ai/tasks/T3",
    });
    expect(md).toContain("> No checks reported by the platform.");
  });

  it("escapes pipe characters in annotation messages so the table stays valid", () => {
    const md = formatContext({
      observation: makeObservation({
        checks: [
          {
            name: "f",
            conclusion: "failure",
            annotations: [{
              path: "x.ts",
              startLine: 1,
              message: "expected: 'a | b' got 'c'",
              severity: "failure",
            }],
          },
        ],
      }),
      prNumber: 1,
      branch: "ai/findings/F1",
    });
    expect(md).toContain("expected: 'a \\| b' got 'c'");
  });
});

describe("writeChecksContextFile", () => {
  it("writes markdown to the temp dir and returns the absolute path", async () => {
    const dir = await mkdtemp(join(tmpdir(), "checks-context-"));
    try {
      const path = await writeChecksContextFile(
        { observation: makeObservation(), prNumber: 42, branch: "ai/tasks/T1" },
        { tempDir: dir },
      );
      expect(path).toContain(dir);
      expect(path).toContain("operator-checks-pr42-");
      expect(path).toMatch(/\.md$/);
      const body = await readFile(path, "utf-8");
      expect(body).toContain("PR #42");
      expect(body).toContain("frontend-e2e");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
