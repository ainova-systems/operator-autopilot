import type {
  VCSPlatform, KindRegistry, ConventionsConfig,
} from "@operator/core";
import {
  listPendingItems, summarizeTasks,
  collectMergedPRFeedback, collectRejectedPRFeedback,
} from "../../work-items/work-items.js";

/**
 * Dependencies for {@link aggregateRetrospectiveMetrics}. The primitive
 * is kind-aware but stage-name-agnostic — the caller passes whichever
 * VCSPlatform / KindRegistry / data dir / conventions instance is in
 * scope for the current cycle. Currently consumed by the
 * `retrospective` composer but reusable by any future stage that
 * needs a markdown brief of "what happened across the work-item
 * kinds last period".
 */
export interface MetricsAggregatorDeps {
  readonly vcs: VCSPlatform;
  readonly kindRegistry: KindRegistry;
  /** Workspace root — per-kind dirs are resolved via `join(workspacePath, kindDef.dataDir)`. */
  readonly workspacePath: string;
  readonly conventions: ConventionsConfig;
}

/**
 * Aggregate a markdown metrics brief covering the recent state of the
 * work-item kinds. Used as the improver agent's `taskContent` for
 * weekly retrospectives but the output shape is generic — any
 * downstream consumer that wants a "current state of the queue plus
 * what changed in PRs" snapshot can use it.
 *
 * Sections, in order:
 *
 *  1. Task Statistics — counts of completed / failed / pending items
 *     of the `task` kind aggregated by {@link summarizeTasks}.
 *  2. Recently Completed Tasks — top 10 most-recent by `completedAt`,
 *     each rendered as `**id**: title (completed: ts)`; `(none)` when
 *     empty.
 *  3. Pending Findings — `listPendingItems("finding", …)` rendered as
 *     `**id** (source): title`; `(none)` when empty.
 *  4. Current Task Queue — the `pending` set from §1 rendered as
 *     `**id** (Ppriority): title`; `(none)` when empty.
 *  5. Merged PR Feedback — comments harvested by {@link collectMergedPRFeedback}
 *     filtered through `conventions.commentMarker`.
 *  6. Rejected PR Feedback — analogous to §5 via {@link collectRejectedPRFeedback}.
 *
 * The function is read-only — no writes to KV, no writes to git, no
 * agent invocations. All I/O routes through the supplied dependencies
 * so tests can inject fakes.
 */
export async function aggregateRetrospectiveMetrics(
  deps: MetricsAggregatorDeps,
): Promise<string> {
  const sections: string[] = [];

  const { completed, failed, pending } = await summarizeTasks(
    deps.kindRegistry, deps.workspacePath,
  );
  sections.push(
    `## Task Statistics\n- Completed: ${completed.length}\n- Failed: ${failed.length}\n- Pending: ${pending.length}`,
  );

  const recent = [...completed]
    .sort((a, b) => (b.completedAt ?? "").localeCompare(a.completedAt ?? ""))
    .slice(0, 10);
  const recentLines = recent.length === 0
    ? "(none)"
    : recent
      .map((t) => `- **${t.id}**: ${t.title}${t.completedAt ? ` (completed: ${t.completedAt})` : ""}`)
      .join("\n");
  sections.push(`## Recently Completed Tasks\n${recentLines}`);

  const findings = await listPendingItems(
    deps.kindRegistry, "finding", deps.workspacePath,
  );
  const findingLines = findings.length === 0
    ? "(none)"
    : findings
      .map((f) => `- **${f.id}** (${f.source || "unknown"}): ${f.title}`)
      .join("\n");
  sections.push(`## Pending Findings\n${findingLines}`);

  const queueLines = pending.length === 0
    ? "(none)"
    : pending.map((t) => `- **${t.id}** (P${t.priority}): ${t.title}`).join("\n");
  sections.push(`## Current Task Queue\n${queueLines}`);

  const mergedFeedback = await collectMergedPRFeedback(deps.vcs, deps.conventions.commentMarker);
  sections.push(`## Merged PR Feedback\n${mergedFeedback}`);
  const rejectedFeedback = await collectRejectedPRFeedback(deps.vcs, deps.conventions.commentMarker);
  sections.push(`## Rejected PR Feedback\n${rejectedFeedback}`);

  return sections.join("\n\n");
}
