import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Octokit } from "@octokit/rest";
import { GitHubVCS } from "./vcs.js";

function createMockOctokit() {
  return {
    paginate: vi.fn(),
    graphql: vi.fn().mockResolvedValue({}),
    rest: {
      pulls: {
        list: vi.fn(),
        get: vi.fn(),
        create: vi.fn(),
        update: vi.fn(),
      },
      issues: {
        listComments: vi.fn(),
        createComment: vi.fn(),
        listLabelsOnIssue: vi.fn(),
        addLabels: vi.fn(),
        removeLabel: vi.fn(),
        getLabel: vi.fn(),
        createLabel: vi.fn(),
        updateLabel: vi.fn(),
      },
      git: {
        getRef: vi.fn(),
        createRef: vi.fn(),
        deleteRef: vi.fn(),
        listMatchingRefs: vi.fn(),
      },
      repos: {
        listBranches: vi.fn(),
      },
      checks: {
        listForRef: vi.fn(),
        listAnnotations: vi.fn(),
      },
      actions: {
        reRunWorkflowFailedJobs: vi.fn().mockResolvedValue({}),
        downloadJobLogsForWorkflowRun: vi.fn(),
      },
    },
  };
}

const MOCK_PR = {
  number: 42,
  title: "Fix auth bug",
  html_url: "https://github.com/owner/repo/pull/42",
  head: { ref: "ai/tasks/T001" },
  base: { ref: "main" },
  draft: false,
  labels: [{ name: "ai:pending", color: "fbca04", description: null }],
  merged: false,
  merged_at: null,
  state: "open",
};

const MOCK_COMMENT = {
  id: 100,
  user: { login: "developer" },
  body: "LGTM",
  created_at: "2026-03-22T10:00:00Z",
  updated_at: "2026-03-22T10:01:00Z",
};

