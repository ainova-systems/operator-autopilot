import type { KVStore, ExecutionEntry } from "@operator/core";

/**
 * Agent context enrichment (Step 14, Phase E).
 *
 * Queries `kv:executions/*` for the last N executions on a given work item,
 * extracts each `summary` field, and renders a Markdown
 * `## Execution History` block suitable for prepending to an agent system
 * prompt. No I/O other than the KV read.
 *
 * Budget: at most {@link EXECUTION_HISTORY_LIMIT} summaries, each truncated
 * to {@link EXECUTION_HISTORY_CHAR_CAP} chars.
 */

export const EXECUTION_HISTORY_LIMIT = 3;
export const EXECUTION_HISTORY_CHAR_CAP = 500;

/**
 * Load and render the execution-history section for a given work item. When
 * the item has no prior executions or `kv` is absent, returns an empty
 * string so callers can unconditionally concatenate.
 */
export async function buildExecutionHistoryBlock(
  kv: KVStore | undefined,
  workItemId: string | undefined,
): Promise<string> {
  if (!kv || !workItemId) return "";

  // List every execution row; filter by workItemId in memory. The KVStore
  // doesn't support JSON-field WHERE on SQLite for arbitrary keys at the
  // level of an uniform interface, so this is the simplest correct path.
  const rows = await kv.list("executions", { limit: 200 });
  const matches = rows
    .map((r) => r.value as Partial<ExecutionEntry>)
    .filter((e) => e.workItemId === workItemId && typeof e.summary === "string" && e.summary.length > 0)
    .sort((a, b) => {
      const aT = a.startedAt ? Date.parse(a.startedAt) : 0;
      const bT = b.startedAt ? Date.parse(b.startedAt) : 0;
      return bT - aT;
    })
    .slice(0, EXECUTION_HISTORY_LIMIT);

  if (matches.length === 0) return "";

  const lines = matches.map((e, i) => {
    const stage = e.stageName ?? "stage";
    const verdict = e.verdict ?? "unknown";
    const when = e.startedAt ?? "";
    const summary = (e.summary ?? "").slice(0, EXECUTION_HISTORY_CHAR_CAP);
    return `### Attempt ${i + 1} — ${stage} (${verdict}) ${when}\n${summary}`;
  });

  return [
    "## Execution History",
    "",
    `Prior runs on this work item (most recent first, up to ${EXECUTION_HISTORY_LIMIT}):`,
    "",
    ...lines,
    "",
  ].join("\n");
}
