import { join } from "node:path";
import type { OperationContext } from "@operator/core";
import { readWorkItemFile } from "../../work-items/work-items.js";
import type { StageDef, StageInput } from "../types.js";
import { aopPlannerScratch } from "./_shared/aop-planner-scratch.js";
import type { AopPlannerHookDeps } from "./_shared/aop-planner-deps.js";
import {
  buildCatchUpPlannerPr,
  buildPlanPlannerPr,
  buildRejectionPlannerPr,
} from "./_shared/planner-pr-body.js";

export function buildAopPlannerBuildPR(deps: AopPlannerHookDeps) {
  return async (
    _stage: StageDef,
    input: StageInput,
    ctx: OperationContext,
  ): Promise<{ title: string; body: string; commitMessage: string; onSuccess?: "in-review" | "ready-to-merge" | "none" }> => {
    const itemId = input.scopeKey;
    const filePath = join(deps.parentDataDir, `${itemId}.md`);
    const item = await readWorkItemFile(filePath);

    // afterAgent stashes rejection context in scratch when the agent
    // determined the item is invalid. Render a rejection-specific PR so
    // the human reviewer sees WHAT was rejected and WHY directly in the
    // PR description — without needing to open the execution log.
    const scratch = aopPlannerScratch.get(ctx, itemId);
    const shape = {
      prPrefix: deps.prPrefix,
      displayName: deps.displayName,
      idVarName: deps.idVarName,
    };
    try {
      if (scratch?.rejection) {
        const { title, body, commitMessage } = buildRejectionPlannerPr(
          item, itemId, scratch.rejection, shape,
        );
        return { title, body, commitMessage, onSuccess: "in-review" };
      }

      // Catch-up path: idempotency scan found pre-existing child items on
      // the base branch, planner was skipped (see synthesizeAgentResult).
      // Diff carries only the parent's frontmatter flip — no new child
      // files. Render a self-describing body so the human reviewer does
      // NOT have to guess "is this a plan or a status-only bump?".
      if (scratch?.alreadyPlannedChildren && scratch.alreadyPlannedChildren.length > 0) {
        const { title, body, commitMessage } = buildCatchUpPlannerPr(
          item, itemId, scratch.alreadyPlannedChildren, shape,
        );
        return { title, body, commitMessage, onSuccess: "in-review" };
      }

      // Plan path: planner ran and emitted new child items. The standard
      // in-progress template covers this case — assumption + metadata.
      const { title, body, commitMessage } = await buildPlanPlannerPr(item, itemId, {
        ...shape,
        templatesDir: deps.templatesDir,
        prTemplate: deps.prTemplate,
        loadTemplate: (templatesDir, template, vars) => deps.prManager.loadTemplate(templatesDir, template, vars),
      });
      return { title, body, commitMessage, onSuccess: "in-review" };
    } finally {
      // buildPR is the last hook that reads scratch — clear here to bound
      // store lifetime to a single cycle. Moved from afterAgent.finally
      // 2026-05-13 when Fix 8 made buildPR depend on scratch.rejection
      // (set by afterAgent on the rejected path).
      aopPlannerScratch.clear(ctx, itemId);
    }
  };
}
