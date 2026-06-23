import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { ChecksObservation, CheckRun, CheckAnnotation } from "@operator/core";

/**
 * CI / pipeline context primitive (D-503).
 *
 * Materialises a {@link ChecksObservation} into a deterministic markdown
 * file inside the OS temp directory and returns its absolute path. The
 * file is the unit of context the engine hands to the agent when CI has
 * failed: provider-neutral, file-only, no shell access required (agent
 * reads via the `Read` tool inside its sandbox).
 *
 * Contract guarantees:
 *
 *   1. **Provider-neutral.** The formatter does not branch on platform
 *      name. If a future GitLab adapter fills the same `CheckRun` shape
 *      the output is identical in structure.
 *   2. **Bounded size.** Each per-check section caps `summary` and `text`
 *      to the truncation already applied by the adapter; `annotations`
 *      are listed as a table capped at 50 rows per check (also adapter
 *      enforced). The file rarely exceeds ~30KB even for repos with
 *      verbose CI.
 *   3. **Read-only side effects.** Only writes to a fresh temp file —
 *      caller is responsible for cleanup if it cares; the OS reclaims
 *      `/tmp` eventually. Never modifies workspace files or KV.
 */

export interface ChecksContextDeps {
  /**
   * Override the temp directory root. Defaults to `os.tmpdir()`. Tests
   * pass a `mkdtemp`-created directory to keep fixtures isolated.
   */
  readonly tempDir?: string;
}

export interface WriteChecksContextInput {
  readonly observation: ChecksObservation;
  /** PR number — embedded in the filename for human-readable triage. */
  readonly prNumber: number;
  /** Branch name — included as a header so the file is self-describing. */
  readonly branch: string;
}

/**
 * Write the context file. Returns the absolute path. Called by stages
 * that need to surface CI context to the agent — currently `pr-review`,
 * but any future stage can reuse it.
 */
export async function writeChecksContextFile(
  input: WriteChecksContextInput,
  deps: ChecksContextDeps = {},
): Promise<string> {
  const root = deps.tempDir ?? tmpdir();
  const stamp = `${Date.now()}-${randomBytes(4).toString("hex")}`;
  const filePath = join(root, `operator-checks-pr${input.prNumber}-${stamp}.md`);
  const body = formatContext(input);
  await writeFile(filePath, body, "utf-8");
  return filePath;
}

/**
 * Pure formatter — exposed for unit tests so the markdown shape is
 * pinned independently of any filesystem write.
 */
export function formatContext(input: WriteChecksContextInput): string {
  const { observation, prNumber, branch } = input;
  const lines: string[] = [];
  lines.push(`# CI Pipeline Context — PR #${prNumber}`);
  lines.push("");
  lines.push(`- Branch: \`${branch}\``);
  lines.push(`- Aggregate status: **${observation.value}**`);
  if (observation.headSha) lines.push(`- Head SHA: \`${observation.headSha}\``);
  lines.push(`- Observed at: ${observation.observedAt}`);
  lines.push("");

  const failing = observation.checks.filter((c) => isFailing(c));
  const pending = observation.checks.filter((c) => isPending(c));
  const passing = observation.checks.filter((c) => !isFailing(c) && !isPending(c));

  if (failing.length > 0) {
    lines.push(`## Failing checks (${failing.length})`);
    lines.push("");
    for (const check of failing) lines.push(...renderCheckSection(check));
  }

  if (pending.length > 0) {
    lines.push(`## Pending checks (${pending.length})`);
    lines.push("");
    for (const check of pending) lines.push(...renderCheckSection(check));
  }

  if (passing.length > 0) {
    lines.push(`## Passing checks (${passing.length})`);
    lines.push("");
    for (const check of passing) {
      lines.push(`- ✓ **${check.name}** (${check.conclusion})`);
    }
    lines.push("");
  }

  if (failing.length === 0 && pending.length === 0 && passing.length === 0) {
    lines.push("> No checks reported by the platform.");
    lines.push("");
  }

  lines.push("---");
  lines.push("");
  lines.push("Read this file before deciding on a fix. Do NOT declare \"no changes needed\"");
  lines.push("on a failing PR without inspecting the failure details above. Annotation rows");
  lines.push("point to specific file:line locations; the workflow URLs link to full logs in");
  lines.push("a browser if you need raw output beyond the summaries listed here.");
  return lines.join("\n");
}

function isFailing(c: CheckRun): boolean {
  const k = c.conclusion?.toLowerCase() ?? "";
  return k === "failure" || k === "timed_out" || k === "action_required" || k === "startup_failure";
}

function isPending(c: CheckRun): boolean {
  const k = c.conclusion?.toLowerCase() ?? "";
  return k === "" || k === "pending" || k === "in_progress" || k === "queued";
}

function renderCheckSection(check: CheckRun): string[] {
  const lines: string[] = [];
  const head = `### ✗ ${check.name} (${check.conclusion})`;
  lines.push(head);
  lines.push("");
  if (check.workflowName) lines.push(`- Workflow: ${check.workflowName}`);
  if (check.workflowRunId) lines.push(`- Run id: ${check.workflowRunId}`);
  if (check.completedAt) lines.push(`- Completed: ${check.completedAt}`);
  if (check.detailsUrl) lines.push(`- Logs: ${check.detailsUrl}`);
  if (check.headSha) lines.push(`- Commit: \`${check.headSha}\``);
  lines.push("");
  if (check.title) {
    lines.push(`**${check.title}**`);
    lines.push("");
  }
  if (check.summary) {
    lines.push("**Summary**");
    lines.push("");
    lines.push("```");
    lines.push(check.summary);
    lines.push("```");
    lines.push("");
  }
  if (check.text) {
    lines.push("**Details**");
    lines.push("");
    lines.push("```");
    lines.push(check.text);
    lines.push("```");
    lines.push("");
  }
  if (check.annotations && check.annotations.length > 0) {
    lines.push(`**Annotations (${check.annotations.length})**`);
    lines.push("");
    lines.push("| Severity | File | Line | Message |");
    lines.push("|---|---|---|---|");
    for (const a of check.annotations) lines.push(renderAnnotationRow(a));
    lines.push("");
  }
  return lines;
}

function renderAnnotationRow(a: CheckAnnotation): string {
  const lineCol = a.endLine && a.endLine !== a.startLine ? `${a.startLine}-${a.endLine}` : String(a.startLine);
  const msg = (a.title ? `**${a.title}** — ` : "") + sanitizeCell(a.message);
  return `| ${a.severity} | \`${a.path}\` | ${lineCol} | ${msg} |`;
}

function sanitizeCell(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}
