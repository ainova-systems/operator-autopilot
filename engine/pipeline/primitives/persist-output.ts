import type { OperationContext, VCSPlatform, CodeReview, KVStore } from "@operator/core";
import { WorkspaceError } from "@operator/core";
import type { WorkspaceGit } from "../../infra/git.js";
import type { PRManager } from "../../delivery/pr-manager.js";
import type { Logger } from "../../logging/logger.js";
import type { StageDef, StageInput, AgentResult, Verdict } from "../types.js";
import type { WorkspaceHandle } from "./workspace-scope.js";
import { observeFeatureBranchFile, observePRState } from "./observe-status.js";
import { stampWorkItem } from "../../work-items/work-items.js";

/**
 * Output persistence primitive — step 7 of the 8-step `runStage` loop.
 *
 * Frozen signature (`architecture-v5.md §3.1.1`, locked in Step 8c):
 *
 *   persist(stageDef, input, agentResult, workspace, stagePersistInput, ctx)
 *
 * The adapter is strictly fast-forward:
 *
 *   1. `git.addAll()`
 *   2. `git.commitIfChanged(commitMessage)` — returns `null` when the
 *      workspace has no staged changes, in which case the adapter
 *      short-circuits and reports `committed: false`. No push, no PR.
 *   3. `git.push(branch)` — uses `WorkspaceGit.push` which is plain
 *      `git push -u origin <branch>`. Non-fast-forward pushes fail the
 *      stage; there is no retry with force.
 *   4. `prManager.findOpenPR(branch)` — reuse an existing PR if any.
 *   5. Otherwise create via `prManager.createDraft` (when
 *      `stagePersistInput.pr.draft === true`) or
 *      `vcs.createCodeReview({draft:false})`.
 *   6. Label transition:
 *      - `agentResult.verdict !== "approved"` → `markFailed`
 *      - `agentResult.verdict === "approved"` && `onSuccess === "in-review"` → `markInReview`
 *      - `agentResult.verdict === "approved"` && `onSuccess === "ready-to-merge"` → `markReadyToMerge`
 *      - otherwise no label transition (draft + `ai:pending` left in place)
 *
 * Consumed exclusively by `runStage` (step 8b onwards). Pre-Step-8c direct
 * callers in `entry.ts` case blocks (research / improver) construct minimal
 * `StageDef` / `AgentResult` shims until Steps 11-12 migrate them to
 * `runStage` proper and delete the shims.
 */

/** Minimal shape of {@link WorkspaceGit} consumed by the persist primitive. */
type WorkspaceGitPersistLike = Pick<
  WorkspaceGit,
  "addAll" | "commitIfChanged" | "push" | "headSha" | "commitCount"
>;

/** Minimal shape of {@link PRManager} consumed by the persist primitive. */
type PRManagerPersistLike = Pick<
  PRManager,
  "findOpenPR" | "createDraft" | "markInReview" | "markReadyToMerge" | "markFailed"
>;

/** Minimal shape of {@link VCSPlatform} consumed by the persist primitive. */
type VCSPersistLike = Pick<VCSPlatform, "createCodeReview" | "getCodeReviews">;

/** Injected dependencies for a `persist` call. */
interface PersistOutputDeps {
  readonly git: WorkspaceGitPersistLike;
  readonly prManager: PRManagerPersistLike;
  readonly vcs: VCSPersistLike;
  /**
   * Optional logger. When provided, persist emits a one-line INFO summary of
   * the commit + push + PR resolution so operators can audit every stage's
   * outward effects from the INFO stream alone (v5 observability mandate).
   * Silent success is a bug per `intelligence/rules/typescript.md`.
   */
  readonly log?: Logger;
  /**
   * Optional KVStore. When provided alongside {@link StagePersistInput.itemPath},
   * persist captures feature-branch-file observations before and after the
   * commit so the `kv:work-items/{id}.statusSources.featureBranchFile` slot
   * reflects what the agent actually wrote. Step 14 observability.
   */
  readonly kv?: KVStore;
  /** Absolute workspace path — required when observations are enabled. */
  readonly workspacePath?: string;
}

