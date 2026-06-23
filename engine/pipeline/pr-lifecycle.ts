import { join } from "node:path";
import { readFile } from "node:fs/promises";
import type {
  VCSPlatform, ConventionsConfig, LifecycleConfig, KindRegistry, CodeReview, Comment,
} from "@operator/core";
import { errorMessage } from "@operator/core";
import type { PRManager } from "../delivery/pr-manager.js";
import type { Logger } from "../logging/logger.js";
import { observeChecks } from "./primitives/observe-status.js";
import { classifyPrFeedback, type PrSignals } from "./primitives/pr-decision.js";

/**
 * `pr-lifecycle` action — periodic sweep over open AI PRs that applies
 * configurable promotion / merge / close rules without invoking an agent.
 * Runs on a `prLifecycleMinutes` cadence and produces zero git commits or
 * agent calls — every mutation is a label flip, a merge, or a close.
 *
 * Rule resolution order: per-work-item override (frontmatter `lifecycle_*`
 * fields) < per-repo override (`repos/{id}.lifecycle`) < engine defaults
 * (`engine-defaults/global.lifecycle`). A field that is `null` at any layer
 * means "rule disabled" and short-circuits the cascade for that field.
 *
 * Every transition is gated on {@link classifyPrFeedback} — the SAME
 * predicate the `pr-feedback` selector uses to decide a PR needs review. A
 * PR is promoted only when that predicate reports `clean` (no unanswered
 * human OR bot comment, CI not failing/pending). This is what makes the
 * promote gate and the review trigger impossible to disagree: when Copilot
 * leaves a review comment the selector classifies the PR `needs-review` and
 * the lifecycle sees the same `≠ clean` verdict, so it waits for review to
 * answer it instead of either promoting blindly or wedging the PR forever.
 *
 * The sweep is idempotent: re-running it on already-merged or already-closed
 * PRs is a no-op, so recovery from a daemon crash is just the next cycle.
 */

export interface PrLifecycleDeps {
  readonly vcs: VCSPlatform;
  readonly prManager: PRManager;
  readonly conventions: ConventionsConfig;
  /** Resolved (defaults + per-repo) lifecycle config. */
  readonly lifecycle: LifecycleConfig;
  /**
   * Bot logins whose comments are pure noise and never block a transition.
   * Must match the `pr-feedback` selector's `ignoreBots` so the promote gate
   * and the review trigger see the same feedback. Defaults to the
   * github-actions bot when omitted (tests).
   */
  readonly ignoredBotLogins?: ReadonlyArray<string>;
  /**
   * Workspace path used to resolve per-work-item lifecycle overrides. When
   * omitted, only system + repo layers apply (frontmatter overrides ignored).
   */
  readonly workspacePath?: string;
  readonly kindRegistry?: KindRegistry;
  readonly log?: Logger;
}

export interface PrLifecycleResult {
  readonly promoted: number;
  readonly merged: number;
  readonly closed: number;
  readonly skipped: number;
}

/** CI retry budget — mirror of the `pr-feedback` selector default. */
const MAX_CI_RETRY_ATTEMPTS = 3;

/** Resolve a lifecycle field across layers — item < repo < defaults. */
function resolveField(
  ...layers: Array<number | null | undefined>
): number | null {
  for (const layer of layers) {
    if (layer === undefined) continue;
    return layer;
  }
  return null;
}

/**
 * Parse `lifecycle_*` frontmatter fields from a work-item file. Flat
 * snake_case keys because the frontmatter parser is line-oriented. Missing
 * file → empty overrides.
 */
async function readItemOverrides(
  itemFilePath: string,
): Promise<LifecycleConfig> {
  let content: string;
  try {
    content = await readFile(itemFilePath, "utf-8");
  } catch {
    return {};
  }
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (!fmMatch) return {};
  const lines = fmMatch[1].split("\n");
  const overrides: Record<string, number | null> = {};
  for (const line of lines) {
    const m = line.match(/^(lifecycle_[\w_]+):\s*(.+)$/);
    if (!m) continue;
    const value = m[2].trim();
    overrides[m[1]] = value === "null" || value === "" ? null : Number(value);
  }
  return {
    promoteToReadyAfterIdleHours: overrides["lifecycle_promote_to_ready_after_idle_hours"],
    autoMergeReadyAfterHours: overrides["lifecycle_auto_merge_ready_after_hours"],
    autoCloseStuckAfterHours: overrides["lifecycle_auto_close_stuck_after_hours"],
  };
}