describe("GitHubVCS", () => {
  let mock: ReturnType<typeof createMockOctokit>;
  let vcs: GitHubVCS;

  beforeEach(() => {
    mock = createMockOctokit();
    vcs = new GitHubVCS(mock as unknown as Octokit, "owner", "repo");
  });

  it("has correct capabilities", () => {
    expect(vcs.id).toBe("github");
    expect(vcs.capabilities.codeReviews).toBe(true);
    expect(vcs.capabilities.workItems).toBe(false);
  });

  // ── Code reviews ──────────────────────────────────────────────────

  describe("getCodeReviews", () => {
    it("returns mapped PRs via paginate", async () => {
      mock.paginate.mockResolvedValueOnce([MOCK_PR]);
      const result = await vcs.getCodeReviews();
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe(42);
      expect(result[0].title).toBe("Fix auth bug");
      expect(result[0].branch).toBe("ai/tasks/T001");
      expect(result[0].baseBranch).toBe("main");
      expect(result[0].labels).toHaveLength(1);
      expect(result[0].labels[0].name).toBe("ai:pending");
      expect(result[0].comments).toHaveLength(0);
      expect(result[0].merged).toBe(false);
      expect(result[0].closed).toBe(false);
    });

    it("detects merged PR via merged_at when merged field absent", async () => {
      mock.paginate.mockResolvedValueOnce([
        { ...MOCK_PR, merged: undefined, merged_at: "2026-03-22T12:00:00Z", state: "closed" },
      ]);
      const result = await vcs.getCodeReviews();
      expect(result[0].merged).toBe(true);
      expect(result[0].closed).toBe(true);
    });

    it("caches repeated calls within TTL to avoid API spam", async () => {
      mock.paginate.mockResolvedValueOnce([MOCK_PR]);

      const a = await vcs.getCodeReviews();
      const b = await vcs.getCodeReviews();
      const c = await vcs.getCodeReviews();

      expect(a).toEqual(b);
      expect(b).toEqual(c);
      expect(mock.paginate).toHaveBeenCalledTimes(1);
    });

    it("invalidates cache after a mutating call", async () => {
      mock.paginate.mockResolvedValue([MOCK_PR]);
      mock.rest.pulls.create.mockResolvedValueOnce({ data: MOCK_PR });

      await vcs.getCodeReviews();
      await vcs.createCodeReview({
        title: "x", body: "y", baseBranch: "main", headBranch: "ai/tasks/T999",
      });
      await vcs.getCodeReviews();

      expect(mock.paginate).toHaveBeenCalledTimes(2);
    });

    it("caches open and closed states independently", async () => {
      mock.paginate.mockResolvedValueOnce([MOCK_PR]);
      mock.rest.pulls.list.mockResolvedValueOnce({ data: [MOCK_PR] });

      await vcs.getCodeReviews({ state: "open" });
      await vcs.getCodeReviews({ state: "closed" });
      await vcs.getCodeReviews({ state: "open" });

      expect(mock.paginate).toHaveBeenCalledTimes(1);
      expect(mock.rest.pulls.list).toHaveBeenCalledTimes(1);
    });
  });

  describe("getCodeReview", () => {
    it("returns mapped PR for existing number", async () => {
      mock.rest.pulls.get.mockResolvedValueOnce({ data: MOCK_PR });
      const result = await vcs.getCodeReview(42);
      expect(result).not.toBeNull();
      expect(result!.id).toBe(42);
    });

    it("returns null for 404", async () => {
      mock.rest.pulls.get.mockRejectedValueOnce({ status: 404 });
      const result = await vcs.getCodeReview(999);
      expect(result).toBeNull();
    });

    it("rethrows non-404 errors", async () => {
      mock.rest.pulls.get.mockRejectedValueOnce({ status: 500 });
      await expect(vcs.getCodeReview(42)).rejects.toEqual({ status: 500 });
    });
  });

  describe("createCodeReview", () => {
    it("creates PR with correct params", async () => {
      mock.rest.pulls.create.mockResolvedValueOnce({ data: MOCK_PR });
      const result = await vcs.createCodeReview({
        title: "Fix auth bug",
        body: "Description",
        baseBranch: "main",
        headBranch: "ai/tasks/T001",
        draft: false,
      });
      expect(result.id).toBe(42);
      expect(mock.rest.pulls.create).toHaveBeenCalledWith({
        owner: "owner",
        repo: "repo",
        title: "Fix auth bug",
        body: "Description",
        base: "main",
        head: "ai/tasks/T001",
        draft: false,
      });
    });

    it("defaults draft to false", async () => {
      mock.rest.pulls.create.mockResolvedValueOnce({ data: MOCK_PR });
      await vcs.createCodeReview({
        title: "PR", body: "", baseBranch: "main", headBranch: "feat",
      });
      expect(mock.rest.pulls.create).toHaveBeenCalledWith(
        expect.objectContaining({ draft: false }),
      );
    });
  });

  describe("updateCodeReview", () => {
    it("updates title and body", async () => {
      mock.rest.pulls.update.mockResolvedValueOnce({});
      await vcs.updateCodeReview(42, { title: "New Title", body: "New Body" });
      expect(mock.rest.pulls.update).toHaveBeenCalledWith({
        owner: "owner",
        repo: "repo",
        pull_number: 42,
        title: "New Title",
        body: "New Body",
      });
    });

    it("omits undefined fields", async () => {
      mock.rest.pulls.update.mockResolvedValueOnce({});
      await vcs.updateCodeReview(42, { title: "Only Title" });
      const call = mock.rest.pulls.update.mock.calls[0][0];
      expect(call.title).toBe("Only Title");
      expect(call).not.toHaveProperty("body");
    });

    it("marks draft PR ready for review via GraphQL", async () => {
      mock.rest.pulls.update.mockResolvedValueOnce({});
      mock.rest.pulls.get.mockResolvedValueOnce({
        data: { ...MOCK_PR, draft: true, node_id: "PR_node_123" },
      });
      mock.graphql.mockResolvedValueOnce({});

      await vcs.updateCodeReview(42, { draft: false });

      expect(mock.rest.pulls.get).toHaveBeenCalledWith({
        owner: "owner", repo: "repo", pull_number: 42,
      });
      expect(mock.graphql).toHaveBeenCalledWith(
        expect.stringContaining("markPullRequestReadyForReview"),
        { id: "PR_node_123" },
      );
    });

    it("skips GraphQL when PR is already not draft", async () => {
      mock.rest.pulls.update.mockResolvedValueOnce({});
      mock.rest.pulls.get.mockResolvedValueOnce({
        data: { ...MOCK_PR, draft: false },
      });

      await vcs.updateCodeReview(42, { draft: false });

      expect(mock.graphql).not.toHaveBeenCalled();
    });

    it("ignores GraphQL errors when marking ready (non-fatal)", async () => {
      mock.rest.pulls.update.mockResolvedValueOnce({});
      mock.rest.pulls.get.mockRejectedValueOnce(new Error("no graphql scope"));

      // Should not throw
      await vcs.updateCodeReview(42, { draft: false });
    });
  });

  describe("closeCodeReview", () => {
    it("sets state to closed", async () => {
      mock.rest.pulls.update.mockResolvedValueOnce({});
      await vcs.closeCodeReview(42);
      expect(mock.rest.pulls.update).toHaveBeenCalledWith({
        owner: "owner", repo: "repo", pull_number: 42, state: "closed",
      });
    });
  });

  // ── Comments ──────────────────────────────────────────────────────

  describe("getComments", () => {
    it("returns mapped comments via paginate", async () => {
      mock.paginate.mockResolvedValueOnce([MOCK_COMMENT]);
      const result = await vcs.getComments(42);
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe("100");
      expect(result[0].author).toBe("developer");
      expect(result[0].body).toBe("LGTM");
      expect(result[0].createdAt).toBe("2026-03-22T10:00:00Z");
    });

    it("handles comment with null user", async () => {
      mock.paginate.mockResolvedValueOnce([
        { ...MOCK_COMMENT, user: null },
      ]);
      const result = await vcs.getComments(42);
      expect(result[0].author).toBe("unknown");
    });
  });

  describe("postComment", () => {
    it("posts comment and returns mapped result", async () => {
      mock.rest.issues.createComment.mockResolvedValueOnce({ data: MOCK_COMMENT });
      const result = await vcs.postComment(42, "LGTM");
      expect(result.body).toBe("LGTM");
      expect(mock.rest.issues.createComment).toHaveBeenCalledWith({
        owner: "owner", repo: "repo", issue_number: 42, body: "LGTM",
      });
    });
  });

  // ── Labels ────────────────────────────────────────────────────────

  describe("getLabels", () => {
    it("returns mapped labels via paginate", async () => {
      mock.paginate.mockResolvedValueOnce([
        { name: "ai:pending", color: "fbca04", description: "Pending" },
      ]);
      const result = await vcs.getLabels(42);
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe("ai:pending");
      expect(result[0].color).toBe("fbca04");
      expect(result[0].description).toBe("Pending");
    });

    it("handles label with null description", async () => {
      mock.paginate.mockResolvedValueOnce([
        { name: "bug", color: "d73a4a", description: null },
      ]);
      const result = await vcs.getLabels(42);
      expect(result[0].description).toBeUndefined();
    });
  });

  describe("addLabel", () => {
    it("ensures label exists then adds it", async () => {
      mock.rest.issues.getLabel.mockResolvedValueOnce({ data: { color: "fbca04" } });
      mock.rest.issues.addLabels.mockResolvedValueOnce({});
      await vcs.addLabel(42, "ai:pending");
      expect(mock.rest.issues.getLabel).toHaveBeenCalled();
      expect(mock.rest.issues.updateLabel).not.toHaveBeenCalled();
      expect(mock.rest.issues.addLabels).toHaveBeenCalledWith({
        owner: "owner", repo: "repo", issue_number: 42, labels: ["ai:pending"],
      });
    });

    it("auto-creates label with default color if not found", async () => {
      mock.rest.issues.getLabel.mockRejectedValueOnce({ status: 404 });
      mock.rest.issues.createLabel.mockResolvedValueOnce({});
      mock.rest.issues.addLabels.mockResolvedValueOnce({});
      await vcs.addLabel(42, "ai:failed");
      expect(mock.rest.issues.createLabel).toHaveBeenCalledWith({
        owner: "owner", repo: "repo", name: "ai:failed", color: "d73a4a",
      });
    });

    it("uses purple for unknown ai: labels", async () => {
      mock.rest.issues.getLabel.mockRejectedValueOnce({ status: 404 });
      mock.rest.issues.createLabel.mockResolvedValueOnce({});
      mock.rest.issues.addLabels.mockResolvedValueOnce({});
      await vcs.addLabel(42, "ai:custom");
      expect(mock.rest.issues.createLabel).toHaveBeenCalledWith(
        expect.objectContaining({ color: "6f42c1" }),
      );
    });

    it("rethrows non-404 getLabel errors during ensureLabel", async () => {
      mock.rest.issues.getLabel.mockRejectedValueOnce({ status: 500 });
      await expect(vcs.addLabel(42, "ai:pending")).rejects.toEqual({ status: 500 });
    });

    it("uses gray for non-ai labels", async () => {
      mock.rest.issues.getLabel.mockRejectedValueOnce({ status: 404 });
      mock.rest.issues.createLabel.mockResolvedValueOnce({});
      mock.rest.issues.addLabels.mockResolvedValueOnce({});
      await vcs.addLabel(42, "enhancement");
      expect(mock.rest.issues.createLabel).toHaveBeenCalledWith(
        expect.objectContaining({ color: "ededed" }),
      );
    });

    it("reconciles drifted color on existing canonical labels", async () => {
      mock.rest.issues.getLabel.mockResolvedValueOnce({ data: { color: "22fe69" } });
      mock.rest.issues.updateLabel.mockResolvedValueOnce({});
      mock.rest.issues.addLabels.mockResolvedValueOnce({});
      await vcs.addLabel(42, "ai:ready-to-merge");
      expect(mock.rest.issues.updateLabel).toHaveBeenCalledWith({
        owner: "owner", repo: "repo", name: "ai:ready-to-merge", color: "0e8a16",
      });
    });

    it("does not reconcile color on non-canonical (custom) labels", async () => {
      mock.rest.issues.getLabel.mockResolvedValueOnce({ data: { color: "abcdef" } });
      mock.rest.issues.addLabels.mockResolvedValueOnce({});
      await vcs.addLabel(42, "enhancement");
      expect(mock.rest.issues.updateLabel).not.toHaveBeenCalled();
    });
  });

  describe("removeLabel", () => {
    it("removes label from PR", async () => {
      mock.rest.issues.removeLabel.mockResolvedValueOnce({});
      await vcs.removeLabel(42, "ai:pending");
      expect(mock.rest.issues.removeLabel).toHaveBeenCalledWith({
        owner: "owner", repo: "repo", issue_number: 42, name: "ai:pending",
      });
    });

    it("silently ignores 404 (label not present)", async () => {
      mock.rest.issues.removeLabel.mockRejectedValueOnce({ status: 404 });
      await expect(vcs.removeLabel(42, "ai:pending")).resolves.toBeUndefined();
    });

    it("rethrows non-404 errors", async () => {
      mock.rest.issues.removeLabel.mockRejectedValueOnce({ status: 500 });
      await expect(vcs.removeLabel(42, "ai:pending")).rejects.toEqual({ status: 500 });
    });
  });

  // ── Branches ──────────────────────────────────────────────────────

  describe("createBranch", () => {
    it("gets source ref SHA then creates new ref", async () => {
      mock.rest.git.getRef.mockResolvedValueOnce({
        data: { object: { sha: "abc123" } },
      });
      mock.rest.git.createRef.mockResolvedValueOnce({});
      await vcs.createBranch("ai/tasks/T001", "main");
      expect(mock.rest.git.getRef).toHaveBeenCalledWith({
        owner: "owner", repo: "repo", ref: "heads/main",
      });
      expect(mock.rest.git.createRef).toHaveBeenCalledWith({
        owner: "owner", repo: "repo", ref: "refs/heads/ai/tasks/T001", sha: "abc123",
      });
    });
  });

  describe("deleteBranch", () => {
    it("deletes branch ref", async () => {
      mock.rest.git.deleteRef.mockResolvedValueOnce({});
      await vcs.deleteBranch("ai/tasks/T001");
      expect(mock.rest.git.deleteRef).toHaveBeenCalledWith({
        owner: "owner", repo: "repo", ref: "heads/ai/tasks/T001",
      });
    });

    it("silently ignores 404 (already deleted)", async () => {
      mock.rest.git.deleteRef.mockRejectedValueOnce({ status: 404 });
      await expect(vcs.deleteBranch("ai/tasks/T001")).resolves.toBeUndefined();
    });

    it("rethrows non-404 errors", async () => {
      mock.rest.git.deleteRef.mockRejectedValueOnce({ status: 403 });
      await expect(vcs.deleteBranch("ai/tasks/T001")).rejects.toEqual({ status: 403 });
    });
  });

  describe("listBranches", () => {
    it("uses listMatchingRefs when prefix provided", async () => {
      mock.paginate.mockResolvedValueOnce([
        { ref: "refs/heads/ai/tasks/T001" },
        { ref: "refs/heads/ai/tasks/T002" },
      ]);
      const result = await vcs.listBranches("ai/tasks/");
      expect(result).toEqual(["ai/tasks/T001", "ai/tasks/T002"]);
    });

    it("uses listBranches when no prefix", async () => {
      mock.paginate.mockResolvedValueOnce([
        { name: "main" },
        { name: "develop" },
      ]);
      const result = await vcs.listBranches();
      expect(result).toEqual(["main", "develop"]);
    });
  });

  // ── Check runs + transient CI retry ───────────────────────────────

  describe("getCheckRuns", () => {
    it("parses workflowRunId and jobId from the details URL", async () => {
      mock.rest.pulls.get.mockResolvedValueOnce({ data: { head: { sha: "deadbeef" } } });
      mock.rest.checks.listForRef.mockResolvedValueOnce({
        data: {
          check_runs: [{
            id: 1, name: "Deploy PR Environment", conclusion: "success",
            details_url: "https://github.com/owner/repo/actions/runs/28230397428/job/83632478650",
            app: { name: "PR Preview" },
          }],
        },
      });
      const runs = await vcs.getCheckRuns(42);
      expect(runs[0].workflowRunId).toBe(28230397428);
      expect(runs[0].jobId).toBe(83632478650);
    });
  });

  describe("reRunFailedChecks", () => {
    it("re-runs the failed run's failed jobs and returns true", async () => {
      mock.rest.pulls.get.mockResolvedValue({ data: { head: { sha: "sha1" } } });
      mock.rest.checks.listForRef.mockResolvedValueOnce({
        data: {
          check_runs: [
            { id: 1, name: "Deploy", conclusion: "failure",
              details_url: "https://github.com/owner/repo/actions/runs/555/job/111" },
            { id: 2, name: "E2E", conclusion: "skipped",
              details_url: "https://github.com/owner/repo/actions/runs/555/job/222" },
          ],
        },
      });
      mock.paginate.mockResolvedValue([]); // annotations fetch for the failed check
      const ok = await vcs.reRunFailedChecks(42);
      expect(ok).toBe(true);
      expect(mock.rest.actions.reRunWorkflowFailedJobs).toHaveBeenCalledTimes(1);
      expect(mock.rest.actions.reRunWorkflowFailedJobs).toHaveBeenCalledWith({
        owner: "owner", repo: "repo", run_id: 555,
      });
    });

    it("returns false when there are no failing Actions runs", async () => {
      mock.rest.pulls.get.mockResolvedValue({ data: { head: { sha: "sha1" } } });
      mock.rest.checks.listForRef.mockResolvedValueOnce({
        data: { check_runs: [{ id: 1, name: "Deploy", conclusion: "success", details_url: null }] },
      });
      const ok = await vcs.reRunFailedChecks(42);
      expect(ok).toBe(false);
      expect(mock.rest.actions.reRunWorkflowFailedJobs).not.toHaveBeenCalled();
    });
  });

  describe("getJobLogTail", () => {
    it("fetches the job log and caches by job id", async () => {
      mock.rest.actions.downloadJobLogsForWorkflowRun.mockResolvedValue({
        data: "npm error code ECONNRESET",
      });
      const a = await vcs.getJobLogTail(111);
      const b = await vcs.getJobLogTail(111);
      expect(a).toBe("npm error code ECONNRESET");
      expect(b).toBe(a);
      expect(mock.rest.actions.downloadJobLogsForWorkflowRun).toHaveBeenCalledTimes(1);
    });

    it("returns undefined (and caches it) when the platform refuses", async () => {
      mock.rest.actions.downloadJobLogsForWorkflowRun.mockRejectedValue({ status: 410 });
      const out = await vcs.getJobLogTail(222);
      expect(out).toBeUndefined();
    });
  });
});
