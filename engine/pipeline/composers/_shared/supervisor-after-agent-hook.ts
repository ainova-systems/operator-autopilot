import { unlink } from "node:fs/promises";
import type { OperationContext } from "@operator/core";
import { errorMessage } from "@operator/core";
import type { StageDef, StageInput, AgentResult, Verdict } from "../../types.js";
import type { WorkspaceHandle } from "../../primitives/workspace-scope.js";
import {
  prFeedbackSupervisorScratch,
  prFeedbackSupervisorScratchKey,
} from "./supervisor-scratch.js";
import { processSupervisorAfterAgent } from "./supervisor-after-agent.js";
import type { PrFeedbackSupervisorHookDeps } from "./supervisor-stage-deps.js";
import { payloadOf } from "./supervisor-payload.js";
import { StageLogicError } from "../errors.js";

export function buildPrFeedbackSupervisorAfterAgent(deps: PrFeedbackSupervisorHookDeps) {
  return async (
    stage: StageDef,
    input: StageInput,
    agentResult: AgentResult,
    _workspace: WorkspaceHandle,
    ctx: OperationContext,
  ): Promise<{ verdictOverride?: Verdict; summaryOverride?: string } | void> => {
    const payload = payloadOf(stage.name, input);
    const scratch = prFeedbackSupervisorScratch.get(ctx, prFeedbackSupervisorScratchKey(payload.prId));
    if (!scratch) {
      throw new StageLogicError(
        "STAGE_SCRATCH_MISSING",
        `${stage.name} afterAgent: missing scratch for PR #${payload.prId} — beforeAgent not run`,
      );
    }
    try {
      return await processSupervisorAfterAgent(deps, stage, payload, scratch, agentResult, ctx);
    } catch (err) {
      deps.log?.error(`${stage.name}: afterAgent failed for PR #${payload.prId}`, {
        stage: stage.name, prNumber: payload.prId, error: errorMessage(err),
      });
      throw err;
    } finally {
      if (scratch.threadFile) {
        await unlink(scratch.threadFile).catch(() => { /* best-effort cleanup */ });
      }
    }
  };
}
