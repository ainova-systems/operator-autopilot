import { describe, it, expect } from "vitest";
import { TestVCSPlatform } from "../test-helpers/test-vcs-platform.js";
import { findCodeReviewForBranch, countActivePRs, formatDebugRunLinkSuffix } from "./vcs-helpers.js";

describe("findCodeReviewForBranch", () => {
  it("returns PR id for open PR matching branch", async () => {
    const vcs = new TestVCSPlatform();
    await vcs.createCodeReview({
      title: "T", body: "", baseBranch: "main", headBranch: "ai/tasks/T1",
    });
    expect(await findCodeReviewForBranch(vcs, "ai/tasks/T1")).toBe(1);
  });

  it("returns null for closed PR", async () => {
    const vcs = new TestVCSPlatform();
    const cr = await vcs.createCodeReview({
      title: "T", body: "", baseBranch: "main", headBranch: "ai/tasks/T1",
    });
    await vcs.closeCodeReview(cr.id);
    expect(await findCodeReviewForBranch(vcs, "ai/tasks/T1")).toBeNull();
  });

  it("returns null when no PR exists for branch", async () => {
    const vcs = new TestVCSPlatform();
    expect(await findCodeReviewForBranch(vcs, "ai/tasks/T1")).toBeNull();
  });

  it("returns correct PR when multiple exist", async () => {
    const vcs = new TestVCSPlatform();
    await vcs.createCodeReview({
      title: "A", body: "", baseBranch: "main", headBranch: "ai/tasks/T1",
    });
    await vcs.createCodeReview({
      title: "B", body: "", baseBranch: "main", headBranch: "ai/tasks/T2",
    });
    expect(await findCodeReviewForBranch(vcs, "ai/tasks/T2")).toBe(2);
  });
});

describe("countActivePRs", () => {
  it("counts open PRs matching prefix", async () => {
    const vcs = new TestVCSPlatform();
    await vcs.createCodeReview({
      title: "F1", body: "", baseBranch: "main", headBranch: "ai/findings/F1",
    });
    await vcs.createCodeReview({
      title: "F2", body: "", baseBranch: "main", headBranch: "ai/findings/F2",
    });
    await vcs.createCodeReview({
      title: "T1", body: "", baseBranch: "main", headBranch: "ai/tasks/T1",
    });
    expect(await countActivePRs(vcs, "ai/findings/")).toBe(2);
    expect(await countActivePRs(vcs, "ai/tasks/")).toBe(1);
  });

  it("excludes closed PRs", async () => {
    const vcs = new TestVCSPlatform();
    const cr = await vcs.createCodeReview({
      title: "F1", body: "", baseBranch: "main", headBranch: "ai/findings/F1",
    });
    await vcs.closeCodeReview(cr.id);
    await vcs.createCodeReview({
      title: "F2", body: "", baseBranch: "main", headBranch: "ai/findings/F2",
    });
    expect(await countActivePRs(vcs, "ai/findings/")).toBe(1);
  });

  it("returns 0 when no PRs match", async () => {
    const vcs = new TestVCSPlatform();
    expect(await countActivePRs(vcs, "ai/findings/")).toBe(0);
  });
});

describe("formatDebugRunLinkSuffix", () => {
  const url = "https://github.com/foo/bar/actions/runs/42";

  it("returns empty string when debug flag is off", () => {
    expect(formatDebugRunLinkSuffix(false, url)).toBe("");
  });

  it("returns empty string when debug flag is undefined", () => {
    expect(formatDebugRunLinkSuffix(undefined, url)).toBe("");
  });

  it("returns empty string when run URL is missing", () => {
    expect(formatDebugRunLinkSuffix(true, undefined)).toBe("");
    expect(formatDebugRunLinkSuffix(true, "")).toBe("");
  });

  it("returns a two-newline markdown link when both inputs are present", () => {
    expect(formatDebugRunLinkSuffix(true, url)).toBe(`\n\n[Pipeline run](${url})`);
  });
});