/**
 * Locate the work-item file for an AI PR by branch convention:
 * `ai/{kindDir}/{itemId}` → `.operator/data/{kindDir}/{itemId}.md`. Returns
 * `null` when the branch does not map to a registered kind.
 */
function workItemFileFor(
  branch: string,
  workspacePath: string,
  registry: KindRegistry,
): string | null {
  const m = branch.match(/^ai\/([^/]+)\/(.+)$/);
  if (!m) return null;
  const segment = m[1];
  const itemId = m[2];
  for (const kind of registry.all) {
    if (kind.dataDir.endsWith(segment) || kind.dataDir.endsWith(`${segment}s`)) {
      return join(workspacePath, kind.dataDir, `${itemId}.md`);
    }
  }
  return null;
}

async function resolveItemLifecycle(
  pr: CodeReview,
  deps: PrLifecycleDeps,
): Promise<LifecycleConfig> {
  if (!deps.workspacePath || !deps.kindRegistry) return {};
  const file = workItemFileFor(pr.branch, deps.workspacePath, deps.kindRegistry);
  if (!file) return {};
  return readItemOverrides(file);
}

function computeIdleHours(pr: CodeReview): number | null {
  if (!pr.updatedAt) return null;
  const ts = Date.parse(pr.updatedAt);
  if (!Number.isFinite(ts)) return null;
  return (Date.now() - ts) / 3_600_000;
}

/** Fetch the comment + review-comment + checks signals for one PR. */
async function loadSignals(pr: CodeReview, vcs: VCSPlatform): Promise<PrSignals> {
  const comments: Comment[] = vcs.getComments ? await vcs.getComments(pr.id) : [];
  let reviewComments: Comment[] = [];
  if (vcs.getReviewComments) {
    try {
      reviewComments = await vcs.getReviewComments(pr.id);
    } catch {
      // Best effort — the main comment stream is enough to detect feedback.
    }
  }
  const checks = await observeChecks(pr.id, { vcs });
  return { comments, reviewComments, checks };
}

