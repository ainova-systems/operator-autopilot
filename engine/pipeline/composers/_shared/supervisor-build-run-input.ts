import type { OperationContext } from "@operator/core";
import type { AgentRunInput } from "../../../agents/runtime.js";
import { resolveRole, buildRunInput } from "../../../agents/roles.js";
import type { StageDef, StageInput } from "../../types.js";
import { writeChecksContextFile } from "../../primitives/checks-context.js";
import { buildSupervisorTask } from "./supervisor-task.js";
import {
  prFeedbackSupervisorScratch,
  prFeedbackSupervisorScratchKey,
} from "./supervisor-scratch.js";
import type { PrFeedbackSupervisorHookDeps } from "./supervisor-stage-deps.js";
import { payloadOf } from "./supervisor-payload.js";
import { StageLogicError } from "../errors.js";

export function buildPrFeedbackSupervisorBuildRunInput(deps: PrFeedbackSupervisorHookDeps) {
  return async (
    stage: StageDef,
    input: StageInput,
    ctx: OperationContext,
  ): Promise<AgentRunInput> => {
    const payload = payloadOf(stage.name, input);
    const scratch = prFeedbackSupervisorScratch.get(ctx, prFeedbackSupervisorScratchKey(payload.prId));
    if (!scratch) {
      throw new StageLogicError(
        "STAGE_SCRATCH_MISSING",
        `${stage.name} buildRunInput: missing scratch for PR #${payload.prId} — beforeAgent not run`,
      );
    }
    const role = resolveRole(deps.agentsConfig, deps.agentRole);
    const reviewCriteria = role.review
      ? await deps.promptSource.loadChain(`verifier/${deps.verifierTopic}`)
      : undefined;

    if (payload.checks.value === "failing" || payload.checks.value === "pending") {
      try {
        scratch.checksContextFile = await writeChecksContextFile({
          observation: payload.checks,
          prNumber: payload.prId,
          branch: payload.branch,
        });
      } catch (err) {
        deps.log?.warn(`${stage.name}: writeChecksContextFile failed (non-fatal)`, {
          stage: stage.name, prNumber: payload.prId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    const taskContent = buildSupervisorTask(
      payload.prType, payload.branch, scratch.newFeedback,
      scratch.threadFile, scratch.checksContextFile || undefined,
    );
    return buildRunInput(
      role,
      {
        promptSource: deps.promptSource,
        automationDir: deps.automationDir,
        vars: { PR_NUMBER: String(payload.prId), PR_TYPE: payload.prType, ...deps.stateVars },
      },
      {
        taskContent,
        cwd: deps.workspacePath,
        maxRetries: 1,
        reviewCriteria,
      },
    );
  };
}
