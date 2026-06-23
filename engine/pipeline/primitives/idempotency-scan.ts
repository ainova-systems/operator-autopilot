import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { readWorkItemFile } from "../../work-items/work-items.js";

/**
 * Input contract for {@link findChildrenByParentId}.
 *
 * `dataDir` is the kind-storage directory (e.g. `.operator/data/tasks`
 * for the `task` kind) and is supplied by the caller from the kind
 * registry. The primitive itself never branches on kind — it scans
 * whichever directory it's pointed at.
 */
export interface FindChildrenByParentIdInput {
  readonly dataDir: string;
  readonly parentId: string;
}

/**
 * Idempotency-scan primitive — kind-agnostic.
 *
 * Walks `dataDir` looking for work-item files whose frontmatter
 * `parent_id` matches `parentId`. Returns the matching child ids in
 * directory order. Used by stages whose `beforeAgent` hook needs to
 * detect "this work has already been done" — e.g. a prior plan PR was
 * merged into develop so the planner shouldn't re-run and risk a
 * deterministic-id collision and the corresponding PR-on-PR loop.
 *
 * Best-effort by design: silent on `readdir` failures (returns `[]`)
 * and on per-file parse errors (the file is skipped, the scan
 * continues). The caller can always re-run the upstream agent safely
 * if the result is incomplete — at worst the next cycle re-emits the
 * idempotent children.
 *
 * The engine code that composes this primitive does NOT branch on the
 * kind that owns `dataDir`. That dispatch happens in the caller via
 * the kind registry's storage descriptor.
 */
export async function findChildrenByParentId(
  input: FindChildrenByParentIdInput,
): Promise<string[]> {
  let files: string[];
  try {
    files = await readdir(input.dataDir);
  } catch {
    return [];
  }
  const matches: string[] = [];
  for (const file of files) {
    if (!file.endsWith(".md")) continue;
    try {
      const item = await readWorkItemFile(join(input.dataDir, file));
      if (item.parentId === input.parentId) matches.push(item.id);
    } catch {
      // Skip unreadable files — best-effort scan.
    }
  }
  return matches;
}
