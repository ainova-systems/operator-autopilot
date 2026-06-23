import type { Comment, ChecksObservation, CheckRun } from "@operator/core";
import { parseLatestBotFooter, type BotAttribution } from "../../delivery/bot-footer.js";

/**
 * Single source of truth for "is this open AI PR waiting on the operator,
 * or is it clean?". Both the `pr-feedback` selector (which picks the PR to
 * review) and `pr-lifecycle` (which promotes / merges / closes) read this
 * one function so they can never disagree about a PR's state.
 *
 * The divergence this kills: `pr-lifecycle` used to own a private
 * `hasFreshUserFeedback` / `hasFailingOrPendingChecks` pair while the
 * selector computed fresh feedback inline. When the two drifted, a PR could
 * be simultaneously "needs review" (so the selector tried to handle it) and
 * "not promotable" (so the lifecycle waited) — or, worse, "clean" to one and
 * "blocked" to the other, leaving a PR wedged in `ai:in-review` forever
 * (retrospective PR #1132). With one classifier the promote gate and the
 * review trigger are the same predicate by construction.
 *
 * The classifier is purely about unanswered feedback + CI. Label policy
 * (which labels exclude a PR from review, when to promote vs merge vs close)
 * stays with each consumer — that is genuinely per-consumer policy, not a
 * shared fact about the PR.
 */

const TRUSTED_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

/**
 * Filter to comments the operator has NOT yet answered: trusted-human or
 * any non-ignored bot (Copilot, CodeQL, Cursor, …) whose id is absent from
 * the latest bot reply's `responded` set. A comment carrying the operator
 * marker is the bot's own reply and never counts as feedback.
 *
 * Bots are treated exactly like humans here on purpose: the operator must
 * answer Copilot review comments the same way it answers a maintainer — the
 * only bots skipped are the ones the repo explicitly lists as pure noise
 * (`ignoredBotLogins`, e.g. `github-actions[bot]`).
 */
export function filterUnansweredComments(
  comments: ReadonlyArray<Comment>,
  marker: string,
  respondedIds: ReadonlySet<string>,
  ignoredBotLogins: ReadonlyArray<string> = [],
): Comment[] {
  return comments.filter((c) => {
    if (c.body.includes(marker)) return false;
    if (respondedIds.has(c.id)) return false;
    if (c.authorType === "Bot") return !ignoredBotLogins.includes(c.author);
    return !c.authorAssociation || TRUSTED_ASSOCIATIONS.has(c.authorAssociation);
  });
}

/** PR signals fetched once per cycle and handed to {@link classifyPrFeedback}. */
export interface PrSignals {
  /** Issue / conversation comments (`issues.listComments`). */
  readonly comments: ReadonlyArray<Comment>;
  /** Inline review comments on the diff (`pulls.listReviewComments`). */
  readonly reviewComments: ReadonlyArray<Comment>;
  /** CI observation snapshot (`observeChecks`). */
  readonly checks: ChecksObservation;
}

/** Config shared by both consumers — no per-stage / per-kind branching. */
export interface PrFeedbackConfig {
  /** Operator comment marker (`conventions.commentMarker`). */
  readonly marker: string;
  /** Bot logins whose comments are pure noise and never trigger review. */
  readonly ignoredBotLogins: ReadonlyArray<string>;
  /** Retry budget for a failing CI run on the same head SHA. */
  readonly maxCiRetryAttempts: number;
}

/** Head-SHA-aware CI retry state, derived once and shared. */
interface CiState {
  readonly value: ChecksObservation["value"];
  readonly headSha?: string;
  readonly failingChecks: ReadonlyArray<CheckRun>;
  /** Retries already spent on the current head SHA. */
  readonly attempts: number;
  readonly maxAttempts: number;
  /** Failing AND the retry budget on this head SHA is spent. */
  readonly exhausted: boolean;
}

