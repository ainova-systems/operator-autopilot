import { join } from "node:path";
import type {
  OperationContext, StateManager, WorkItem, WorkItemKind, KindRegistry,
} from "@operator/core";
import { errorMessage } from "@operator/core";
import type { Logger } from "../../logging/logger.js";
import {
  readWorkItemFile,
  type WorkItemFileData,
} from "../../work-items/work-items.js";

/**
 * Extract domain tokens from a work-item's `path` frontmatter field.
 *
 * Two recognition strategies, both lowercase-normalised and deduplicated:
 *
 *  1. Repeated `Source/Layer/src/Domain/SubDomain` matches anywhere in
 *     the string — the first capture group becomes the domain. Used by
 *     repos whose path conventions follow this layout to express
 *     "this work touches the Catalog domain".
 *  2. When no `(?:Source/.../src/...)` match is found and the path is
 *     not the wildcard `*`, the last non-empty slash-segment with stars
 *     stripped is used as a fallback domain ("libs/shared/tools" →
 *     "tools").
 *
 * Pure synchronous string function — no I/O, no kind awareness.
 */
export function extractDomains(path?: string): string[] {
  if (!path) return [];
  const domains: string[] = [];
  const pattern = /(?:Source\/\w+\/src\/([^/]+)\/([^/]+))/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(path)) !== null) {
    domains.push(match[1].toLowerCase());
  }
  if (domains.length === 0 && path !== "*") {
    const parts = path.split("/").filter(Boolean);
    if (parts.length >= 2) {
      domains.push(parts[parts.length - 1].replace(/\*+/g, "").toLowerCase());
    }
  }
  return [...new Set(domains)];
}

/**
 * Predicate: does the given work-item's path overlap any of the
 * supplied in-progress domain tokens?
 *
 * Pure synchronous function — caller supplies the in-progress set
 * (typically via {@link collectInProgressDomains}). Useful as a
 * standalone unit-tested building block; the higher-level
 * {@link buildConflictFilter} composes it inside the per-item filter.
 */
export function hasConflict(
  file: WorkItemFileData,
  inProgressDomains: Set<string>,
): boolean {
  if (inProgressDomains.size === 0) return false;
  const domains = extractDomains(file.path);
  if (domains.length === 0) return false;
  return domains.some((d) => inProgressDomains.has(d));
}

/**
 * Predicate: does the given work-item have at least one declared
 * dependency that is not yet completed? An unreadable / missing
 * dependency file is treated as unmet to keep the gate strict; the
 * caller logs the failure so operators can spot dangling links.
 *
 * `dataDir` is the kind-storage directory supplied by the caller from
 * the kind registry. The primitive itself never branches on kind.
 */
export async function hasUnmetDeps(
  file: WorkItemFileData,
  dataDir: string,
  log?: Logger,
): Promise<boolean> {
  if (!file.dependsOn || file.dependsOn.length === 0) return false;
  for (const depId of file.dependsOn) {
    const depPath = join(dataDir, `${depId}.md`);
    try {
      const dep = await readWorkItemFile(depPath);
      if (dep.status !== "completed") return true;
    } catch (err) {
      log?.warn(`conflict-filter: dependency ${depId} unreadable for ${file.id} (treating as unmet)`, {
        itemId: file.id, depId, error: errorMessage(err),
      });
      return true;
    }
  }
  return false;
}

/**
 * Walk a list of work-items, read each one's file from `dataDir`, and
 * collect the union of domain tokens for those in `in-progress`
 * status. Used by {@link buildConflictFilter} to compute the set
 * against which {@link hasConflict} runs.
 *
 * Best-effort on read failures: a single broken file logs a warning
 * and is skipped, the scan continues.
 */
export async function collectInProgressDomains(
  items: WorkItem[],
  dataDir: string,
  log?: Logger,
): Promise<Set<string>> {
  const domains = new Set<string>();
  for (const item of items) {
    if (item.status !== "in-progress") continue;
    try {
      const fileItem = await readWorkItemFile(join(dataDir, `${item.id}.md`));
      for (const d of extractDomains(fileItem.path)) domains.add(d);
    } catch (err) {
      log?.warn(`conflict-filter: failed to read in-progress ${item.id}.md for domain check`, {
        itemId: item.id, error: errorMessage(err),
      });
    }
  }
  return domains;
}

/**
 * Dependencies for the higher-level {@link buildConflictFilter}
 * factory. The `kind` parameter is what makes this primitive
 * stage-name-agnostic — the caller passes the kind from the stage
 * definition (e.g. `"task"` for a `task-execute` stage); the
 * primitive itself never carries a hardcoded kind constant.
 */
export interface ConflictFilterDeps {
  readonly state: StateManager;
  readonly kindRegistry: KindRegistry;
  readonly dataDir: string;
  readonly kind: WorkItemKind;
  readonly log?: Logger;
}

/**
 * Build the per-item filter closure for a stage that needs domain-conflict
 * and dependency-readiness checks (currently consumed by the
 * `task-execute` composer). The returned predicate returns `true` when the item
 * should be picked, `false` when it should be skipped this cycle.
 *
 * The selector runs before the stage checks out the item's own branch, so
 * the workspace may still be on an unrelated branch from a previous
 * stage. Work-item files created on another feature branch are
 * legitimately absent here. The filter does not exclude on a missing
 * file — the item becomes selectable, `WorkspaceScope.prepare` switches
 * to its own branch, and `beforeAgent` reads the real file. Conflict /
 * dependency checks therefore only run when the file is available; a
 * missing file short-circuits to "no known conflict, no known unmet
 * dep" but still respects the KV-state terminal check below.
 */
export function buildConflictFilter(deps: ConflictFilterDeps) {
  return async (item: WorkItem, ctx: OperationContext): Promise<boolean> => {
    const filePath = join(deps.dataDir, `${item.id}.md`);
    let fileData: WorkItemFileData | null = null;
    try {
      fileData = await readWorkItemFile(filePath);
    } catch (err) {
      deps.log?.debug(`conflict-filter: ${item.id}.md not on current workspace branch — deferring checks to beforeAgent`, {
        itemId: item.id, error: errorMessage(err),
      });
    }

    if (fileData) {
      if (deps.kindRegistry.isTerminal(deps.kind, fileData.status as WorkItem["status"])) {
        return false;
      }
      const allItems = await deps.state.listWorkItems(ctx, { kind: deps.kind });
      const inProgressDomains = await collectInProgressDomains(allItems, deps.dataDir, deps.log);
      if (hasConflict(fileData, inProgressDomains)) {
        deps.log?.debug(`conflict-filter: ${item.id} conflicts with in-progress ${deps.kind} domain`, {
          itemId: item.id, kind: deps.kind,
        });
        return false;
      }
      if (await hasUnmetDeps(fileData, deps.dataDir, deps.log)) {
        deps.log?.debug(`conflict-filter: ${item.id} has unmet dependencies`, {
          itemId: item.id, dependsOn: fileData.dependsOn,
        });
        return false;
      }
    }

    // Fall back to KV-state terminal check when file is absent — catches
    // the case where syncFilesToState saw the item earlier in the cycle
    // on a different branch and recorded a terminal status we should
    // respect even without the current file.
    if (deps.kindRegistry.isTerminal(deps.kind, item.status)) {
      return false;
    }

    return true;
  };
}
