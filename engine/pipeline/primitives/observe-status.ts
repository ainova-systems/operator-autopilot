import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  WorkItemStatus,
  DevelopFileObservation,
  FeatureBranchFileObservation,
  PrLabelObservation,
  ExecutionVerdictObservation,
  PrStateObservation,
  ChecksObservation,
  CheckRun,
  KVStore,
  OperationContext,
  VCSPlatform,
} from "@operator/core";
import type { WorkspaceGit } from "../../infra/git.js";
import type { PRManager } from "../../delivery/pr-manager.js";
import { recordTerminalPRStates } from "./pr-state-cache.js";

/**
 * Status observation primitive (Step 14).
 *
 * Each exported function captures one of the four status signals described in
 * `architecture-v5.md §6.3` and returns a structured observation ready to be
 * written into `kv:work-items/{id}.statusSources`. Pure I/O — no KV writes
 * here; the caller is responsible for aggregating + reconciling + persisting.
 *
 * Called from:
 *   - `syncFilesToState` (develop-file + PR label observations, once per cycle)
 *   - `persist-output.ts` (feature-branch file observation before + after commit)
 *   - `route-verdict.ts` (execution-verdict observation at stage exit)
 */

const KNOWN_STATUSES: ReadonlySet<WorkItemStatus> = new Set([
  "pending",
  "in-progress",
  "completed",
  "failed",
  "cancelled",
  "rejected",
  "duplicate",
  "reopened",
]);

/**
 * Read the `status:` field from the YAML frontmatter of a file at `relPath`
 * under `workspacePath`. Returns `missing` when the file is absent or the
 * frontmatter cannot be parsed. `sha` is filled by the caller via
 * {@link headSha}; this function is file-only.
 */
