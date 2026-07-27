import { describe, it, expect, vi } from "vitest";
import type { WorkItemFileData } from "../../../work-items/work-items.js";
import {
  buildCatchUpPlannerPr,
  buildPlanPlannerPr,
  buildPlannerTerminalComment,
  buildRejectionPlannerPr,
} from "./planner-pr-body.js";

const shape = {
  prPrefix: "[AI:Finding]",
  displayName: "Finding",
  idVarName: "FINDING_ID",
} as const;

function makeItem(overrides: Partial<WorkItemFileData> = {}): WorkItemFileData {
  return {
    id: "F-PR",
    kind: "finding",
    title: "F-PR title",
    body: "F-PR body paragraph.",
    status: "in-progress",
    priority: 3,
    source: "analyzer-x",
    createdAt: "2026-04-16",
    ...overrides,
  };
}

describe("buildRejectionPlannerPr", () => {
  it("renders byte-identical rejection title, body, and commit message", () => {
    const item = makeItem();
    const rejection = {
      agentRole: "planner",
      reason: "Finding invalid — base class already maps name (case-insensitive)",
    };
    const result = buildRejectionPlannerPr(item, "F-PR", rejection, shape);

    expect(result.title).toBe("[AI:Finding] F-PR: REJECTED — F-PR title");
    expect(result.body).toBe([
      "## Finding F-PR: rejected by planner",
      "",
      "**Reason**: Finding invalid — base class already maps name (case-insensitive)",
      "",
      "**What this PR does**: flips `status: pending → rejected` on the finding file so the orchestrator stops re-picking this item.",
      "",
      "**Original finding body**:",
      "",
      "F-PR body paragraph.",
      "",
      "---",
      "",
      "**Reviewer action**: merge this PR to propagate the rejection to develop, or close-without-merge if you disagree — the supervisor will handle override on the next cycle.",
    ].join("\n"));
    expect(result.commitMessage).toBe(
      "Finding F-PR: rejected — Finding invalid — base class already maps name (case-insensitive)",
    );
  });

  it("truncates an over-long original body at 1500 characters", () => {
    const longBody = "x".repeat(1600);
    const item = makeItem({ body: longBody });
    const result = buildRejectionPlannerPr(
      item,
      "F-PR",
      { agentRole: "planner", reason: "invalid" },
      shape,
    );
    expect(result.body).toContain("x".repeat(1500));
    expect(result.body).toContain("[…truncated]");
    expect(result.body).not.toContain("x".repeat(1600));
  });
});

describe("buildCatchUpPlannerPr", () => {
  it("renders byte-identical catch-up title, body, and commit message", () => {
    const item = makeItem();
    const childIds = ["T-EXISTING-1"];
    const result = buildCatchUpPlannerPr(item, "F-PR", childIds, shape);

    expect(result.title).toBe("[AI:Finding] F-PR (catch-up): F-PR title");
    expect(result.body).toBe([
      "## Finding F-PR: catch-up — planner skipped",
      "",
      "**What this PR does**: flips `status: pending → in-progress` on the finding file only. No new child items were emitted.",
      "",
      "**Why planner was skipped**: 1 child item(s) for this finding already exist on the base branch:",
      "",
      "- `T-EXISTING-1`",
      "",
      "**Reviewer action**: safe to merge as-is — this is the idempotency contract bringing the recorded finding status in line with prior planning.",
    ].join("\n"));
    expect(result.commitMessage).toBe(
      "Finding F-PR: catch-up status flip (1 child item(s) already exist)",
    );
  });
});

describe("buildPlanPlannerPr", () => {
  it("renders byte-identical plan title and commit message with template body", async () => {
    const item = makeItem();
    const loadTemplate = vi.fn().mockResolvedValue("rendered template body");
    const result = await buildPlanPlannerPr(item, "F-PR", {
      ...shape,
      templatesDir: "/tmp/templates",
      prTemplate: "finding-pr-inprogress-body.md",
      loadTemplate,
    });

    expect(result.title).toBe("[AI:Finding] F-PR: F-PR title");
    expect(result.body).toBe("rendered template body");
    expect(result.commitMessage).toBe("Finding F-PR: planner emitted child item(s)");
    expect(loadTemplate).toHaveBeenCalledWith(
      "/tmp/templates",
      "finding-pr-inprogress-body.md",
      {
        FINDING_ID: "F-PR",
        TYPE: "finding",
        PRIORITY: "3",
        SOURCE: "analyzer-x",
        ASSUMPTION: "F-PR body paragraph.",
      },
    );
  });

  it("falls back to the in-progress stub when template loading fails", async () => {
    const item = makeItem();
    const result = await buildPlanPlannerPr(item, "F-PR", {
      ...shape,
      templatesDir: "/tmp/templates",
      prTemplate: "missing.md",
      loadTemplate: vi.fn().mockRejectedValue(new Error("missing template")),
    });

    expect(result.body).toBe("## Finding F-PR\n\nIn progress.");
  });
});

describe("buildPlannerTerminalComment", () => {
  it("renders byte-identical terminal comments for each disposition", () => {
    expect(buildPlannerTerminalComment("Finding", "F-PR", "failed", "retries exhausted"))
      .toBe("Finding **F-PR** failed: retries exhausted. Remove the failed label to retry.");
    expect(buildPlannerTerminalComment("Finding", "F-PR", "cancelled", "stale"))
      .toBe("Finding **F-PR** cancelled: stale. Closing PR — no retry will be attempted.");
    expect(buildPlannerTerminalComment("Finding", "F-PR", "rejected", "scope"))
      .toBe("Finding **F-PR** rejected: scope. Closing PR — the retrospective will regenerate a replacement item with updated scope.");
  });
});
