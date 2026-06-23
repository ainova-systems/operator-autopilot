const TRUNCATE_MARKER = "[…truncated]";
const HEADING_DEMOTE_BY = 2;
const MAX_HEADING_LEVEL = 6;

/**
 * Normalize a work-item markdown body for inline embedding in a PR description.
 *
 * The body is itself markdown carrying its own ATX headings (`#`, `##`, ...).
 * Dumped raw under the PR template's `### Summary` (an H3) those headings
 * outrank the template — a task body `# Title` renders as a top-level PR
 * heading and the description reads as competing sections instead of one
 * nested summary. This shapes the body to nest cleanly:
 *
 *   1. Drops the leading H1 — it duplicates the task title already shown on the
 *      template's `## Task {id}: {title}` line.
 *   2. Demotes every remaining heading by {@link HEADING_DEMOTE_BY} levels
 *      (capped at H6) so the shallowest (`##`) lands at H4, nested below the
 *      template's `### Summary`.
 *   3. Leaves `#` inside fenced code blocks untouched (shell comments, markdown
 *      samples) so embedded code stays verbatim.
 *   4. Truncates to `maxChars`, appending a marker, so a long task body cannot
 *      bloat the PR description.
 *
 * Pure string transform — no I/O. The orchestrator owns the PR body and this is
 * the single place a task body is shaped for it; agents never write the PR
 * description (see `engine/content/prompts/agents/context/base.md`).
 */
export function summarizeMarkdownForPr(body: string, maxChars: number): string {
  const shaped = demoteHeadings(dropLeadingH1(body)).trim();
  if (shaped.length <= maxChars) return shaped;
  return `${shaped.slice(0, maxChars).trimEnd()}\n\n${TRUNCATE_MARKER}`;
}

/**
 * Remove the first heading when it is an H1, so the task title is not repeated
 * inside the summary (the template's `## Task` line already carries it). Only
 * the leading H1 is dropped — later headings are content, not the title.
 */
function dropLeadingH1(body: string): string {
  const lines = body.split("\n");
  let i = 0;
  while (i < lines.length && lines[i].trim() === "") i++;
  if (i < lines.length && /^#\s+\S/.test(lines[i])) {
    lines.splice(i, 1);
    if (i < lines.length && lines[i].trim() === "") lines.splice(i, 1);
  }
  return lines.join("\n");
}

/**
 * Shift every ATX heading down {@link HEADING_DEMOTE_BY} levels (capped at H6),
 * skipping any line inside a fenced code block so `#` comments in samples are
 * preserved.
 */
function demoteHeadings(body: string): string {
  let inFence = false;
  return body
    .split("\n")
    .map((line) => {
      if (/^\s*(```|~~~)/.test(line)) {
        inFence = !inFence;
        return line;
      }
      if (inFence) return line;
      const match = /^(#{1,6})(\s)/.exec(line);
      if (!match) return line;
      const level = Math.min(match[1].length + HEADING_DEMOTE_BY, MAX_HEADING_LEVEL);
      return `${"#".repeat(level)}${line.slice(match[1].length)}`;
    })
    .join("\n");
}
