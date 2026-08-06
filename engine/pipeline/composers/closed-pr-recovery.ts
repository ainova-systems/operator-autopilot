import { readdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import type {
  OperationContext, StateManager, VCSPlatform, TrackerPlatform,
  ConventionsConfig, PromptSource, KindRegistry, WorkItemKind,
} from "@operator/core";
import type { KindDefinition } from "@operator/core";
import { errorMessage } from "@operator/core";
import type { AgentRuntime } from "../../agents/runtime.js";
import type { AgentsFile } from "../../config/schemas.js";
import type { Logger } from "../../logging/logger.js";
import type { TemplateSource } from "../../agents/kv-template-source.js";
import {
  readWorkItemFile, updateWorkItemFileStatus, syncWorkItemToDb,
  type StateContextVars, type WorkItemFileData,
} from "../../work-items/work-items.js";
import { createRejectionIssue } from "./_shared/rejection-issue.js";
import { reopenWorkItem } from "./_shared/reopen-work-item.js";
import { runRejectionDiagnoser } from "./_shared/rejection-diagnoser.js";

/**
 * Rejection-handler sub-flow (ports v4 `processRejections` from the deleted
 * `engine/pipeline/stages/research.ts`). Triggered inline by the v5 research
 * stage by design: extracting this into a
 * standalone stage would duplicate cron plumbing + workspace scope for a
 * handful of filesystem + VCS reads that naturally share context with the
 * daily research tick. If usage diverges later (e.g. a non-research caller
 * needs it), lift this into its own runStage-backed stage at that point.
 *
 * Behavior (v4 parity — behavior-preserving port):
 *
 *   For every pending/reopened finding and task file on disk:
 *     1. Find a closed-unmerged PR on the item's per-item branch.
 *     2. Read user comments on that PR.
 *     3. `/duplicate` → mark `duplicate`
 *        `/cancel`    → mark `rejected`
 *        user feedback → invoke the diagnoser agent; on "poor-implementation"
 *                        or "approach-wrong" reopen up to MAX_REOPENS times;
 *                        otherwise create a rejection manual issue + `rejected`.
 *        no comments, under MAX_REOPENS → auto-retry (reopen)
 *        no comments, at MAX_REOPENS → create rejection manual issue + `rejected`.
 */

const MAX_REOPENS = 2;

export interface RejectionHandlerDeps {
  readonly vcs: VCSPlatform;
  readonly tracker?: TrackerPlatform;
  readonly state: StateManager;
  readonly agentRuntime: AgentRuntime;
  readonly kindRegistry: KindRegistry;
  readonly conventions: ConventionsConfig;
  readonly agentsConfig: AgentsFile;
  readonly promptSource: PromptSource;
  readonly automationDir: string;
  readonly findingsDir: string;
  readonly tasksDir: string;
  readonly templatesDir: string;
  readonly templates?: TemplateSource;
  readonly workspacePath: string;
  readonly stateVars?: StateContextVars;
  readonly log?: Logger;
}

export interface RejectionHandlerResult {
  readonly processed: number;
  readonly reopened: number;
  readonly rejected: number;
  readonly duplicated: number;
}

type Disposition = "reopened" | "rejected" | "duplicated";

export async function runRejectionHandler(
  deps: RejectionHandlerDeps,
  ctx: OperationContext,
): Promise<RejectionHandlerResult> {
  let processed = 0, reopened = 0, rejected = 0, duplicated = 0;

  // Iterate every registered kind. The file-prefix + directory are discovered
  // from the kind definition — adding a 4th kind to kinds.yaml (e.g. "plan"
  // with idPrefix "P" and dataDir "plans") Just Works without editing this
  // file. Tasks scan first so they process before their parent findings
  // (v4 parity: child items resolve before their parents on the same cron tick).
  const kindsByPriority = orderedKinds(deps.kindRegistry);
  for (const kindDef of kindsByPriority) {
    const dir = resolveKindDir(deps, kindDef);
    const files = await safeReaddir(dir, deps.log);
    for (const file of files) {
      if (!file.startsWith(kindDef.idPrefix) || !file.endsWith(".md")) continue;
      const filePath = join(dir, file);
      let item: WorkItemFileData;
      try {
        item = await readWorkItemFile(filePath);
      } catch (err) {
        deps.log?.warn(`rejection: unreadable ${kindDef.name} file ${file}, skipping`, {
          scope: "rejection", kind: kindDef.name, file, error: errorMessage(err),
        });
        continue;
      }
      if (deps.kindRegistry.isTerminal(kindDef.name, item.status)) continue;
      if (item.status !== "pending" && item.status !== "reopened") continue;
      const disposition = await processItem(deps, ctx, item, filePath, kindDef.name);
      if (disposition) {
        processed++;
        if (disposition === "reopened") reopened++;
        else if (disposition === "rejected") rejected++;
        else duplicated++;
      }
    }
  }

  return { processed, reopened, rejected, duplicated };
}

/**
 * Order kinds so that child kinds (tasks) are scanned before parent kinds
 * (findings), matching the v4 pattern where a single cron tick resolves
 * children first. We sort by `idPrefix` descending — "T" > "F" > other — so
 * the shipped kinds keep their historical order while unknown kinds land
 * between them by alphabetical tie-break. When child/parent ordering matters
 * for a specific deployment, define kinds accordingly in kinds.yaml.
 */
function orderedKinds(registry: KindRegistry): readonly KindDefinition[] {
  return [...registry.all].sort((a, b) => b.idPrefix.localeCompare(a.idPrefix));
}

/**
 * Resolve the workspace directory holding `{kind}.md` files. We honour the
 * caller-supplied `findingsDir` / `tasksDir` for the two shipped kinds (v4
 * parity — many tests stage files into explicit temp directories) and fall
 * back to `{automationDir}/data/{kindDef.dataDir}` for every other kind.
 */
function resolveKindDir(deps: RejectionHandlerDeps, kindDef: KindDefinition): string {
  if (kindDef.name === "finding") return deps.findingsDir;
  if (kindDef.name === "task") return deps.tasksDir;
  // New kinds (e.g. "plan") land under the workspace data directory. We
  // derive the data root from `findingsDir` (`.../data/findings`) so the
  // convention stays consistent regardless of which root the caller wired.
  const dataRoot = dirname(deps.findingsDir);
  return join(dataRoot, kindDef.dataDir);
}

async function processItem(
  deps: RejectionHandlerDeps,
  ctx: OperationContext,
  item: WorkItemFileData,
  filePath: string,
  kind: WorkItemKind,
): Promise<Disposition | null> {
  const branchPrefix = deps.kindRegistry.branchPrefixFor(kind);

  const rejectedPR = await findRejectedPR(deps.vcs, item.id, branchPrefix);
  if (!rejectedPR) return null;
  deps.log?.info(`rejection: processing rejected ${kind} ${item.id} (PR #${rejectedPR.id})`, {
    scope: "rejection", itemId: item.id, kind, prNumber: rejectedPR.id,
  });

  const prevCount = countPreviousPrs(item.previousPrs);
  const comments = await deps.vcs.getComments(rejectedPR.id);
  const userComments = comments
    .filter((c) => !c.body.includes(deps.conventions.commentMarker))
    .map((c) => c.body)
    .join("\n");

  if (/\/duplicate/i.test(userComments)) {
    await updateWorkItemFileStatus(filePath, "duplicate");
    await syncWorkItemToDb(deps.state, ctx, { ...item, status: "duplicate" });
    deps.log?.info(`rejection: ${item.id} marked duplicate via /duplicate`, {
      scope: "rejection", itemId: item.id, kind, disposition: "duplicated",
    });
    return "duplicated";
  }

  if (/\/cancel/i.test(userComments)) {
    await updateWorkItemFileStatus(filePath, "rejected");
    await syncWorkItemToDb(deps.state, ctx, { ...item, status: "rejected" });
    deps.log?.info(`rejection: ${item.id} marked rejected via /cancel`, {
      scope: "rejection", itemId: item.id, kind, disposition: "rejected",
    });
    return "rejected";
  }

  // User feedback → diagnoser pass.
  if (userComments.trim()) {
    const recommendation = await runRejectionDiagnoser(deps, ctx, item, userComments);
    if (shouldReopen(recommendation) && prevCount < MAX_REOPENS) {
      await reopenWorkItem(filePath, item, rejectedPR.id, deps.state, ctx);
      return "reopened";
    }
    await createRejectionIssue(deps, item, kind, rejectedPR.id, recommendation, prevCount);
    await updateWorkItemFileStatus(filePath, "rejected");
    await syncWorkItemToDb(deps.state, ctx, { ...item, status: "rejected" });
    return "rejected";
  }

  // No user comments: auto-retry until MAX_REOPENS.
  if (prevCount < MAX_REOPENS) {
    await reopenWorkItem(filePath, item, rejectedPR.id, deps.state, ctx);
    return "reopened";
  }

  await createRejectionIssue(deps, item, kind, rejectedPR.id, "max-retries", prevCount);
  await updateWorkItemFileStatus(filePath, "rejected");
  await syncWorkItemToDb(deps.state, ctx, { ...item, status: "rejected" });
  return "rejected";
}

async function findRejectedPR(
  vcs: VCSPlatform,
  itemId: string,
  branchPrefix: string,
): Promise<{ id: number } | null> {
  const prs = await vcs.getCodeReviews();
  const branch = `${branchPrefix}/${itemId}`;
  const rejected = prs.find((pr) => pr.branch === branch && pr.closed && !pr.merged);
  return rejected ? { id: rejected.id } : null;
}

function shouldReopen(recommendation: string): boolean {
  return recommendation === "poor-implementation" || recommendation === "approach-wrong";
}

function countPreviousPrs(previousPrs?: string): number {
  if (!previousPrs) return 0;
  return previousPrs.split(",").filter((s) => /\d/.test(s)).length;
}

async function safeReaddir(dir: string, log?: Logger): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch (err) {
    log?.debug(`rejection: directory ${dir} not readable`, {
      scope: "rejection", dir, error: errorMessage(err),
    });
    return [];
  }
}
