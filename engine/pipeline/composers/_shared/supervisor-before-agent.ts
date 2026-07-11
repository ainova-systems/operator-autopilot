import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { OperationContext } from "@operator/core";
import type { WorkspaceGit } from "../../../infra/git.js";
import type { Logger } from "../../../logging/logger.js";
import type { StageDef, StageInput } from "../../types.js";
import type { WorkspaceHandle } from "../../primitives/workspace-scope.js";
import {
  prFeedbackSupervisorScratch,
  prFeedbackSupervisorScratchKey,
} from "./supervisor-scratch.js";
import type { PrFeedbackSupervisorHookDeps } from "./supervisor-stage-deps.js";
import { payloadOf } from "./supervisor-payload.js";

async function computeReviewAttempts(
  git: WorkspaceGit,
  baseBranch: string,
  prType: string,
  stageName: string,
  log: Logger | undefined,
): Promise<number> {
  try {
    const total = await git.commitCount(baseBranch);
    const initial = prType === "task" ? 2 : 1;
    return Math.max(0, total - initial);
  } catch (err) {
    log?.warn(`${stageName}: commitCount failed (defaulting attempts to 0)`, {
      stage: stageName, baseBranch, prType,
      error: err instanceof Error ? err.message : String(err),
    });
    return 0;
  }
}

export function buildPrFeedbackSupervisorBeforeAgent(deps: PrFeedbackSupervisorHookDeps) {
  return async (
    stage: StageDef,
    input: StageInput,
    workspace: WorkspaceHandle,
    ctx: OperationContext,
  ): Promise<{ processingPRs?: readonly number[] } | void> => {
    const payload = payloadOf(stage.name, input);
    const reviewAttempts = await computeReviewAttempts(
      deps.git, workspace.baseBranch, payload.prType, stage.name, deps.log,
    );
    const maxAttempts = deps.defaults.limits.maxReviewAttempts;
    const limitReached = reviewAttempts >= maxAttempts;

    deps.log?.info(`${stage.name}: PR #${payload.prId} (${payload.prType}) attempts ${reviewAttempts}/${maxAttempts}`, {
      stage: stage.name, prNumber: payload.prId, prType: payload.prType,
      reviewAttempts, maxAttempts, limitReached,
    });

    let threadFile = "";
    if (!limitReached) {
      await deps.prManager.markProcessing(payload.prId);
      deps.log?.info(`${stage.name}: PR #${payload.prId} label ai:pending → ai:processing`, {
        stage: stage.name, prNumber: payload.prId,
      });

      if (payload.fullThread) {
        threadFile = join(
          tmpdir(),
          `operator-pr-thread-${payload.prId}-${Date.now()}-${Math.random().toString(36).slice(2)}.md`,
        );
        await writeFile(threadFile, `# PR #${payload.prId} Discussion Thread\n\n${payload.fullThread}\n`, "utf-8");
      }
    }

    let preAgentHeadSha = "";
    try {
      preAgentHeadSha = (await deps.git.headSha()).trim();
    } catch (err) {
      deps.log?.warn(`${stage.name}: failed to capture pre-agent HEAD SHA (non-fatal)`, {
        stage: stage.name, prNumber: payload.prId,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    prFeedbackSupervisorScratch.set(ctx, prFeedbackSupervisorScratchKey(payload.prId), {
      prId: payload.prId, branch: payload.branch, prType: payload.prType,
      reviewAttempts, maxAttempts, limitReached, threadFile,
      newFeedback: payload.newFeedback,
      checksContextFile: "",
      preAgentHeadSha,
    });

    if (limitReached) return;
    return { processingPRs: [payload.prId] };
  };
}
