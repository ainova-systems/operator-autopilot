import type { CodeReview, Comment, ReviewThread } from "@operator/core";
import type { InputSelectorFn } from "./item-selector.js";
import { observeChecks } from "./observe-status.js";
import { classifyPrFeedback, type PrSignals } from "./pr-decision.js";

/**
 * Compact review-thread reference carried in the payload so the stage's
 * `afterAgent` can answer + resolve inline comments without re-fetching. Kept
 * here (with the payload) so both the primitive that builds it and the
 * composer helper that consumes it share one definition.
 */
export interface ReviewThreadRef {
  /** Provider node id used to reply / resolve (GraphQL id on GitHub). */
  readonly threadId: string;
  /** Already-resolved on the platform. */
  readonly isResolved: boolean;
  /** Author type of the thread root — only bot threads are auto-resolved. */
  readonly authorType?: "User" | "Bot";
  /** REST comment ids of every comment in the thread — correlation handles. */
  readonly commentIds: ReadonlyArray<string>;
}

/** Project platform review threads into the compact payload refs. */
export function toReviewThreadRefs(threads: ReadonlyArray<ReviewThread>): ReviewThreadRef[] {
  return threads.map((t) => ({
    threadId: t.id,
    isResolved: t.isResolved,
    authorType: t.authorType,
    commentIds: t.comments.map((c) => c.id).filter((id) => id.length > 0),
  }));
}

/**
 * pr-feedback selector — picks an open AI PR that has unanswered feedback
 * (human or bot) or a fresh CI failure. Registered in `item-selector.ts` as
 * the `"pr-feedback"` strategy and used by the `pr-review` stage.
 *
 * Coverage is uniform across every kind: a PR is a candidate iff its branch
 * is under the single AI prefix (`conventions.branches.aiPrefix`) — the same
 * set `pr-lifecycle` sweeps for promotion. There is no per-kind branch list
 * to keep in sync, so a new work-item kind (or the retrospective kind that
 * previously fell through a stale `branchPrefixes` list) is reviewed exactly
 * like tasks and findings with zero config change.
 *
 * The "is there unanswered feedback?" decision is delegated to
 * {@link classifyPrFeedback} — the one predicate `pr-lifecycle` also uses to
 * gate promotion, so the review trigger and the promote gate can never
 * disagree (the deadlock that wedged retrospective PR #1132 in `ai:in-review`).
 *
 * Decision flow (all INFO-logged per the observability mandate):
 *   1. `vcs.getCodeReviews()` → open PRs; keep AI-prefixed, non-excluded ones.
 *   2. Fetch comments + review comments + checks once per candidate.
 *   3. `classifyPrFeedback` → verdict. `needs-review` ranks the PR;
 *      `ci-pending` / `ci-exhausted` / `clean` skip (lifecycle owns the
 *      promote + ci-escalation transitions).
 *   4. Pick the PR with the oldest unanswered-feedback timestamp (FIFO).
 */

/** Payload carried inside {@link import("../types.js").StageInput}.data. */
export interface PrFeedbackPayload {
  readonly prId: number;
  readonly branch: string;
  readonly baseBranch: string;
  readonly prType: string;
  /** Formatted fresh feedback block ready for the supervisor prompt. */
  readonly newFeedback: string;
  /** Chronological full thread (including bot) for agent context. */
  readonly fullThread: string;
  /** Bot-marker comment count on this PR — attempts-so-far proxy. */
  readonly botAttempts: number;
  /** Timestamp of the oldest fresh comment driving selection. */
  readonly oldestFreshAt: string;
  /**
   * CI / pipeline observation snapshot captured during selection. The
   * stage-logic side reads this via `payload.checks` to surface logs +
   * annotations to the agent — it must NOT re-fetch via VCS.
   */
  readonly checks: import("@operator/core").ChecksObservation;
  /**
   * Comment + review-comment ids the next bot reply will mark answered
   * (this run's fresh ids plus the prior footer's `responded` set, so
   * history is never lost). `pr-review.afterAgent` embeds these into the
   * reply footer so the next cycle's classifier knows what is handled.
   */
  readonly respondedIds: ReadonlyArray<string>;
  /** Retry counter on the current `ciHead` — `current/max`. */
  readonly ciAttempts: number;
  readonly maxCiRetryAttempts: number;
  /**
   * Resolvable inline review threads on this PR (empty when the platform
   * has no thread support). `pr-review.afterAgent` maps each supervisor
   * `comment-reply` disposition onto a thread here to post the note +
   * resolve bot-authored threads.
   */
  readonly reviewThreads: ReadonlyArray<ReviewThreadRef>;
  /**
   * Ids of the fresh inline review comments the supervisor was asked to
   * address this cycle — used by `afterAgent` to detect any comment left
   * without a disposition note (the "every comment gets a note" invariant).
   */
  readonly freshReviewCommentIds: ReadonlyArray<string>;
}