/**
 * Stage-produced artifacts the adapter commits and attaches to the PR. The
 * stage (via `runStage.buildPR`, or a legacy `entry.ts` case block)
 * constructs this object; the adapter does not synthesize commit messages
 * or PR bodies on its own.
 */
export interface StagePersistInput {
  readonly commitMessage: string;
  readonly pr: {
    readonly title: string;
    readonly body: string;
    /**
     * When `true`, a missing PR is created as draft via
     * `PRManager.createDraft` (which also attaches the `ai:pending` label).
     * When `false`, a missing PR is created as ready via
     * `VCSPlatform.createCodeReview` with `draft: false`. Ignored when
     * an open PR for the branch already exists.
     */
    readonly draft: boolean;
  };
  /**
   * Behavior on approved verdicts.
   *
   * - `"in-review"` — research/init/finding-plan/task-execute success
   *   paths. Flips the PR to `ai:in-review` and un-drafts it so the
   *   review cycle is open for feedback.
   * - `"ready-to-merge"` — pr-review verified the PR without further
   *   changes (Variant A: clean workspace after approved verdict). The
   *   PR is considered done as far as AI is concerned; human merge is
   *   the remaining step.
   * - `"none"` (default) — leaves the PR as-is (init success, improver
   *   success — both keep the default state
   * that `createDraft` / `createCodeReview` produced).
   *
   * Failed / cancelled / rejected verdicts always call
   * `PRManager.markFailed` regardless of this field.
   */
  readonly onSuccess?: "in-review" | "ready-to-merge" | "none";
  /**
   * Optional per-item metadata for the Step 14 feature-branch-file
   * observation. When both `deps.kv` and `itemId` + `itemPath` are set,
   * persist captures the status frontmatter before + after the commit and
   * writes it into `kv:work-items/{itemId}.statusSources.featureBranchFile`.
   */
  readonly itemId?: string;
  readonly itemPath?: string;
}

/** Result of a `persist` call. */
export interface PersistOutputResult {
  /** `true` iff a commit was actually produced (`commitIfChanged` returned a SHA). */
  readonly committed: boolean;
  /** Commit SHA when `committed` is `true`. `null` on the short-circuit path. */
  readonly sha: string | null;
  /** PR number when a commit happened and a PR existed or was created. */
  readonly prNumber: number | null;
  /** `true` when an open PR already existed and was reused (no new PR created). */
  readonly prExisted: boolean;
}

/** Contract for persisting stage output. */
interface OutputAdapter {
  persist(
    stageDef: StageDef,
    input: StageInput,
    agentResult: AgentResult,
    workspace: WorkspaceHandle,
    stagePersistInput: StagePersistInput,
    deps: PersistOutputDeps,
    ctx: OperationContext,
  ): Promise<PersistOutputResult>;
}