export async function readFrontmatterStatus(
  workspacePath: string,
  relPath: string,
): Promise<{ value: WorkItemStatus | "missing" }> {
  try {
    const content = await readFile(join(workspacePath, relPath), "utf-8");
    const parts = content.split(/^---\s*$/m);
    if (parts.length < 3) return { value: "missing" };
    const match = parts[1].match(/^\s*status:\s*["']?([a-zA-Z-]+)["']?\s*$/m);
    if (!match) return { value: "missing" };
    const raw = match[1];
    if (KNOWN_STATUSES.has(raw as WorkItemStatus)) {
      return { value: raw as WorkItemStatus };
    }
    return { value: "missing" };
  } catch {
    return { value: "missing" };
  }
}

/** Deps for {@link observeDevelopFile}. Narrow surface = easy testing. */
export interface ObserveDevelopFileDeps {
  readonly git: Pick<WorkspaceGit, "headSha">;
  readonly workspacePath: string;
  readonly workspaceDataDir: string;
}

/** Item fields the develop-file observer needs. */
export interface ObservableItem {
  readonly id: string;
  readonly kind: string;
  readonly path?: string;
}

/**
 * Observe a work item's status as recorded in its develop-branch file. Uses
 * the registry-provided dataDir convention and the id to locate the file at
 * `{dataDir}/{id}.md`. Returns a DevelopFileObservation ready to write to
 * `statusSources.developFile`.
 */
export async function observeDevelopFile(
  item: ObservableItem,
  dataDirForKind: string,
  deps: ObserveDevelopFileDeps,
): Promise<DevelopFileObservation> {
  const relPath = item.path ?? join(dataDirForKind, `${item.id}.md`);
  const [status, sha] = await Promise.all([
    readFrontmatterStatus(deps.workspacePath, relPath),
    deps.git.headSha().catch(() => ""),
  ]);
  return {
    value: status.value,
    observedAt: new Date().toISOString(),
    sha: sha || undefined,
    path: relPath,
  };
}

/** Deps for {@link observeFeatureBranchFile}. */
export interface ObserveFeatureBranchFileDeps {
  readonly git: Pick<WorkspaceGit, "headSha">;
  readonly workspacePath: string;
}

/**
 * Observe a work item's status on a feature branch (e.g. `ai/tasks/T-0001`).
 * Called by `persist-output.ts` before and after the commit so the execution
 * events stream captures both pre- and post-agent state.
 */
export async function observeFeatureBranchFile(
  item: ObservableItem,
  relPath: string,
  branch: string,
  deps: ObserveFeatureBranchFileDeps,
): Promise<FeatureBranchFileObservation> {
  const [status, sha] = await Promise.all([
    readFrontmatterStatus(deps.workspacePath, relPath),
    deps.git.headSha().catch(() => ""),
  ]);
  return {
    value: status.value,
    observedAt: new Date().toISOString(),
    branch,
    sha: sha || undefined,
  };
}

/** Deps for {@link observePRLabel}. */
export interface ObservePRLabelDeps {
  readonly prManager: Pick<PRManager, "findOpenPR">;
  /**
   * Optional: when supplied, the observer falls back to closed PRs so
   * a terminated work item still records its historical PR (#N, label,
   * branch). Without this, completed/failed/cancelled items render as
   * "PR: —" in the App UI even when a real PR exists in the platform.
   */
  readonly vcs?: Pick<import("@operator/core").VCSPlatform, "getCodeReviews">;
}

/**
 * Observe a work item's PR label. Looks up the open PR first; when no
 * open PR exists and a `vcs` is supplied, falls back to the most
 * recent closed/merged PR for the same branch so terminated items
 * still expose their historical PR number + label. Returns `null`
 * only when neither lookup yields a PR.
 */
export async function observePRLabel(
  branch: string,
  deps: ObservePRLabelDeps,
): Promise<PrLabelObservation | null> {
  const open = await deps.prManager.findOpenPR(branch);
  if (open) {
    const aiLabel = open.labels.find((l) => l.name.startsWith("ai:"));
    return {
      value: aiLabel?.name ?? "ai:open",
      observedAt: new Date().toISOString(),
      prNumber: open.id,
      branch,
    };
  }
  if (!deps.vcs) return null;
  const closed = await deps.vcs.getCodeReviews({ state: "closed" });
  const match = closed.find((pr) => pr.branch === branch);
  if (!match) return null;
  const aiLabel = match.labels.find((l) => l.name.startsWith("ai:"));
  return {
    value: aiLabel?.name ?? (match.merged ? "ai:merged" : "ai:closed"),
    observedAt: new Date().toISOString(),
    prNumber: match.id,
    branch,
  };
}

/** Deps for {@link observePRState}. */
export interface ObservePRStateDeps {
  readonly prManager: Pick<PRManager, "findOpenPR">;
  readonly vcs: Pick<import("@operator/core").VCSPlatform, "getCodeReviews">;
  /**
   * When supplied, every terminal PR seen in the closed-list lookup is
   * upserted into the per-PR cache (`kv:pr-states/{prNumber}`) so the
   * App UI can resolve historical PR states reliably even after the
   * work-item observation overwrites with a newer PR. No-op when
   * absent (tests and pre-Step-14 callers).
   */
  readonly kv?: KVStore;
  /** Required only when `kv` is supplied. */
  readonly ctx?: OperationContext;
}

/**
 * Observe the state of the item's most recent PR: open / merged / closed.
 * Distinguishes "AI done, waiting for human merge" (open) from "merged but
 * develop still lagging" (merged, actual drift) from "cancelled" (closed).
 *
 * Looks for an open PR on the branch first; falls back to recently-closed
 * PRs (the `getCodeReviews({state: "closed"})` cache is already warm from
 * retrospective helpers, so this is cheap) to detect merged/closed state.
 */
export async function observePRState(
  branch: string,
  deps: ObservePRStateDeps,
): Promise<PrStateObservation> {
  const open = await deps.prManager.findOpenPR(branch);
  if (open) {
    return {
      value: "open",
      observedAt: new Date().toISOString(),
      prNumber: open.id,
      branch,
    };
  }
  // A branch can carry several closed PRs over its lifetime. The work-item
  // should reflect the **most recent** PR's state — what a human sees if
  // they look at the branch on GitHub right now — rather than an earlier
  // merged PR that has since been superseded by a closed-without-merge
  // attempt. The closed list comes back sorted by `updated desc`, so the
  // first match is the most recently-touched PR for this branch.
  const closed = await deps.vcs.getCodeReviews({ state: "closed" });

  // Side-effect: persist every terminal PR's state in the cache so the
  // App can resolve historical prNumber → state lookups (the work-item
  // observation only knows the latest PR — see pr-state-cache.ts).
  // Best-effort: failures here must not break the observation.
  if (deps.kv && deps.ctx) {
    try {
      await recordTerminalPRStates(closed, deps.kv, deps.ctx);
    } catch {
      // Cache write is non-critical; swallow errors.
    }
  }

  const match = closed.find((pr) => pr.branch === branch);
  if (!match) {
    return { value: "none", observedAt: new Date().toISOString(), branch };
  }
  return {
    value: match.merged ? "merged" : "closed",
    observedAt: new Date().toISOString(),
    prNumber: match.id,
    branch,
  };
}

/**
 * Capture the most recent execution verdict as a status-source observation.
 * Pure data shaping — the caller reads the verdict from the `AgentResult`
 * after `route-verdict` finishes.
 */
export function observeExecutionVerdict(
  executionId: string,
  verdict: "approved" | "failed" | "cancelled" | "rejected",
  stageName?: string,
): ExecutionVerdictObservation {
  return {
    value: verdict,
    observedAt: new Date().toISOString(),
    executionId,
    stageName,
  };
}

/** Deps for {@link observeChecks}. */
export interface ObserveChecksDeps {
  readonly vcs: Pick<VCSPlatform, "getCheckRuns">;
}

/**
 * Aggregate per-check conclusions into the worst-of value used by
 * {@link ChecksObservation.value}. Order of severity (worst → best):
 *
 *   failure / timed_out / action_required / startup_failure → "failing"
 *   in_progress / queued / pending / "" / null               → "pending"
 *   success / neutral / skipped / cancelled                  → "passing"
 *
 * Empty checks list → "none". Cancelled checks alone do not flip the
 * aggregate to failing — they are usually intentional (PR closed or
 * superseded), and the engine has its own signal for closed PRs.
 */
export function aggregateChecks(checks: ReadonlyArray<CheckRun>): ChecksObservation["value"] {
  if (checks.length === 0) return "none";
  let pending = false;
  for (const c of checks) {
    const conclusion = c.conclusion?.toLowerCase() ?? "";
    if (conclusion === "failure" || conclusion === "timed_out"
        || conclusion === "action_required" || conclusion === "startup_failure") {
      return "failing";
    }
    if (conclusion === "" || conclusion === "pending"
        || conclusion === "in_progress" || conclusion === "queued") {
      pending = true;
    }
  }
  return pending ? "pending" : "passing";
}

/**
 * Observe CI / pipeline status for a PR. Returns `{value: "none"}` when
 * the platform exposes no `getCheckRuns` capability or no PR exists for
 * the branch — callers can omit the slot in that case. Errors surface as
 * `none` (best-effort observation; never fail the cycle on CI metadata).
 */
export async function observeChecks(
  prNumber: number | undefined,
  deps: ObserveChecksDeps,
): Promise<ChecksObservation> {
  const observedAt = new Date().toISOString();
  if (!prNumber || !deps.vcs.getCheckRuns) {
    return { value: "none", observedAt, checks: [] };
  }
  try {
    const checks = await deps.vcs.getCheckRuns(prNumber);
    const value = aggregateChecks(checks);
    const headSha = checks[0]?.headSha;
    return { value, observedAt, headSha, checks };
  } catch {
    return { value: "none", observedAt, checks: [] };
  }
}