export function countBotAttempts(comments: ReadonlyArray<Comment>, marker: string): number {
  return comments.reduce((n, c) => (c.body.includes(marker) ? n + 1 : n), 0);
}

export function formatFeedback(
  userComments: Comment[],
  userReviewComments: Comment[],
  ciFailures: string[],
): string {
  const parts: string[] = [];
  if (userComments.length > 0) {
    parts.push(userComments.map((c) => `[PR Comment] @${c.author}: ${c.body}`).join("\n\n"));
  }
  if (userReviewComments.length > 0) {
    // The `#<id>` handle is the reference the supervisor copies into its
    // `EMIT comment-reply` records so the orchestrator can map each
    // disposition back onto the review thread to reply + resolve.
    parts.push(userReviewComments.map((c) => `[Review #${c.id} on ${c.path ?? "unknown"}] @${c.author}: ${c.body}`).join("\n\n"));
  }
  if (ciFailures.length > 0) {
    parts.push(
      `[CI Pipeline Failure] Failed checks: ${ciFailures.join(", ")}. ` +
      "CI was working before this PR's changes. " +
      "Fix the root cause in the code this PR changed, not in CI/deployment infrastructure.",
    );
  }
  return parts.join("\n\n");
}

export function formatFullThread(
  comments: Comment[],
  reviewComments: Comment[],
  marker: string,
): string {
  const entries: Array<{ ts: string; line: string }> = [];
  for (const c of comments) {
    const tag = c.body.includes(marker) ? "BOT" : "USER";
    entries.push({ ts: c.createdAt, line: `[${c.createdAt}] [${tag}] @${c.author}: ${c.body}` });
  }
  for (const c of reviewComments) {
    const tag = c.body.includes(marker) ? "BOT" : "USER";
    entries.push({ ts: c.createdAt, line: `[${c.createdAt}] [${tag}] [Review on ${c.path ?? "unknown"}] @${c.author}: ${c.body}` });
  }
  entries.sort((a, b) => a.ts.localeCompare(b.ts));
  return entries.map((e) => e.line).join("\n\n");
}

const PR_TYPE_ALIASES: Record<string, string> = {
  tasks: "task",
  findings: "finding",
  research: "research",
  improver: "improver",
  retrospective: "retrospective",
  init: "init",
};

/**
 * Derive the PR type from the branch's first segment under the AI prefix
 * (`ai/<segment>/<id>` → `<segment>`), normalising the plural branch dir to
 * the singular noun downstream code branches on (e.g. `tasks` → `task`).
 * No per-kind prefix list — works for every current and future kind.
 */
export function detectPrType(branch: string): string {
  const segment = branch.split("/")[1] ?? "pr";
  return PR_TYPE_ALIASES[segment] ?? segment;
}

