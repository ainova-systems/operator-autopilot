import { readFile, writeFile } from "node:fs/promises";
import { errorMessage } from "@operator/core";
import type { Logger } from "../../logging/logger.js";

/**
 * Write or update a `failure_reason: "..."` field in a work-item
 * file's YAML frontmatter for later observability / UI surfacing.
 *
 * Resolution rules:
 *  - If `failure_reason:` already exists in frontmatter, the line is
 *    replaced in place (so re-running on the same file does not
 *    accumulate duplicate keys).
 *  - Otherwise, the line is inserted immediately after the `status:`
 *    line. The work-items.ts parser tolerates field ordering as long
 *    as the value is a YAML scalar; inserting after `status:` keeps
 *    the field grouped with lifecycle metadata.
 *
 * Double-quote characters inside `reason` are backslash-escaped to
 * keep the YAML scalar valid. The primitive is best-effort: any I/O
 * failure (file disappeared mid-stage, permission flip, partial write)
 * is caught and logged as a warning so the stage flow continues. The
 * frontmatter field is supplementary diagnostic data — a missing
 * `failure_reason:` does not change the work-item status which is
 * written through the authoritative `updateStatusAndSync` path.
 *
 * The primitive is kind-agnostic and stage-name-agnostic — it
 * receives an absolute file path and a reason string.
 */
export async function writeFailureReason(
  filePath: string,
  reason: string,
  log?: Logger,
): Promise<void> {
  try {
    let content = await readFile(filePath, "utf-8");
    const escaped = reason.replace(/"/g, "\\\"");
    if (/^failure_reason:/m.test(content)) {
      content = content.replace(/^failure_reason:.*$/m, `failure_reason: "${escaped}"`);
    } else {
      content = content.replace(/^(status:\s*.+)$/m, `$1\nfailure_reason: "${escaped}"`);
    }
    await writeFile(filePath, content, "utf-8");
  } catch (err) {
    log?.warn(`failure-reason-writer: failed to write to ${filePath}`, {
      error: errorMessage(err),
    });
  }
}

/**
 * Remove failure-related frontmatter fields (`failed_at`,
 * `failure_reason`, `execution_attempts`) from a work-item file. Used
 * by stages that reset a `failed` item to `pending` for a retry — the
 * status flip alone would leave stale diagnostic data on the file,
 * which then leaks into the next cycle's agent context.
 *
 * Best-effort silent — a missing file or read failure is treated the
 * same as "no fields to clear". The primitive is kind-agnostic.
 */
export async function clearFailureFields(filePath: string): Promise<void> {
  try {
    let content = await readFile(filePath, "utf-8");
    content = content.replace(/^failed_at:.*\n/m, "");
    content = content.replace(/^failure_reason:.*\n/m, "");
    content = content.replace(/^execution_attempts:.*\n/m, "");
    await writeFile(filePath, content, "utf-8");
  } catch {
    // best-effort — caller has no recourse if the file is gone.
  }
}
