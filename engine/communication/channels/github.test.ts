import { describe, it, expect, vi } from "vitest";
import type { VCSPlatform } from "@operator/core";
import { GitHubChannel } from "./github.js";

function makeVCS(): VCSPlatform {
  return {
    id: "github", capabilities: { codeReviews: true, labels: true, branches: true, comments: true, workItems: true, issueHierarchy: false },
    getCodeReviews: vi.fn(), getCodeReview: vi.fn(),
    createCodeReview: vi.fn(), updateCodeReview: vi.fn(), closeCodeReview: vi.fn(),
    getComments: vi.fn().mockResolvedValue([]), getReviewComments: vi.fn().mockResolvedValue([]),
    postComment: vi.fn().mockResolvedValue({ id: "c1", author: "bot", body: "", createdAt: "" }),
    getLabels: vi.fn(), addLabel: vi.fn(), removeLabel: vi.fn(),
    createBranch: vi.fn(), deleteBranch: vi.fn(), listBranches: vi.fn(),
  };
}

const MARKER = "<!-- bot:operator -->";

describe("GitHubChannel", () => {
  describe("send", () => {
    it("posts comment with marker to PR", async () => {
      const vcs = makeVCS();
      const channel = new GitHubChannel(vcs, MARKER);

      await channel.send({
        event: "pipeline.completed",
        projectId: "proj-1",
        title: "Pipeline completed",
        body: "Research done",
        severity: "info",
        metadata: { codeReviewId: 42 },
      });

      expect(vcs.postComment).toHaveBeenCalledWith(42, expect.stringContaining(MARKER));
      expect(vcs.postComment).toHaveBeenCalledWith(42, expect.stringContaining("Pipeline completed"));
    });

    it("skips when no codeReviewId in metadata", async () => {
      const vcs = makeVCS();
      const channel = new GitHubChannel(vcs, MARKER);

      await channel.send({
        event: "test", projectId: "p", title: "T", body: "B", severity: "info",
      });

      expect(vcs.postComment).not.toHaveBeenCalled();
    });
  });

  describe("extractCommandsFromPR", () => {
    it("extracts commands from PR comments", async () => {
      const vcs = makeVCS();
      vi.mocked(vcs.getComments).mockResolvedValue([
        { id: "1", author: "user", body: "/pause", createdAt: "2026-03-22T11:00:00Z" },
        { id: "2", author: "user", body: "Good work!", createdAt: "2026-03-22T12:00:00Z" },
        { id: "3", author: "user", body: "/retry T1", createdAt: "2026-03-22T13:00:00Z" },
      ]);

      const channel = new GitHubChannel(vcs, MARKER);
      const commands = await channel.extractCommandsFromPR(42);

      expect(commands).toHaveLength(2);
      expect(commands[0].command).toBe("pause");
      expect(commands[0].source).toBe("github");
      expect(commands[0].sender).toBe("user");
      expect(commands[1].command).toBe("retry");
      expect(commands[1].args).toEqual(["T1"]);
    });

    it("skips bot comments", async () => {
      const vcs = makeVCS();
      vi.mocked(vcs.getComments).mockResolvedValue([
        { id: "1", author: "bot", body: `${MARKER}\n\nApplied changes.`, createdAt: "2026-03-22T10:00:00Z" },
        { id: "2", author: "user", body: "/status", createdAt: "2026-03-22T11:00:00Z" },
      ]);

      const channel = new GitHubChannel(vcs, MARKER);
      const commands = await channel.extractCommandsFromPR(42);

      expect(commands).toHaveLength(1);
      expect(commands[0].command).toBe("status");
    });

    it("filters by timestamp", async () => {
      const vcs = makeVCS();
      vi.mocked(vcs.getComments).mockResolvedValue([
        { id: "1", author: "user", body: "/pause", createdAt: "2026-03-22T09:00:00Z" },
        { id: "2", author: "user", body: "/resume", createdAt: "2026-03-22T13:00:00Z" },
      ]);

      const channel = new GitHubChannel(vcs, MARKER);
      const commands = await channel.extractCommandsFromPR(42, "2026-03-22T12:00:00Z");

      expect(commands).toHaveLength(1);
      expect(commands[0].command).toBe("resume");
    });

    it("returns empty when no commands in comments", async () => {
      const vcs = makeVCS();
      vi.mocked(vcs.getComments).mockResolvedValue([
        { id: "1", author: "user", body: "Looks good!", createdAt: "" },
      ]);

      const channel = new GitHubChannel(vcs, MARKER);
      const commands = await channel.extractCommandsFromPR(42);
      expect(commands).toEqual([]);
    });
  });
});