export async function runPrLifecycle(
  deps: PrLifecycleDeps,
): Promise<PrLifecycleResult> {
  const { vcs, prManager, conventions, lifecycle: defaults, log } = deps;
  const aiPrefix = `${conventions.branches.aiPrefix}/`;
  const inReviewLabel = conventions.labels.inReview;
  const readyToMergeLabel = conventions.labels.readyToMerge;
  const processingLabel = conventions.labels.processing;
  const failedLabel = conventions.labels.failed;
  const marker = conventions.commentMarker;
  const ignoredBotLogins = deps.ignoredBotLogins ?? ["github-actions[bot]"];

  log?.info(`pr-lifecycle: scanning open AI PRs`);
  const allPRs = await vcs.getCodeReviews({ state: "open" });
  const aiPRs = allPRs.filter((pr) => pr.branch.startsWith(aiPrefix) && !pr.draft);

  let promoted = 0, merged = 0, closed = 0, skipped = 0;

  for (const pr of aiPRs) {
    const idleHours = computeIdleHours(pr);
    if (idleHours === null) {
      skipped++;
      continue;
    }
    const itemLifecycle = await resolveItemLifecycle(pr, deps);

    const promoteAfter = resolveField(
      itemLifecycle.promoteToReadyAfterIdleHours,
      defaults.promoteToReadyAfterIdleHours,
    );
    const mergeAfter = resolveField(
      itemLifecycle.autoMergeReadyAfterHours,
      defaults.autoMergeReadyAfterHours,
    );
    const closeAfter = resolveField(
      itemLifecycle.autoCloseStuckAfterHours,
      defaults.autoCloseStuckAfterHours,
    );

    const labels = new Set(pr.labels.map((l) => l.name));

    try {
      const signals = await loadSignals(pr, vcs);
      const state = classifyPrFeedback(signals, {
        marker, ignoredBotLogins, maxCiRetryAttempts: MAX_CI_RETRY_ATTEMPTS,
      });

      // ── CI exhaustion gate ────────────────────────────────────────
      // Failing CI with the retry budget spent on the current head SHA →
      // escalate to ai:failed and post an attribution-bearing comment.
      // Resolution: a human pushes a fix (new headSha resets the budget) or
      // closes the PR.
      if (labels.has(inReviewLabel) && state.verdict === "ci-exhausted") {
        const failingNames = state.ci.failingChecks.map((c) => c.name).join(", ");
        await prManager.markFailed(pr.id);
        await prManager.postBotComment(
          pr.id,
          `⚠️ CI retry budget exhausted (${state.ci.attempts}/${MAX_CI_RETRY_ATTEMPTS}) on head \`${state.ci.headSha}\`. ` +
          `Failing checks: ${failingNames || "—"}. Marking PR as failed — push a fix or close manually.`,
          {
            responded: state.footer.responded,
            ciHead: state.ci.headSha,
            ciAttempt: { current: state.ci.attempts, max: MAX_CI_RETRY_ATTEMPTS },
          },
        );
        log?.warn(
          `pr-lifecycle: PR #${pr.id} CI retry budget exhausted (${state.ci.attempts}/${MAX_CI_RETRY_ATTEMPTS}), markFailed`,
          {
            stage: "pr-lifecycle", action: "ci-exhausted", prNumber: pr.id,
            ciHead: state.ci.headSha, attempt: state.ci.attempts, maxCiRetryAttempts: MAX_CI_RETRY_ATTEMPTS,
          },
        );
        closed++;
        continue;
      }

      // ── Promote in-review → ready-to-merge ────────────────────────
      if (promoteAfter !== null && labels.has(inReviewLabel) && idleHours >= promoteAfter) {
        if (state.verdict !== "clean") {
          // Unanswered feedback (Copilot / human) or non-passing CI → the PR
          // is not idle in the "waiting for human merge" sense; pr-review
          // owns answering it. Promoting now is exactly the deadlock this
          // shared verdict prevents.
          log?.info(
            `pr-lifecycle: PR #${pr.id} not clean (${state.verdict}), deferring promote — pr-review will handle`,
            { stage: "pr-lifecycle", action: "skip-promote", prNumber: pr.id, reason: state.verdict },
          );
          skipped++;
          continue;
        }
        await prManager.markReadyToMerge(pr.id);
        log?.info(
          `pr-lifecycle: PR #${pr.id} ${inReviewLabel} → ${readyToMergeLabel} (idle ${idleHours.toFixed(1)}h ≥ ${promoteAfter}h)`,
          { stage: "pr-lifecycle", action: "promote", prNumber: pr.id, idleHours, threshold: promoteAfter },
        );
        promoted++;
        continue;
      }

      // ── Auto-merge ready-to-merge → merged ────────────────────────
      if (mergeAfter !== null && labels.has(readyToMergeLabel) && idleHours >= mergeAfter) {
        if (state.verdict !== "clean") {
          log?.info(
            `pr-lifecycle: PR #${pr.id} not clean (${state.verdict}), deferring auto-merge`,
            { stage: "pr-lifecycle", action: "skip-merge", prNumber: pr.id, reason: state.verdict },
          );
          skipped++;
          continue;
        }
        if (!vcs.mergeCodeReview) {
          log?.warn(`pr-lifecycle: autoMergeReadyAfterHours set but platform has no mergeCodeReview — skipping`, {
            stage: "pr-lifecycle", prNumber: pr.id,
          });
          skipped++;
          continue;
        }
        const ok = await vcs.mergeCodeReview(pr.id);
        if (ok) {
          log?.info(
            `pr-lifecycle: auto-merged PR #${pr.id} (${readyToMergeLabel} idle ${idleHours.toFixed(1)}h ≥ ${mergeAfter}h)`,
            { stage: "pr-lifecycle", action: "merge", prNumber: pr.id, idleHours, threshold: mergeAfter },
          );
          merged++;
        } else {
          log?.warn(`pr-lifecycle: PR #${pr.id} auto-merge rejected by platform (conflicts / checks / protection)`, {
            stage: "pr-lifecycle", prNumber: pr.id,
          });
          skipped++;
        }
        continue;
      }

      // ── Auto-close stuck processing / failed PRs ──────────────────
      const isStuck = labels.has(processingLabel) || labels.has(failedLabel);
      if (closeAfter !== null && isStuck && idleHours >= closeAfter) {
        await vcs.closeCodeReview(pr.id);
        log?.warn(
          `pr-lifecycle: auto-closed stuck PR #${pr.id} (${[...labels].join(",")} idle ${idleHours.toFixed(1)}h ≥ ${closeAfter}h)`,
          { stage: "pr-lifecycle", action: "close", prNumber: pr.id, idleHours, threshold: closeAfter },
        );
        closed++;
        continue;
      }
      skipped++;
    } catch (err) {
      log?.error(`pr-lifecycle: PR #${pr.id} sweep failed`, {
        stage: "pr-lifecycle", prNumber: pr.id, error: errorMessage(err),
      });
      skipped++;
    }
  }

  log?.info(`pr-lifecycle: scan complete (promoted=${promoted}, merged=${merged}, closed=${closed}, skipped=${skipped})`);
  return { promoted, merged, closed, skipped };
}
