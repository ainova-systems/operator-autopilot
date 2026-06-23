import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CodeReview } from "@operator/core";
import {
  readFrontmatterStatus,
  observeDevelopFile,
  observeFeatureBranchFile,
  observePRLabel,
  observePRState,
  observeExecutionVerdict,
  observeChecks,
  aggregateChecks,
} from "./observe-status.js";

let workspace = "";

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "observe-status-"));
});

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
});

describe("readFrontmatterStatus", () => {
  it("extracts status from valid frontmatter", async () => {
    await mkdir(join(workspace, ".operator", "data", "findings"), { recursive: true });
    await writeFile(
      join(workspace, ".operator", "data", "findings", "F20260417-0001.md"),
      `---\nid: F20260417-0001\nstatus: pending\npriority: 5\n---\n\nbody\n`,
      "utf-8",
    );
    const result = await readFrontmatterStatus(workspace, ".operator/data/findings/F20260417-0001.md");
    expect(result.value).toBe("pending");
  });

  it("handles quoted status values", async () => {
    await writeFile(
      join(workspace, "item.md"),
      `---\nstatus: "completed"\n---\nbody`,
      "utf-8",
    );
    const result = await readFrontmatterStatus(workspace, "item.md");
    expect(result.value).toBe("completed");
  });

  it("returns 'missing' when the file does not exist", async () => {
    const result = await readFrontmatterStatus(workspace, "no-such-file.md");
    expect(result.value).toBe("missing");
  });

  it("returns 'missing' when frontmatter is malformed", async () => {
    await writeFile(join(workspace, "broken.md"), "no-frontmatter-here", "utf-8");
    const result = await readFrontmatterStatus(workspace, "broken.md");
    expect(result.value).toBe("missing");
  });

  it("returns 'missing' when status field is absent", async () => {
    await writeFile(
      join(workspace, "no-status.md"),
      `---\nid: F\npriority: 1\n---\n\nbody`,
      "utf-8",
    );
    const result = await readFrontmatterStatus(workspace, "no-status.md");
    expect(result.value).toBe("missing");
  });

  it("returns 'missing' when status value is unknown", async () => {
    await writeFile(
      join(workspace, "weird.md"),
      `---\nstatus: weird-status\n---\nbody`,
      "utf-8",
    );
    const result = await readFrontmatterStatus(workspace, "weird.md");
    expect(result.value).toBe("missing");
  });
});

