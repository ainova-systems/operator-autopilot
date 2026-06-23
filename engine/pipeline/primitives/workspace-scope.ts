import type { OperationContext } from "@operator/core";
import { WorkspaceError } from "@operator/core";
import type { WorkspaceGit } from "../../infra/git.js";
import type { Logger } from "../../logging/logger.js";

/**
 * WorkspaceScope — the ONLY place in the engine that decides
 * "create a new branch vs checkout an existing one." Every stage that needs
 * to work on an AI branch goes through this primitive.
 *
 * Rationale: before Step 7 each stage made that decision inline. The
 * 2026-04-13 incident (`improver` pushed a fresh local `ai/improver/2026W16`
 * that diverged from the remote branch of the same name) was caused by one
 * of those inline decisions taking the `checkoutNewBranch` path when the
 * branch already existed on the remote. Consolidating the rule into a single
 * primitive makes that class of bug impossible.
 *
 * The rule:
 *
 *   if remote branch exists → `checkoutExisting` (fetch + fast-forward local)
 *   else                    → `checkoutNewBranch` from `baseBranch`
 *
 * No force-push path exists. No second code path exists. Callers that need
 * an existing-branch-only behavior pass an already-known branch and the
 * primitive still respects the rule (remote exists → checkoutExisting).
 */

/** Minimal shape of {@link WorkspaceGit} consumed by the scope primitive. */
type WorkspaceGitScopeLike = Pick<
  WorkspaceGit,
  "remoteBranchExists" | "checkoutNewBranch" | "checkoutExisting"
>;

/** Input for {@link WorkspaceScope.prepare}. */
interface WorkspaceScopePrepareInput {
  /** Fully-qualified branch name, e.g. `ai/improver/2026W16`. */
  readonly branch: string;
  /** Base branch the new branch would be created from when the remote is empty. */
  readonly baseBranch: string;
}

/** Result of a successful {@link WorkspaceScope.prepare} call. */
export interface WorkspaceHandle {
  /** Branch that is now checked out. Identical to the input branch. */
  readonly branch: string;
  /** Base branch used for the create path (pass-through). */
  readonly baseBranch: string;
  /**
   * `true` when the branch was already on the remote and the workspace
   * was advanced via `checkoutExisting`. `false` when the branch was
   * created from `baseBranch` via `checkoutNewBranch`.
   */
  readonly existedRemote: boolean;
}

/**
 * Contract for preparing a workspace on a target branch.
 *
 * This is the `initWorkspace` step (step 3) of the v5 8-step run-stage loop
 * (see `docs/architecture-v5.md §3`). In Step 7 it is called directly from
 * `engine/entry.ts` case blocks for `research`, `improver`, `init`. In
 * Step 8 it will be invoked from `runStage` for every stage.
 */
interface WorkspaceScope {
  prepare(
    input: WorkspaceScopePrepareInput,
    git: WorkspaceGitScopeLike,
    ctx: OperationContext,
    log?: Logger,
  ): Promise<WorkspaceHandle>;
}

/** Single implementation of {@link WorkspaceScope}. There is no second one. */
export class FileWorkspaceScope implements WorkspaceScope {
  async prepare(
    input: WorkspaceScopePrepareInput,
    git: WorkspaceGitScopeLike,
    ctx: OperationContext,
    log?: Logger,
  ): Promise<WorkspaceHandle> {
    if (ctx.signal.aborted) {
      throw new WorkspaceError(
        "WS_ABORTED",
        `workspace prepare aborted before start (branch: ${input.branch})`,
      );
    }
    if (!input.branch) {
      throw new WorkspaceError("WS_INVALID_BRANCH", "branch name is required");
    }
    if (!input.baseBranch) {
      throw new WorkspaceError(
        "WS_INVALID_BASE",
        `base branch is required (branch: ${input.branch})`,
      );
    }

    const existedRemote = await git.remoteBranchExists(input.branch);
    if (existedRemote) {
      // v5 logging audit §14 — branch-decision INFO. This is THE line that
      // would have told us during the 2026-04-13 incident whether the
      // checkout path matched the remote state; unmissable at INFO level.
      log?.info(`workspace-scope: checkoutExisting ${input.branch} (remote branch present)`, {
        branch: input.branch, baseBranch: input.baseBranch, decision: "checkoutExisting",
      });
      await git.checkoutExisting(input.branch);
    } else {
      log?.info(`workspace-scope: checkoutNewBranch ${input.branch} from ${input.baseBranch} (remote branch absent)`, {
        branch: input.branch, baseBranch: input.baseBranch, decision: "checkoutNewBranch",
      });
      await git.checkoutNewBranch(input.branch, input.baseBranch);
    }

    return {
      branch: input.branch,
      baseBranch: input.baseBranch,
      existedRemote,
    };
  }
}
