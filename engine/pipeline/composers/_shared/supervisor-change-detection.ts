import type { WorkspaceGit } from "../../../infra/git.js";
import type { Logger } from "../../../logging/logger.js";
import type { StageDef } from "../../types.js";
import type { PrFeedbackPayload } from "../../primitives/pr-feedback-selector.js";
import type { PrFeedbackSupervisorScratch } from "./supervisor-scratch.js";

export interface SupervisorChanges {
  readonly workspaceDirty: boolean;
  readonly headAdvanced: boolean;
  readonly changesApplied: boolean;
  readonly postAgentHeadSha: string;
}

export async function detectSupervisorChanges(
  git: WorkspaceGit,
  scratch: PrFeedbackSupervisorScratch,
  stage: StageDef,
  payload: PrFeedbackPayload,
  log?: Logger,
): Promise<SupervisorChanges> {
  const workspaceDirty = !(await git.isClean());
  let postAgentHeadSha = "";
  try {
    postAgentHeadSha = (await git.headSha()).trim();
  } catch (err) {
    log?.warn(`${stage.name}: failed to capture post-agent HEAD SHA (falling back to dirty-only check)`, {
      stage: stage.name, prNumber: payload.prId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  const headAdvanced = scratch.preAgentHeadSha.length > 0
    && postAgentHeadSha.length > 0
    && scratch.preAgentHeadSha !== postAgentHeadSha;
  return {
    workspaceDirty,
    headAdvanced,
    changesApplied: workspaceDirty || headAdvanced,
    postAgentHeadSha,
  };
}
