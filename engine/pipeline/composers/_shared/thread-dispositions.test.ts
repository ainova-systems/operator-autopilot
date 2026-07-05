import { describe, it, expect, vi } from "vitest";
import type { EmitCommentReply } from "@operator/core";
import type { PRManager } from "../../../delivery/pr-manager.js";
import type { Logger } from "../../../logging/logger.js";
import type { ReviewThreadRef } from "../../primitives/pr-feedback-selector.js";
import { applyThreadDispositions } from "./thread-dispositions.js";

function makePrManager() {
  return {
    postThreadReply: vi.fn().mockResolvedValue(undefined),
    resolveThread: vi.fn().mockResolvedValue(undefined),
  };
}

function makeLog(): Logger {
  return { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;
}

function reply(thread: string, disposition: "fixed" | "not-applicable", note: string): EmitCommentReply {
  return { type: "comment-reply", thread, disposition, note };
}

function botThread(threadId: string, commentIds: string[], isResolved = false): ReviewThreadRef {
  return { threadId, isResolved, authorType: "Bot", commentIds };
}

function humanThread(threadId: string, commentIds: string[]): ReviewThreadRef {
  return { threadId, isResolved: false, authorType: "User", commentIds };
}

const base = { prId: 842, stage: "pr-review" as const };

describe("applyThreadDispositions", () => {
  it("replies to and resolves a bot thread", async () => {
    const prManager = makePrManager();
    const result = await applyThreadDispositions({
      ...base,
      commentReplies: [reply("100", "fixed", "added the guard")],
      reviewThreads: [botThread("THREAD_A", ["100"])],
      freshReviewCommentIds: ["100"],
      prManager: prManager as unknown as PRManager,
      log: makeLog(),
    });
    expect(prManager.postThreadReply).toHaveBeenCalledTimes(1);
    expect(prManager.postThreadReply).toHaveBeenCalledWith("THREAD_A", expect.stringContaining("added the guard"));
    expect(prManager.postThreadReply).toHaveBeenCalledWith("THREAD_A", expect.stringContaining("Addressed"));
    expect(prManager.resolveThread).toHaveBeenCalledWith("THREAD_A");
    expect(result).toMatchObject({ replied: 1, resolved: 1, unmatched: [], gaps: [] });
  });

  it("replies to a human thread but leaves it open (no resolve)", async () => {
    const prManager = makePrManager();
    const result = await applyThreadDispositions({
      ...base,
      commentReplies: [reply("200", "not-applicable", "value is non-null by caller contract")],
      reviewThreads: [humanThread("THREAD_H", ["200"])],
      freshReviewCommentIds: ["200"],
      prManager: prManager as unknown as PRManager,
      log: makeLog(),
    });
    expect(prManager.postThreadReply).toHaveBeenCalledWith("THREAD_H", expect.stringContaining("No change needed"));
    expect(prManager.resolveThread).not.toHaveBeenCalled();
    expect(result).toMatchObject({ replied: 1, resolved: 0 });
  });

  it("does not re-resolve an already-resolved bot thread", async () => {
    const prManager = makePrManager();
    const result = await applyThreadDispositions({
      ...base,
      commentReplies: [reply("300", "fixed", "done")],
      reviewThreads: [botThread("THREAD_R", ["300"], true)],
      freshReviewCommentIds: ["300"],
      prManager: prManager as unknown as PRManager,
      log: makeLog(),
    });
    expect(prManager.postThreadReply).toHaveBeenCalledTimes(1);
    expect(prManager.resolveThread).not.toHaveBeenCalled();
    expect(result.resolved).toBe(0);
  });

  it("correlates a reply to the thread by any comment id in it", async () => {
    const prManager = makePrManager();
    await applyThreadDispositions({
      ...base,
      commentReplies: [reply("902", "fixed", "handled the follow-up")],
      // 902 is a reply within the thread rooted at 900.
      reviewThreads: [botThread("THREAD_MULTI", ["900", "902"])],
      freshReviewCommentIds: ["902"],
      prManager: prManager as unknown as PRManager,
      log: makeLog(),
    });
    expect(prManager.postThreadReply).toHaveBeenCalledWith("THREAD_MULTI", expect.any(String));
    expect(prManager.resolveThread).toHaveBeenCalledWith("THREAD_MULTI");
  });

  it("warns and skips a disposition referencing an unknown thread handle", async () => {
    const prManager = makePrManager();
    const log = makeLog();
    const result = await applyThreadDispositions({
      ...base,
      commentReplies: [reply("999", "fixed", "phantom")],
      reviewThreads: [botThread("THREAD_A", ["100"])],
      freshReviewCommentIds: [],
      prManager: prManager as unknown as PRManager,
      log,
    });
    expect(prManager.postThreadReply).not.toHaveBeenCalled();
    expect(result.unmatched).toEqual(["999"]);
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("unknown thread handle"), expect.any(Object));
  });

  it("warns about fresh comments left without a disposition", async () => {
    const prManager = makePrManager();
    const log = makeLog();
    const result = await applyThreadDispositions({
      ...base,
      commentReplies: [reply("100", "fixed", "done")],
      reviewThreads: [botThread("THREAD_A", ["100"]), botThread("THREAD_B", ["101"])],
      freshReviewCommentIds: ["100", "101"],
      prManager: prManager as unknown as PRManager,
      log,
    });
    expect(result.gaps).toEqual(["101"]);
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("without a disposition note"), expect.any(Object));
  });

  it("logs an error and skips resolve when the reply fails", async () => {
    const prManager = makePrManager();
    prManager.postThreadReply.mockRejectedValueOnce(new Error("graphql 502"));
    const log = makeLog();
    const result = await applyThreadDispositions({
      ...base,
      commentReplies: [reply("100", "fixed", "done")],
      reviewThreads: [botThread("THREAD_A", ["100"])],
      freshReviewCommentIds: ["100"],
      prManager: prManager as unknown as PRManager,
      log,
    });
    expect(result.replied).toBe(0);
    expect(prManager.resolveThread).not.toHaveBeenCalled();
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining("failed to reply"), expect.any(Object));
  });

  it("counts the reply but logs an error when resolve fails", async () => {
    const prManager = makePrManager();
    prManager.resolveThread.mockRejectedValueOnce(new Error("graphql 502"));
    const log = makeLog();
    const result = await applyThreadDispositions({
      ...base,
      commentReplies: [reply("100", "fixed", "done")],
      reviewThreads: [botThread("THREAD_A", ["100"])],
      freshReviewCommentIds: ["100"],
      prManager: prManager as unknown as PRManager,
      log,
    });
    expect(result.replied).toBe(1);
    expect(result.resolved).toBe(0);
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining("failed to resolve"), expect.any(Object));
  });

  it("is a no-op with an empty disposition set", async () => {
    const prManager = makePrManager();
    const result = await applyThreadDispositions({
      ...base,
      commentReplies: [],
      reviewThreads: [botThread("THREAD_A", ["100"])],
      freshReviewCommentIds: [],
      prManager: prManager as unknown as PRManager,
      log: makeLog(),
    });
    expect(prManager.postThreadReply).not.toHaveBeenCalled();
    expect(result).toMatchObject({ replied: 0, resolved: 0, unmatched: [], gaps: [] });
  });
});
