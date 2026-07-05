import type { EmitCommentReply } from "@operator/core";
import type { PRManager } from "../../../delivery/pr-manager.js";
import type { Logger } from "../../../logging/logger.js";
import type { ReviewThreadRef } from "../../primitives/pr-feedback-selector.js";

export interface ThreadDispositionInput {
  readonly prId: number;
  readonly stage: string;
  /** Per-thread dispositions the supervisor emitted this cycle. */
  readonly commentReplies: ReadonlyArray<EmitCommentReply>;
  /** Threads carried from selection, keyed for correlation by comment id. */
  readonly reviewThreads: ReadonlyArray<ReviewThreadRef>;
  /** Fresh inline review comment ids the agent was asked to address. */
  readonly freshReviewCommentIds: ReadonlyArray<string>;
  readonly prManager: PRManager;
  readonly log?: Logger;
}

export interface ThreadDispositionResult {
  readonly replied: number;
  readonly resolved: number;
  /** Reply handles that matched no known thread (agent hallucinated an id). */
  readonly unmatched: string[];
  /** Fresh review comment ids the agent left without a disposition. */
  readonly gaps: string[];
}

/** Render a single disposition into the visible reply body. */
function formatDispositionBody(reply: EmitCommentReply): string {
  const header = reply.disposition === "fixed"
    ? "✅ **Addressed**"
    : "☑️ **No change needed**";
  return `${header} — ${reply.note}`;
}

/**
 * Answer each inline review comment the supervisor handled: post the
 * disposition note as a threaded reply and, for bot-authored threads
 * (Copilot, CodeQL, …), mark the thread resolved. Human-opened threads get
 * the reply but are left open for the human to resolve.
 *
 * Every step is best-effort and independently logged — a single failed
 * reply / resolve never aborts the rest, and an INFO line records each
 * externally-visible action per the observability mandate. Coverage gaps
 * (a fresh comment the agent left without a disposition) and unmatched
 * handles (a disposition referencing an unknown thread) are surfaced as
 * WARN lines rather than silently dropped.
 */
export async function applyThreadDispositions(
  input: ThreadDispositionInput,
): Promise<ThreadDispositionResult> {
  const { prId, stage, commentReplies, reviewThreads, prManager, log } = input;

  const threadByCommentId = new Map<string, ReviewThreadRef>();
  for (const thread of reviewThreads) {
    for (const commentId of thread.commentIds) {
      threadByCommentId.set(commentId, thread);
    }
  }

  let replied = 0;
  let resolved = 0;
  const unmatched: string[] = [];
  const answeredIds = new Set<string>();

  for (const reply of commentReplies) {
    answeredIds.add(reply.thread);
    const thread = threadByCommentId.get(reply.thread);
    if (!thread) {
      unmatched.push(reply.thread);
      log?.warn(`${stage}: PR #${prId} disposition references unknown thread handle ${reply.thread} — skipped`, {
        stage, prNumber: prId, thread: reply.thread, disposition: reply.disposition,
      });
      continue;
    }

    try {
      await prManager.postThreadReply(thread.threadId, formatDispositionBody(reply));
      replied++;
      log?.info(`${stage}: PR #${prId} replied to review thread (comment ${reply.thread}, ${reply.disposition})`, {
        stage, prNumber: prId, threadId: thread.threadId, comment: reply.thread,
        disposition: reply.disposition, authorType: thread.authorType,
      });
    } catch (err) {
      log?.error(`${stage}: PR #${prId} failed to reply to review thread ${thread.threadId}`, {
        stage, prNumber: prId, threadId: thread.threadId,
        error: err instanceof Error ? err.message : String(err),
      });
      continue;
    }

    // Only bot-authored threads are auto-resolved; human threads stay open
    // for the human to close (the manual-gate policy for MVP).
    if (thread.authorType === "Bot" && !thread.isResolved) {
      try {
        await prManager.resolveThread(thread.threadId);
        resolved++;
        log?.info(`${stage}: PR #${prId} resolved bot review thread ${thread.threadId} (comment ${reply.thread})`, {
          stage, prNumber: prId, threadId: thread.threadId, comment: reply.thread,
        });
      } catch (err) {
        log?.error(`${stage}: PR #${prId} failed to resolve review thread ${thread.threadId}`, {
          stage, prNumber: prId, threadId: thread.threadId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  // Completeness check — a fresh inline comment left without a disposition
  // violates the "every comment gets a note" invariant. The verifier gate is
  // the primary enforcement; this WARN makes any gap visible in the run log
  // rather than silently under-answering.
  const gaps = input.freshReviewCommentIds.filter((id) => !answeredIds.has(id));
  if (gaps.length > 0) {
    log?.warn(`${stage}: PR #${prId} ${gaps.length} inline comment(s) left without a disposition note: ${gaps.join(", ")}`, {
      stage, prNumber: prId, gaps,
    });
  }

  log?.info(`${stage}: PR #${prId} thread dispositions — ${replied} replied, ${resolved} resolved, ${unmatched.length} unmatched, ${gaps.length} gap(s)`, {
    stage, prNumber: prId, replied, resolved, unmatched: unmatched.length, gaps: gaps.length,
  });

  return { replied, resolved, unmatched, gaps };
}