export const prFeedbackSelect: InputSelectorFn = async (stageDef, deps, _ctx) => {
  const cfg = stageDef.selectorConfig ?? {};
  const aiPrefix = deps.conventions?.branches.aiPrefix ?? "ai";
  const ignoredBotLogins = Array.isArray(cfg["ignoreBots"])
    ? (cfg["ignoreBots"] as unknown[]).filter((x): x is string => typeof x === "string")
    : [];
  const marker = typeof cfg["commentMarker"] === "string"
    ? (cfg["commentMarker"] as string)
    : deps.conventions?.commentMarker ?? "<!-- bot:operator -->";
  const failedLabel = deps.conventions?.labels.failed ?? "ai:failed";
  const processingLabel = deps.conventions?.labels.processing ?? "ai:processing";
  // Terminal human-driven exits — `ai:rejected` / `ai:cancelled` / `ai:manual`
  // mean a person took the PR out of the AI loop. `ai:ready-to-merge` is NOT
  // excluded up front: a clean ready PR classifies as `clean` and skips
  // naturally, but a fresh comment or CI failure re-engages review and
  // `markInReview` strips the ready label as part of the response.
  const rejectedLabel = deps.conventions?.labels.rejected ?? "ai:rejected";
  const cancelledLabel = deps.conventions?.labels.cancelled ?? "ai:cancelled";
  const manualLabel = deps.conventions?.labels.manual ?? "ai:manual";
  // CI retry budget — counts attempts on the same head SHA; resets when new
  // code is pushed (new headSha). 3 by default: enough for a flaky check, not
  // enough to burn agent budget when the agent keeps declining to fix.
  const maxCiRetryAttempts = typeof cfg["maxCiRetryAttempts"] === "number"
    ? (cfg["maxCiRetryAttempts"] as number)
    : 3;
  // Transient/infra CI failures are re-run by pr-lifecycle, not the agent.
  // Threading the same budget here is what makes the selector SKIP such a PR
  // (verdict `ci-transient`) instead of handing the flake to the review agent.
  const maxCiReRunAttempts = typeof cfg["maxCiReRunAttempts"] === "number"
    ? (cfg["maxCiReRunAttempts"] as number)
    : 2;

  if (!deps.vcs.getComments || !deps.vcs.getReviewComments) {
    throw new Error(`pr-feedback selector requires vcs.getComments + vcs.getReviewComments (stage: ${stageDef.name})`);
  }
  const getComments = deps.vcs.getComments.bind(deps.vcs);
  const getReviewComments = deps.vcs.getReviewComments.bind(deps.vcs);

  const allPRs = await deps.vcs.getCodeReviews();
  const excludedLabels = new Set([
    failedLabel, processingLabel,
    rejectedLabel, cancelledLabel, manualLabel,
  ]);
  const candidates = allPRs.filter((pr) =>
    !pr.closed
    && pr.branch.startsWith(`${aiPrefix}/`)
    && !pr.labels.some((l) => excludedLabels.has(l.name)),
  );
  if (candidates.length === 0) {
    deps.log?.info(`pr-feedback: no eligible open ${aiPrefix}/* PRs, stage ${stageDef.name} will skip`, {
      stage: stageDef.name, selector: "pr-feedback", reason: "no-candidates",
      totalOpen: allPRs.length, aiPrefix,
    });
    return null;
  }

  type Ranked = { pr: CodeReview; payload: PrFeedbackPayload };
  const ranked: Ranked[] = [];
  for (const pr of candidates) {
    const comments = await getComments(pr.id);
    const reviewComments = await getReviewComments(pr.id);
    const checks = await observeChecks(pr.id, { vcs: deps.vcs, log: deps.log });
    const botAttempts = countBotAttempts(comments, marker);

    const signals: PrSignals = { comments, reviewComments, checks };
    const state = classifyPrFeedback(signals, { marker, ignoredBotLogins, maxCiRetryAttempts, maxCiReRunAttempts });

    if (state.verdict !== "needs-review") {
      deps.log?.debug(`pr-feedback: PR #${pr.id} skipped (${state.verdict})`, {
        stage: stageDef.name, prNumber: pr.id, reason: state.verdict,
        ciHead: state.ci.headSha, ciAttempts: state.ci.attempts, maxCiRetryAttempts,
      });
      continue;
    }

    const ciFailures = state.ci.failingChecks.map((c) => c.name);
    const newFeedback = formatFeedback(state.freshComments, state.freshReviewComments, ciFailures);
    const fullThread = formatFullThread([...comments], [...reviewComments], marker);
    const prType = detectPrType(pr.branch);

    // Carry forward all prior `responded` ids plus the ones this run handles —
    // pr-review.afterAgent embeds this exact set into the next bot reply.
    const nextResponded = new Set<string>(state.footer.responded);
    for (const c of state.freshComments) nextResponded.add(c.id);
    for (const c of state.freshReviewComments) nextResponded.add(c.id);

    ranked.push({
      pr,
      payload: {
        prId: pr.id, branch: pr.branch, baseBranch: pr.baseBranch, prType,
        newFeedback, fullThread, botAttempts, oldestFreshAt: state.oldestFreshAt ?? "",
        checks,
        respondedIds: [...nextResponded],
        ciAttempts: state.ci.attempts, maxCiRetryAttempts,
        reviewThreads: [],
        freshReviewCommentIds: state.freshReviewComments.map((c) => c.id),
      },
    });
    deps.log?.info(`pr-feedback: PR #${pr.id} has unanswered feedback (${state.freshComments.length + state.freshReviewComments.length} comments, ${ciFailures.length} CI failures, ci-head=${state.ci.headSha ?? "—"} ci-attempt=${state.ci.attempts}/${maxCiRetryAttempts}, total bot-replies=${botAttempts})`, {
      stage: stageDef.name, selector: "pr-feedback", prNumber: pr.id,
      branch: pr.branch, botAttempts, oldestFreshAt: state.oldestFreshAt,
      freshCount: state.freshComments.length + state.freshReviewComments.length,
      ciFailures: ciFailures.length,
      ciHead: state.ci.headSha, ciAttempts: state.ci.attempts, maxCiRetryAttempts,
    });
  }

  if (ranked.length === 0) {
    deps.log?.info(`pr-feedback: ${candidates.length} candidate PR(s) scanned, none need review, stage ${stageDef.name} will skip`, {
      stage: stageDef.name, selector: "pr-feedback", reason: "none-need-review",
      candidateCount: candidates.length,
    });
    return null;
  }

  ranked.sort((a, b) => a.payload.oldestFreshAt.localeCompare(b.payload.oldestFreshAt));
  const picked = ranked[0];

  // Fetch the resolvable review threads for the winner only — the stage's
  // afterAgent needs them to answer + resolve inline comments, and they are
  // wasted work on the PRs we skip. Best-effort: a GraphQL scope/transport
  // failure disables per-thread replies for this cycle (the top-level summary
  // comment + footer still answer the feedback) rather than aborting review.
  let reviewThreads: ReviewThreadRef[] = [];
  if (deps.vcs.getReviewThreads) {
    try {
      reviewThreads = toReviewThreadRefs(await deps.vcs.getReviewThreads(picked.pr.id));
    } catch (err) {
      deps.log?.warn(`pr-feedback: getReviewThreads failed for PR #${picked.pr.id} — inline replies disabled this cycle`, {
        stage: stageDef.name, selector: "pr-feedback", prNumber: picked.pr.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  deps.log?.info(`pr-feedback: selected PR #${picked.pr.id} (${picked.payload.prType}) for stage ${stageDef.name} (${reviewThreads.length} review thread(s))`, {
    stage: stageDef.name, selector: "pr-feedback", decision: "proceed",
    prNumber: picked.pr.id, branch: picked.pr.branch, prType: picked.payload.prType,
    botAttempts: picked.payload.botAttempts, reviewThreads: reviewThreads.length,
  });

  return {
    scopeKey: String(picked.pr.id),
    data: { ...picked.payload, reviewThreads },
    reason: `fresh-${picked.payload.oldestFreshAt}`,
  };
};