/** Single implementation of {@link OutputAdapter}. There is no second one. */
export class FileOutputAdapter implements OutputAdapter {
  async persist(
    stageDef: StageDef,
    _input: StageInput,
    agentResult: AgentResult,
    workspace: WorkspaceHandle,
    stagePersistInput: StagePersistInput,
    deps: PersistOutputDeps,
    ctx: OperationContext,
  ): Promise<PersistOutputResult> {
    if (ctx.signal.aborted) {
      throw new WorkspaceError(
        "WS_ABORTED",
        `persist aborted before start (branch: ${workspace.branch})`,
      );
    }

    // Pre-commit observation — captures the workspace state the agent left
    // before we stage+commit. Best-effort; observation failure does not
    // block persist.
    await observeFeatureBranchIfConfigured(
      deps, workspace, stagePersistInput, "pre-commit",
    );

    await deps.git.addAll();
    const sha = await deps.git.commitIfChanged(stagePersistInput.commitMessage);
    if (!sha) {
      // v5 logging audit §14 — "nothing to commit" is a decision. Log it so
      // the INFO stream reflects that we did try and the workspace was clean.
      //
      // A pre-existing PR on this branch (pr-review's `branchScope: "pr"`
      // flow, or an approved "no changes needed" review) still needs its
      // label transitioned — otherwise the PR sits on `ai:processing`
      // forever (2026-04-20 incident on PR #754). We resolve the open PR
      // and apply the normal verdict-driven transition; the push step is
      // skipped because there is nothing to push.
      const existingPR = await deps.prManager.findOpenPR(workspace.branch);
      if (existingPR) {
        const labelTransition = await applyLabelTransition(
          deps.prManager, existingPR.id, agentResult.verdict, stagePersistInput.onSuccess,
        );
        deps.log?.info(
          `persist ← no-op: no staged changes on ${workspace.branch} | PR #${existingPR.id} | label: ${labelTransition}`,
          {
            stage: stageDef.name, branch: workspace.branch, committed: false,
            prNumber: existingPR.id, verdict: agentResult.verdict, labelTransition,
          },
        );
        // No-op-with-PR path still mutates a label, and the PR's own state
        // may have moved since cycle start (e.g. user closed it during the
        // agent run). Refresh prState so the work-item KV row reflects
        // current reality, not the cycle-start snapshot.
        await refreshPrStateObservation(deps, workspace, stagePersistInput, ctx);
        return {
          committed: false,
          sha: null,
          prNumber: existingPR.id,
          prExisted: true,
        };
      }
      deps.log?.info(`persist ← no-op: no staged changes on ${workspace.branch}`, {
        stage: stageDef.name, branch: workspace.branch, committed: false,
      });
      // No PR was found, but the branch may still carry a recently-closed
      // PR that the work-item row should reflect. Refresh observation so
      // /work-items shows the latest closed/merged state.
      await refreshPrStateObservation(deps, workspace, stagePersistInput, ctx);
      return {
        committed: false,
        sha: null,
        prNumber: null,
        prExisted: false,
      };
    }
    deps.log?.debug(`persist: commit created`, {
      stage: stageDef.name, sha, branch: workspace.branch,
      message: stagePersistInput.commitMessage,
    });

    await deps.git.push(workspace.branch);
    deps.log?.debug(`persist: push succeeded`, { stage: stageDef.name, branch: workspace.branch });

    // Empty-diff guard: a stage may legitimately produce a commit that
    // doesn't differ from the base branch (e.g. a retrospective whose
    // `.failed` marker matches a previous week's content, or a
    // research run that found zero new findings on a re-checked-out
    // branch). GitHub refuses `pulls.create` with `422 No commits
    // between develop and <branch>` in that case. Detect it locally
    // and skip PR creation — the existing branch will be reaped by
    // branch-cleanup once it ages without an associated PR.
    const commitCount = await deps.git.commitCount(workspace.baseBranch).catch(() => -1);
    if (commitCount === 0) {
      deps.log?.warn(
        `persist ← empty-diff: 0 commits between ${workspace.baseBranch} and ${workspace.branch} — skipping PR creation`,
        {
          stage: stageDef.name, branch: workspace.branch,
          baseBranch: workspace.baseBranch, sha,
          verdict: agentResult.verdict,
        },
      );
      return {
        committed: true,
        sha,
        prNumber: null,
        prExisted: false,
      };
    }

    const existingPR = await deps.prManager.findOpenPR(workspace.branch);
    let pr: CodeReview;
    let prAction: "created-draft" | "created-ready" | "reused";
    if (existingPR) {
      pr = existingPR;
      prAction = "reused";
    } else {
      try {
        if (stagePersistInput.pr.draft) {
          pr = await deps.prManager.createDraft({
            title: stagePersistInput.pr.title,
            body: stagePersistInput.pr.body,
            branch: workspace.branch,
            baseBranch: workspace.baseBranch,
          });
          prAction = "created-draft";
        } else {
          pr = await deps.vcs.createCodeReview({
            title: stagePersistInput.pr.title,
            body: stagePersistInput.pr.body,
            baseBranch: workspace.baseBranch,
            headBranch: workspace.branch,
            draft: false,
          });
          prAction = "created-ready";
        }
      } catch (err) {
        // GitHub second-line empty-diff guard: the local
        // `commitCount` check above can disagree with what GitHub sees
        // (stale `origin/<base>` ref, base branch advanced mid-cycle to
        // include identical commits, etc.). When `pulls.create` returns
        // 422 with `"No commits between <base> and <head>"`, treat it
        // exactly like the local guard above — log a WARN and return
        // committed=true with no PR. The branch is reaped by
        // branch-cleanup once it ages without an associated PR.
        if (isNoCommitsBetweenError(err)) {
          deps.log?.warn(
            `persist ← empty-diff (post-push): GitHub reports 0 commits between ${workspace.baseBranch} and ${workspace.branch} — skipping PR creation`,
            {
              stage: stageDef.name, branch: workspace.branch,
              baseBranch: workspace.baseBranch, sha,
              verdict: agentResult.verdict,
              error: err instanceof Error ? err.message : String(err),
            },
          );
          return {
            committed: true,
            sha,
            prNumber: null,
            prExisted: false,
          };
        }
        throw err;
      }
    }

    const labelTransition = await applyLabelTransition(
      deps.prManager, pr.id, agentResult.verdict, stagePersistInput.onSuccess,
    );

    // v5 logging audit §14 — mandatory one-line summary of all externally
    // visible actions this persist call performed. Reading this single line
    // must be enough to reconstruct the change WITHOUT consulting `gh` or
    // the git log (the v4 observability gap that motivated this discipline).
    deps.log?.info(
      `persist ✓ ${stageDef.name} | commit ${sha.slice(0, 8)} "${stagePersistInput.commitMessage.split("\n")[0]}" | PR #${pr.id} ${prAction} | label: ${labelTransition}`,
      {
        stage: stageDef.name,
        verdict: agentResult.verdict,
        branch: workspace.branch,
        sha,
        prNumber: pr.id,
        prAction,
        labelTransition,
      },
    );

    // Post-commit observation — captures what actually landed on the feature
    // branch so drift detection can compare it against develop later.
    await observeFeatureBranchIfConfigured(
      deps, workspace, stagePersistInput, "post-commit",
    );

    // Refresh the work-item's `prState` observation immediately after the
    // PR is created or found. Without this the work-item KV row still
    // reflects the pre-cycle state — typically "merged" pointing at the
    // previous PR on this branch, or "none" — and the App UI would show
    // a stale closed/merged badge until the next syncFromFiles cycle.
    // Observing here closes that gap so /executions and /work-items
    // reflect the just-created PR within the same cycle.
    await refreshPrStateObservation(
      deps, workspace, stagePersistInput, ctx,
    );

    return {
      committed: true,
      sha,
      prNumber: pr.id,
      prExisted: existingPR !== null,
    };
  }
}