describe("observeDevelopFile", () => {
  it("returns a full observation with sha + path populated", async () => {
    await mkdir(join(workspace, ".operator", "data", "findings"), { recursive: true });
    await writeFile(
      join(workspace, ".operator", "data", "findings", "F1.md"),
      `---\nstatus: pending\n---\nbody`,
      "utf-8",
    );
    const git = { headSha: vi.fn().mockResolvedValue("abcd1234") };
    const obs = await observeDevelopFile(
      { id: "F1", kind: "finding" },
      ".operator/data/findings",
      { git, workspacePath: workspace, workspaceDataDir: join(workspace, ".operator/data") },
    );
    expect(obs.value).toBe("pending");
    expect(obs.sha).toBe("abcd1234");
    // Path uses platform-native join; normalize for cross-OS assertions.
    expect(obs.path?.replace(/\\/g, "/")).toBe(".operator/data/findings/F1.md");
    expect(obs.observedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("respects an explicit item.path when provided", async () => {
    await mkdir(join(workspace, "custom"), { recursive: true });
    await writeFile(
      join(workspace, "custom", "path.md"),
      `---\nstatus: in-progress\n---\nbody`,
      "utf-8",
    );
    const git = { headSha: vi.fn().mockResolvedValue("sha1") };
    const obs = await observeDevelopFile(
      { id: "X", kind: "finding", path: "custom/path.md" },
      ".operator/data/findings",
      { git, workspacePath: workspace, workspaceDataDir: join(workspace, "custom") },
    );
    expect(obs.value).toBe("in-progress");
    expect(obs.path).toBe("custom/path.md");
  });

  it("returns missing + no sha when git and fs both fail", async () => {
    const git = { headSha: vi.fn().mockRejectedValue(new Error("no repo")) };
    const obs = await observeDevelopFile(
      { id: "Z", kind: "finding" },
      "missing-dir",
      { git, workspacePath: workspace, workspaceDataDir: join(workspace, "missing-dir") },
    );
    expect(obs.value).toBe("missing");
    expect(obs.sha).toBeUndefined();
  });
});

describe("observeFeatureBranchFile", () => {
  it("returns a full observation with branch + sha", async () => {
    await writeFile(
      join(workspace, "t.md"),
      `---\nstatus: completed\n---\nbody`,
      "utf-8",
    );
    const git = { headSha: vi.fn().mockResolvedValue("feat-sha") };
    const obs = await observeFeatureBranchFile(
      { id: "T1", kind: "task" },
      "t.md",
      "ai/tasks/T1",
      { git, workspacePath: workspace },
    );
    expect(obs.value).toBe("completed");
    expect(obs.branch).toBe("ai/tasks/T1");
    expect(obs.sha).toBe("feat-sha");
  });
});

describe("observePRLabel", () => {
  it("returns null when no open PR exists", async () => {
    const deps = { prManager: { findOpenPR: vi.fn().mockResolvedValue(null) } };
    const obs = await observePRLabel("ai/tasks/T1", deps);
    expect(obs).toBeNull();
  });

  it("falls back to a synthetic ai:open value when open PR has no ai: label", async () => {
    const pr: CodeReview = {
      id: 1, title: "t", url: "u", branch: "ai/tasks/T1", baseBranch: "develop",
      draft: false, labels: [{ name: "other" }], comments: [], merged: false, closed: false,
    };
    const deps = { prManager: { findOpenPR: vi.fn().mockResolvedValue(pr) } };
    const obs = await observePRLabel("ai/tasks/T1", deps);
    expect(obs).not.toBeNull();
    expect(obs?.value).toBe("ai:open");
    expect(obs?.prNumber).toBe(1);
  });

  it("falls back to closed PR when no open PR exists and vcs is supplied", async () => {
    const closedPR: CodeReview = {
      id: 99, title: "t", url: "u", branch: "ai/tasks/T-DONE", baseBranch: "develop",
      draft: false, labels: [{ name: "ai:completed" }], comments: [], merged: true, closed: true,
    };
    const deps = {
      prManager: { findOpenPR: vi.fn().mockResolvedValue(null) },
      vcs: { getCodeReviews: vi.fn().mockResolvedValue([closedPR]) },
    };
    const obs = await observePRLabel("ai/tasks/T-DONE", deps);
    expect(obs?.prNumber).toBe(99);
    expect(obs?.value).toBe("ai:completed");
  });

  it("returns null when no PR exists in any state", async () => {
    const deps = {
      prManager: { findOpenPR: vi.fn().mockResolvedValue(null) },
      vcs: { getCodeReviews: vi.fn().mockResolvedValue([]) },
    };
    const obs = await observePRLabel("ai/tasks/T-NEW", deps);
    expect(obs).toBeNull();
  });

  it("returns an observation with prNumber + ai label when present", async () => {
    const pr: CodeReview = {
      id: 42, title: "t", url: "u", branch: "ai/tasks/T1", baseBranch: "develop",
      draft: false, labels: [{ name: "other" }, { name: "ai:processing" }], comments: [],
      merged: false, closed: false,
    };
    const deps = { prManager: { findOpenPR: vi.fn().mockResolvedValue(pr) } };
    const obs = await observePRLabel("ai/tasks/T1", deps);
    expect(obs).not.toBeNull();
    expect(obs?.value).toBe("ai:processing");
    expect(obs?.prNumber).toBe(42);
    expect(obs?.branch).toBe("ai/tasks/T1");
  });
});

describe("observePRState", () => {
  it("returns 'open' when an open PR is found", async () => {
    const openPR: CodeReview = {
      id: 42, title: "t", url: "u", branch: "ai/tasks/T1", baseBranch: "develop",
      draft: false, labels: [], comments: [], merged: false, closed: false,
    };
    const deps = {
      prManager: { findOpenPR: vi.fn().mockResolvedValue(openPR) },
      vcs: { getCodeReviews: vi.fn().mockResolvedValue([]) },
    };
    const obs = await observePRState("ai/tasks/T1", deps);
    expect(obs.value).toBe("open");
    expect(obs.prNumber).toBe(42);
    expect(deps.vcs.getCodeReviews).not.toHaveBeenCalled();
  });

  it("returns 'merged' when the closed PR is merged", async () => {
    const mergedPR: CodeReview = {
      id: 77, title: "t", url: "u", branch: "ai/tasks/T2", baseBranch: "develop",
      draft: false, labels: [], comments: [], merged: true, closed: true,
    };
    const deps = {
      prManager: { findOpenPR: vi.fn().mockResolvedValue(null) },
      vcs: { getCodeReviews: vi.fn().mockResolvedValue([mergedPR]) },
    };
    const obs = await observePRState("ai/tasks/T2", deps);
    expect(obs.value).toBe("merged");
    expect(obs.prNumber).toBe(77);
  });

  it("returns 'closed' when the closed PR was not merged", async () => {
    const closedPR: CodeReview = {
      id: 88, title: "t", url: "u", branch: "ai/tasks/T3", baseBranch: "develop",
      draft: false, labels: [], comments: [], merged: false, closed: true,
    };
    const deps = {
      prManager: { findOpenPR: vi.fn().mockResolvedValue(null) },
      vcs: { getCodeReviews: vi.fn().mockResolvedValue([closedPR]) },
    };
    const obs = await observePRState("ai/tasks/T3", deps);
    expect(obs.value).toBe("closed");
    expect(obs.prNumber).toBe(88);
  });

  it("returns 'none' when no PR matches the branch at all", async () => {
    const deps = {
      prManager: { findOpenPR: vi.fn().mockResolvedValue(null) },
      vcs: { getCodeReviews: vi.fn().mockResolvedValue([]) },
    };
    const obs = await observePRState("ai/tasks/T4", deps);
    expect(obs.value).toBe("none");
    expect(obs.prNumber).toBeUndefined();
  });
});

describe("observeExecutionVerdict", () => {
  it("returns a structured observation with executionId + verdict value", () => {
    const obs = observeExecutionVerdict("e-123", "approved", "task-execute");
    expect(obs.value).toBe("approved");
    expect(obs.executionId).toBe("e-123");
    expect(obs.stageName).toBe("task-execute");
    expect(obs.observedAt).toMatch(/^\d{4}-/);
  });

  it("omits stageName when not provided", () => {
    const obs = observeExecutionVerdict("e-456", "failed");
    expect(obs.stageName).toBeUndefined();
  });
});

describe("aggregateChecks", () => {
  it("returns 'none' for an empty list", () => {
    expect(aggregateChecks([])).toBe("none");
  });

  it("collapses to 'failing' on any failure / timed_out / action_required / startup_failure", () => {
    expect(aggregateChecks([
      { name: "lint", conclusion: "success" },
      { name: "test", conclusion: "failure" },
    ])).toBe("failing");
    expect(aggregateChecks([{ name: "x", conclusion: "timed_out" }])).toBe("failing");
    expect(aggregateChecks([{ name: "x", conclusion: "action_required" }])).toBe("failing");
    expect(aggregateChecks([{ name: "x", conclusion: "startup_failure" }])).toBe("failing");
  });

  it("returns 'pending' when nothing is failing but at least one check is unresolved", () => {
    expect(aggregateChecks([
      { name: "lint", conclusion: "success" },
      { name: "test", conclusion: "in_progress" },
    ])).toBe("pending");
    expect(aggregateChecks([{ name: "queued", conclusion: "queued" }])).toBe("pending");
    expect(aggregateChecks([{ name: "blank", conclusion: "" }])).toBe("pending");
  });

  it("returns 'passing' when all checks have a non-failing terminal conclusion", () => {
    expect(aggregateChecks([
      { name: "lint", conclusion: "success" },
      { name: "skipped", conclusion: "skipped" },
      { name: "neutral", conclusion: "neutral" },
      { name: "cancelled", conclusion: "cancelled" },
    ])).toBe("passing");
  });
});

describe("observeChecks", () => {
  it("returns 'none' when prNumber is undefined", async () => {
    const obs = await observeChecks(undefined, { vcs: { getCheckRuns: vi.fn() } });
    expect(obs.value).toBe("none");
    expect(obs.checks).toEqual([]);
  });

  it("returns 'none' when the platform omits getCheckRuns", async () => {
    const obs = await observeChecks(123, { vcs: {} });
    expect(obs.value).toBe("none");
  });

  it("aggregates per-check conclusions into the worst-of value and preserves headSha", async () => {
    const getCheckRuns = vi.fn().mockResolvedValue([
      { name: "lint", conclusion: "success", headSha: "abc1234" },
      { name: "test", conclusion: "failure", headSha: "abc1234" },
    ]);
    const obs = await observeChecks(456, { vcs: { getCheckRuns } });
    expect(obs.value).toBe("failing");
    expect(obs.headSha).toBe("abc1234");
    expect(obs.checks).toHaveLength(2);
  });

  it("treats getCheckRuns rejection as a non-fatal 'none' observation", async () => {
    const getCheckRuns = vi.fn().mockRejectedValue(new Error("api down"));
    const obs = await observeChecks(789, { vcs: { getCheckRuns } });
    expect(obs.value).toBe("none");
    expect(obs.checks).toEqual([]);
  });
});
