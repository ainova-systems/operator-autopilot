import type { OperationContext } from "@operator/core";
import type { StageDef, StageInput, AgentResult } from "../types.js";
import type { WorkspaceHandle } from "../primitives/workspace-scope.js";
import { aopPlannerScratch } from "./_shared/aop-planner-scratch.js";
import type { AopPlannerHookDeps } from "./_shared/aop-planner-deps.js";

export function buildAopPlannerSynthesizeAgentResult(_deps: AopPlannerHookDeps) {
  return async (
    _stage: StageDef,
    input: StageInput,
    _workspace: WorkspaceHandle,
    ctx: OperationContext,
  ): Promise<AgentResult | null> => {
    const itemId = input.scopeKey;
    const scratch = aopPlannerScratch.get(ctx, itemId);
    if (!scratch || !scratch.alreadyPlannedChildren) return null;
    const count = scratch.alreadyPlannedChildren.length;
    return {
      verdict: "approved",
      output: `=== EMIT verdict ===\nvalue: approved\nsummary: Item ${itemId} already has ${count} child item(s); planner skipped.\n=== END EMIT ===`,
      attempts: 0,
      summary: `[idempotency] Item ${itemId} already planned (${count} child item(s) exist); skipped planner re-run.`,
    };
  };
}