/**
 * The single feedback/CI verdict for an open AI PR:
 *
 *   - `ci-pending`   — CI not yet decided; defer every action until it settles.
 *   - `ci-exhausted` — failing CI and the retry budget on this head SHA is
 *                      spent; the operator has given up, a human must act.
 *   - `needs-review` — unanswered comment (human OR bot) or a fresh failing
 *                      check; the review agent must respond.
 *   - `clean`        — nothing unanswered and CI is passing / absent; safe to
 *                      promote toward merge.
 */
type PrFeedbackVerdict = "ci-pending" | "ci-exhausted" | "needs-review" | "clean";

export interface PrFeedbackState {
  readonly verdict: PrFeedbackVerdict;
  /** Unanswered issue comments (empty unless `needs-review`). */
  readonly freshComments: Comment[];
  /** Unanswered inline review comments (empty unless `needs-review`). */
  readonly freshReviewComments: Comment[];
  readonly ci: CiState;
  /** Latest bot-reply attribution reconstructed from the thread. */
  readonly footer: BotAttribution;
  /** Oldest unanswered-feedback timestamp driving FIFO selection. */
  readonly oldestFreshAt?: string;
}

/**
 * Classify a PR's unanswered-feedback + CI state. Pure: no I/O, no label
 * inspection. The caller fetches {@link PrSignals} once and both the
 * selector and the lifecycle sweep call this with the same inputs.
 */
export function classifyPrFeedback(
  signals: PrSignals,
  cfg: PrFeedbackConfig,
): PrFeedbackState {
  const { comments, reviewComments, checks } = signals;

  // Reconstruct prior decision state from the latest bot footer across the
  // WHOLE thread (issue + review comments) — a bot reply is an issue
  // comment, so this matches the selector's issue-only read while also
  // covering platforms that thread the footer on a review comment.
  const all = [...comments, ...reviewComments];
  const footer = parseLatestBotFooter(all, cfg.marker);
  const responded = footer.responded;

  const failingChecks = checks.checks.filter(
    (c) => c.conclusion?.toLowerCase() === "failure",
  );
  const sameHead = !!footer.ciHead && !!checks.headSha && footer.ciHead === checks.headSha;
  const attempts = sameHead ? footer.ciAttempt?.current ?? 0 : 0;
  const exhausted = failingChecks.length > 0 && attempts >= cfg.maxCiRetryAttempts;
  const ci: CiState = {
    value: checks.value,
    headSha: checks.headSha,
    failingChecks,
    attempts,
    maxAttempts: cfg.maxCiRetryAttempts,
    exhausted,
  };

  const empty: Pick<PrFeedbackState, "freshComments" | "freshReviewComments" | "ci" | "footer"> = {
    freshComments: [],
    freshReviewComments: [],
    ci,
    footer,
  };

  // CI not yet decided → defer; never act on incomplete CI.
  if (checks.value === "pending") {
    return { verdict: "ci-pending", ...empty };
  }

  // Failing AND retry budget spent on this head SHA → the operator has
  // given up; a human must push a fix (new head resets the budget) or close.
  if (exhausted) {
    return { verdict: "ci-exhausted", ...empty };
  }

  const freshComments = filterUnansweredComments(comments, cfg.marker, responded, cfg.ignoredBotLogins);
  const freshReviewComments = filterUnansweredComments(reviewComments, cfg.marker, responded, cfg.ignoredBotLogins);
  const ciFresh = failingChecks.length > 0;

  if (freshComments.length > 0 || freshReviewComments.length > 0 || ciFresh) {
    const freshTimestamps = [
      ...freshComments.map((c) => c.createdAt),
      ...freshReviewComments.map((c) => c.createdAt),
    ].sort();
    const latestCiTs = failingChecks
      .map((c) => c.completedAt ?? "")
      .filter(Boolean)
      .sort()
      .pop() ?? "";
    return {
      verdict: "needs-review",
      freshComments,
      freshReviewComments,
      ci,
      footer,
      oldestFreshAt: freshTimestamps[0] ?? latestCiTs,
    };
  }

  return { verdict: "clean", ...empty };
}