/**
 * Internal helper: observe the freshest PR state for the work item's branch
 * and merge it into the existing `kv:work-items/{id}.statusSources.prState`
 * row. Silent no-op when the KV / itemId / vcs deps are absent (the
 * persist primitive supports both the workspace-only and the KV-aware
 * call sites).
 */
async function refreshPrStateObservation(
  deps: PersistOutputDeps,
  workspace: WorkspaceHandle,
  stagePersistInput: StagePersistInput,
  ctx: OperationContext,
): Promise<void> {
  const { kv, vcs, prManager } = deps;
  const { itemId } = stagePersistInput;
  if (!kv || !itemId) return;
  try {
    const prState = await observePRState(workspace.branch, { prManager, vcs, kv, ctx });
    const prior = await kv.get("work-items", itemId);
    if (!prior) return;
    const priorValue = prior.value as Record<string, unknown>;
    const priorSources = (priorValue["statusSources"] ?? {}) as Record<string, unknown>;
    await kv.put(
      "work-items",
      itemId,
      stampWorkItem(priorValue, {
        ...priorValue,
        statusSources: { ...priorSources, prState },
      }),
    );
    deps.log?.debug(`persist: post-commit prState refreshed`, {
      itemId, prState: prState.value, prNumber: prState.prNumber,
    });
  } catch (err) {
    deps.log?.warn(`persist: post-commit prState refresh failed (non-fatal)`, {
      itemId, error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Detect GitHub's `pulls.create` 422 response that fires when the head
 * branch and the base have identical histories. The Octokit error stringifies
 * to `Validation Failed: ... "message":"No commits between <base> and <head>"`;
 * we match the stable message fragment so future Octokit error class names
 * don't break the guard.
 */
function isNoCommitsBetweenError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return message.includes("No commits between");
}

/**
 * Apply the verdict-driven label transition and return its name for logging.
 *
 * Two-bucket rule:
 *   - `verdict === "failed"` → `markFailed` — actual orchestration error
 *     (agent crashed, contract violation, applier rejected the records, CI
 *     contradicts approved). The PR carries `ai:failed` so the operator
 *     knows manual intervention is required.
 *   - `verdict === "cancelled"` → `markFailed` — user explicitly aborted
 *     the work via PR comment. Terminal-without-success.
 *   - `verdict === "approved"` OR `verdict === "rejected"` → use the
 *     stage's `onSuccess` lane (`in-review` or `ready-to-merge`). Both
 *     verdicts represent a successful agent outcome: approved produced
 *     work, rejected correctly filtered a false-positive item. The PR
 *     becomes a normal data-sync PR awaiting human review — for rejected
 *     items the PR body explains the rejection (composer responsibility);
 *     the human merges to propagate the status update to develop or
 *     closes to override the rejection.
 *
 * Pre-2026-05-13 rule was `verdict !== "approved"` → `markFailed` which
 * conflated rejected (successful filtering of bad work) with failed
 * (real error). That mapping caused rejection PRs to wear `ai:failed`
 * which confused operators reviewing executions (failed PR for a stage
 * that didn't fail).
 */
async function applyLabelTransition(
  prManager: Pick<PRManager, "markFailed" | "markInReview" | "markReadyToMerge">,
  prNumber: number,
  verdict: Verdict,
  onSuccess: "in-review" | "ready-to-merge" | "none" | undefined,
): Promise<"markFailed" | "markInReview" | "markReadyToMerge" | "none"> {
  if (verdict === "failed" || verdict === "cancelled") {
    await prManager.markFailed(prNumber);
    return "markFailed";
  }
  // approved + rejected both go through the success lane.
  if (onSuccess === "in-review") {
    await prManager.markInReview(prNumber);
    return "markInReview";
  }
  if (onSuccess === "ready-to-merge") {
    await prManager.markReadyToMerge(prNumber);
    return "markReadyToMerge";
  }
  return "none";
}

/**
 * Internal helper: run {@link observeFeatureBranchFile} when the caller
 * supplies the necessary deps, merge the result into the prior KV row, and
 * write it back. Silent no-op when deps.kv / stagePersistInput.itemId /
 * stagePersistInput.itemPath are absent.
 */
async function observeFeatureBranchIfConfigured(
  deps: PersistOutputDeps,
  workspace: WorkspaceHandle,
  stagePersistInput: StagePersistInput,
  phase: "pre-commit" | "post-commit",
): Promise<void> {
  const { kv, workspacePath } = deps;
  const { itemId, itemPath } = stagePersistInput;
  if (!kv || !workspacePath || !itemId || !itemPath) return;
  try {
    const obs = await observeFeatureBranchFile(
      { id: itemId, kind: "" },
      itemPath,
      workspace.branch,
      { git: deps.git, workspacePath },
    );
    const prior = await kv.get("work-items", itemId);
    const priorValue = (prior?.value ?? {}) as Record<string, unknown>;
    const priorSources = (priorValue.statusSources ?? {}) as Record<string, unknown>;
    await kv.put(
      "work-items",
      itemId,
      stampWorkItem(priorValue, {
        ...priorValue,
        statusSources: { ...priorSources, featureBranchFile: obs },
      }),
    );
    deps.log?.debug(`persist: ${phase} observation captured`, {
      stage: workspace.branch, phase, itemId, value: obs.value,
    });
  } catch (err) {
    deps.log?.warn(`persist: ${phase} observation failed (non-fatal)`, {
      itemId, error: err instanceof Error ? err.message : String(err),
    });
  }
}
