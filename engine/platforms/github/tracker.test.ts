import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Octokit } from "@octokit/rest";
import { GitHubTracker } from "./tracker.js";

function createMockOctokit() {
  return {
    paginate: vi.fn(),
    rest: {
      issues: {
        listForRepo: vi.fn(),
        get: vi.fn(),
        update: vi.fn(),
        createComment: vi.fn(),
      },
    },
  };
}

const MOCK_ISSUE = {
  number: 10,
  title: "Bug in login",
  body: "Login fails on mobile",
  state: "open",
  labels: [{ name: "operator" }],
  created_at: "2026-03-20T08:00:00Z",
  updated_at: "2026-03-21T09:00:00Z",
};

const MOCK_PR_IN_ISSUES = {
  ...MOCK_ISSUE,
  number: 42,
  title: "Fix auth",
  pull_request: { url: "https://api.github.com/repos/owner/repo/pulls/42" },
};

describe("GitHubTracker", () => {
  let mock: ReturnType<typeof createMockOctokit>;
  let tracker: GitHubTracker;

  beforeEach(() => {
    mock = createMockOctokit();
    tracker = new GitHubTracker(mock as unknown as Octokit, "owner", "repo");
  });

  it("has correct capabilities", () => {
    expect(tracker.id).toBe("github");
    expect(tracker.capabilities.workItems).toBe(true);
    expect(tracker.capabilities.codeReviews).toBe(false);
    expect(tracker.capabilities.branches).toBe(false);
  });

  // ── getWorkItems ──────────────────────────────────────────────────

  describe("getWorkItems", () => {
    it("returns issues excluding PRs", async () => {
      mock.paginate.mockResolvedValueOnce([MOCK_ISSUE, MOCK_PR_IN_ISSUES]);
      const result = await tracker.getWorkItems();
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe("10");
      expect(result[0].title).toBe("Bug in login");
      expect(result[0].kind).toBe("request");
      expect(result[0].status).toBe("pending");
      expect(result[0].priority).toBe(2);
      expect(result[0].source).toBe("issue#10");
    });

    it("maps closed issues to completed status", async () => {
      mock.paginate.mockResolvedValueOnce([{ ...MOCK_ISSUE, state: "closed" }]);
      const result = await tracker.getWorkItems();
      expect(result[0].status).toBe("completed");
    });

    it("defaults to open state when no status filter", async () => {
      mock.paginate.mockResolvedValueOnce([]);
      await tracker.getWorkItems();
      expect(mock.paginate).toHaveBeenCalledWith(
        mock.rest.issues.listForRepo,
        expect.objectContaining({ state: "open" }),
      );
    });

    it("resolves closed state from completed status filter", async () => {
      mock.paginate.mockResolvedValueOnce([]);
      await tracker.getWorkItems({ status: ["completed"] });
      expect(mock.paginate).toHaveBeenCalledWith(
        mock.rest.issues.listForRepo,
        expect.objectContaining({ state: "closed" }),
      );
    });

    it("resolves all state when mixed status filters", async () => {
      mock.paginate.mockResolvedValueOnce([]);
      await tracker.getWorkItems({ status: ["pending", "completed"] });
      expect(mock.paginate).toHaveBeenCalledWith(
        mock.rest.issues.listForRepo,
        expect.objectContaining({ state: "all" }),
      );
    });

    it("passes labels filter as comma-separated string", async () => {
      mock.paginate.mockResolvedValueOnce([]);
      await tracker.getWorkItems({ labels: ["operator", "ai:pending"] });
      expect(mock.paginate).toHaveBeenCalledWith(
        mock.rest.issues.listForRepo,
        expect.objectContaining({ labels: "operator,ai:pending" }),
      );
    });

    it("respects limit parameter", async () => {
      mock.paginate.mockResolvedValueOnce([]);
      await tracker.getWorkItems({ limit: 10 });
      expect(mock.paginate).toHaveBeenCalledWith(
        mock.rest.issues.listForRepo,
        expect.objectContaining({ per_page: 10 }),
      );
    });
  });

  // ── getWorkItem ───────────────────────────────────────────────────

  describe("getWorkItem", () => {
    it("returns mapped issue", async () => {
      mock.rest.issues.get.mockResolvedValueOnce({ data: MOCK_ISSUE });
      const result = await tracker.getWorkItem("10");
      expect(result).not.toBeNull();
      expect(result!.id).toBe("10");
      expect(result!.body).toBe("Login fails on mobile");
    });

    it("returns null for 404", async () => {
      mock.rest.issues.get.mockRejectedValueOnce({ status: 404 });
      const result = await tracker.getWorkItem("999");
      expect(result).toBeNull();
    });

    it("returns null if item is a PR", async () => {
      mock.rest.issues.get.mockResolvedValueOnce({ data: MOCK_PR_IN_ISSUES });
      const result = await tracker.getWorkItem("42");
      expect(result).toBeNull();
    });

    it("rethrows non-404 errors", async () => {
      mock.rest.issues.get.mockRejectedValueOnce({ status: 500 });
      await expect(tracker.getWorkItem("10")).rejects.toEqual({ status: 500 });
    });
  });

  // ── updateWorkItem ────────────────────────────────────────────────

  describe("updateWorkItem", () => {
    it("updates title and body", async () => {
      mock.rest.issues.update.mockResolvedValueOnce({});
      await tracker.updateWorkItem("10", { title: "New title", body: "New body" });
      expect(mock.rest.issues.update).toHaveBeenCalledWith(
        expect.objectContaining({
          issue_number: 10,
          title: "New title",
          body: "New body",
        }),
      );
    });

    it("closes issue when status is completed", async () => {
      mock.rest.issues.update.mockResolvedValueOnce({});
      await tracker.updateWorkItem("10", { status: "completed" });
      expect(mock.rest.issues.update).toHaveBeenCalledWith(
        expect.objectContaining({ state: "closed" }),
      );
    });

    it("closes issue when status is rejected", async () => {
      mock.rest.issues.update.mockResolvedValueOnce({});
      await tracker.updateWorkItem("10", { status: "rejected" });
      expect(mock.rest.issues.update).toHaveBeenCalledWith(
        expect.objectContaining({ state: "closed" }),
      );
    });

    it("closes issue when status is duplicate", async () => {
      mock.rest.issues.update.mockResolvedValueOnce({});
      await tracker.updateWorkItem("10", { status: "duplicate" });
      expect(mock.rest.issues.update).toHaveBeenCalledWith(
        expect.objectContaining({ state: "closed" }),
      );
    });
  });

  // ── postWorkItemComment ───────────────────────────────────────────

  describe("postWorkItemComment", () => {
    it("posts comment and returns mapped result", async () => {
      mock.rest.issues.createComment.mockResolvedValueOnce({
        data: {
          id: 200,
          user: { login: "operator-bot" },
          body: "Processing...",
          created_at: "2026-03-22T10:00:00Z",
          updated_at: "2026-03-22T10:00:00Z",
        },
      });
      const result = await tracker.postWorkItemComment("10", "Processing...");
      expect(result.id).toBe("200");
      expect(result.author).toBe("operator-bot");
      expect(result.body).toBe("Processing...");
      expect(mock.rest.issues.createComment).toHaveBeenCalledWith({
        owner: "owner", repo: "repo", issue_number: 10, body: "Processing...",
      });
    });

    it("handles null user in response", async () => {
      mock.rest.issues.createComment.mockResolvedValueOnce({
        data: {
          id: 201,
          user: null,
          body: "Test",
          created_at: "2026-03-22T10:00:00Z",
        },
      });
      const result = await tracker.postWorkItemComment("10", "Test");
      expect(result.author).toBe("unknown");
    });
  });
});
