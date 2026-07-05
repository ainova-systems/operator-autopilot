import { describe, it, expect, vi } from "vitest";
import type { Octokit } from "@octokit/rest";
import {
  fetchReviewThreads,
  replyToReviewThread,
  resolveReviewThread,
} from "./review-threads.js";

function octokitWith(graphql: ReturnType<typeof vi.fn>): Octokit {
  return { graphql } as unknown as Octokit;
}

function threadNode(overrides: Record<string, unknown> = {}) {
  return {
    id: "THREAD_1",
    isResolved: false,
    comments: {
      nodes: [
        {
          databaseId: 100,
          body: "Consider a null check here",
          path: "src/auth.ts",
          createdAt: "2026-07-01T10:00:00Z",
          updatedAt: "2026-07-01T10:00:00Z",
          authorAssociation: "NONE",
          author: { login: "copilot", __typename: "Bot" },
        },
      ],
    },
    ...overrides,
  };
}

function page(nodes: unknown[], hasNextPage = false, endCursor: string | null = null) {
  return {
    repository: {
      pullRequest: {
        reviewThreads: { pageInfo: { hasNextPage, endCursor }, nodes },
      },
    },
  };
}

describe("review-threads", () => {
  describe("fetchReviewThreads", () => {
    it("maps a thread with its root-author type and comments", async () => {
      const graphql = vi.fn().mockResolvedValueOnce(page([threadNode()]));
      const threads = await fetchReviewThreads(octokitWith(graphql), "owner", "repo", 42);

      expect(threads).toHaveLength(1);
      expect(threads[0]).toMatchObject({
        id: "THREAD_1",
        isResolved: false,
        authorType: "Bot",
      });
      expect(threads[0].comments[0]).toMatchObject({
        id: "100",
        author: "copilot",
        body: "Consider a null check here",
        path: "src/auth.ts",
        authorAssociation: "NONE",
        authorType: "Bot",
      });
      // Query is passed the PR coordinates.
      expect(graphql).toHaveBeenCalledWith(
        expect.stringContaining("reviewThreads"),
        { owner: "owner", repo: "repo", number: 42, cursor: null },
      );
    });

    it("follows pagination until hasNextPage is false", async () => {
      const graphql = vi
        .fn()
        .mockResolvedValueOnce(page([threadNode({ id: "T1" })], true, "CURSOR_2"))
        .mockResolvedValueOnce(page([threadNode({ id: "T2" })], false, null));
      const threads = await fetchReviewThreads(octokitWith(graphql), "o", "r", 7);

      expect(threads.map((t) => t.id)).toEqual(["T1", "T2"]);
      expect(graphql).toHaveBeenCalledTimes(2);
      expect(graphql).toHaveBeenLastCalledWith(
        expect.any(String),
        { owner: "o", repo: "r", number: 7, cursor: "CURSOR_2" },
      );
    });

    it("returns [] when the pull request is absent", async () => {
      const graphql = vi.fn().mockResolvedValueOnce({ repository: { pullRequest: null } });
      const threads = await fetchReviewThreads(octokitWith(graphql), "o", "r", 1);
      expect(threads).toEqual([]);
    });

    it("maps human author type and a missing databaseId to an empty id", async () => {
      const graphql = vi.fn().mockResolvedValueOnce(
        page([
          threadNode({
            id: "T_HUMAN",
            comments: {
              nodes: [
                {
                  databaseId: null,
                  body: "please rename",
                  path: null,
                  createdAt: "2026-07-01T11:00:00Z",
                  authorAssociation: "OWNER",
                  author: { login: "maintainer", __typename: "User" },
                },
              ],
            },
          }),
        ]),
      );
      const [thread] = await fetchReviewThreads(octokitWith(graphql), "o", "r", 2);
      expect(thread.authorType).toBe("User");
      expect(thread.comments[0].id).toBe("");
      expect(thread.comments[0].path).toBeUndefined();
    });

    it("leaves author type undefined for an unknown actor typename", async () => {
      const graphql = vi.fn().mockResolvedValueOnce(
        page([
          threadNode({
            comments: {
              nodes: [
                {
                  databaseId: 5,
                  body: "org note",
                  createdAt: "2026-07-01T12:00:00Z",
                  author: { login: "acme", __typename: "Organization" },
                },
              ],
            },
          }),
        ]),
      );
      const [thread] = await fetchReviewThreads(octokitWith(graphql), "o", "r", 3);
      expect(thread.authorType).toBeUndefined();
      expect(thread.comments[0].author).toBe("acme");
    });

    it("defaults author to unknown when the actor is null", async () => {
      const graphql = vi.fn().mockResolvedValueOnce(
        page([
          threadNode({
            comments: {
              nodes: [
                {
                  databaseId: 9,
                  body: "ghost comment",
                  createdAt: "2026-07-01T13:00:00Z",
                  author: null,
                },
              ],
            },
          }),
        ]),
      );
      const [thread] = await fetchReviewThreads(octokitWith(graphql), "o", "r", 4);
      expect(thread.comments[0].author).toBe("unknown");
      expect(thread.authorType).toBeUndefined();
    });
  });

  describe("replyToReviewThread", () => {
    it("posts a reply mutation keyed by thread id", async () => {
      const graphql = vi.fn().mockResolvedValueOnce({});
      await replyToReviewThread(octokitWith(graphql), "THREAD_9", "note body");
      expect(graphql).toHaveBeenCalledWith(
        expect.stringContaining("addPullRequestReviewThreadReply"),
        { threadId: "THREAD_9", body: "note body" },
      );
    });
  });

  describe("resolveReviewThread", () => {
    it("posts a resolve mutation keyed by thread id", async () => {
      const graphql = vi.fn().mockResolvedValueOnce({});
      await resolveReviewThread(octokitWith(graphql), "THREAD_9");
      expect(graphql).toHaveBeenCalledWith(
        expect.stringContaining("resolveReviewThread"),
        { threadId: "THREAD_9" },
      );
    });
  });
});
