import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { OperationContext } from "@operator/core";
import { findCodeReviewForBranch } from "../../delivery/vcs-helpers.js";
import {
  readWorkItemFile, updateWorkItemFileStatus,
} from "../../work-items/work-items.js";
import type { StageDef, StageInput } from "../types.js";
import type { WorkspaceHandle } from "../primitives/workspace-scope.js";
import { findChildrenByParentId } from "../primitives/idempotency-scan.js";
import { captureHeadSnapshot } from "../primitives/head-snapshot-contract.js";
import { aopPlannerScratch } from "./_shared/aop-planner-scratch.js";
import type { AopPlannerHookDeps } from "./_shared/aop-planner-deps.js";

export type { AopPlannerHookDeps } from "./_shared/aop-planner-deps.js";
export { buildAopPlannerAfterAgent } from "./aop-planner-after-agent.js";
export { buildAopPlannerSynthesizeAgentResult } from "./aop-planner-synthesize.js";
export { buildAopPlannerBuildRunInput } from "./aop-planner-build-run-input.js";
export { buildAopPlannerBuildPR } from "./aop-planner-build-pr.js";

/**
 * Generic stage composer for the "AOP planner" pattern.
 *
 * Pattern shape (kind-agnostic, stage-name-agnostic):
 *
 *  1. `per-item` selector picks a pending parent work-item of the
 *     configured kind.
 *  2. `WorkspaceScope.prepare` creates / reuses the per-item branch.
 *  3. `beforeAgent`: recover from `failed` (reset to `in-progress` +
 *     clear failed_at), transition PR label, capture HEAD snapshot,
 *     run idempotency scan looking for already-created child items.
 *  4. `synthesizeAgentResult`: short-circuit the agent invocation
 *     when idempotency scan already found child items.
 *  5. `buildRunInput`: construct the configured planner-role agent's
 *     input.
 *  6. `runStage` invokes the read-only planner agent.
 *  7. `afterAgent`: verify HEAD unchanged (planner is read-only;
 *     contract violation = stage failure), apply AOP child-item +
 *     verdict records through `applyAgentEvents`, flip parent's
 *     status to `in-progress` when child items were created.
 *
 * The composer is consumed by any stage whose planner-role agent
 * scans a parent work-item file and emits AOP child-item records.
 * A `finding-plan` stage that decomposes findings into tasks is the
 * canonical example, but any future repo can compose this same
 * pattern by passing its own parent / child kinds, agent role,
 * verifier topic, branch prefix, and PR template through
 * {@link AopPlannerHookDeps}.
 */

export function buildAopPlannerBeforeAgent(deps: AopPlannerHookDeps) {
  return async (
    stage: StageDef,
    input: StageInput,
    _workspace: WorkspaceHandle,
    ctx: OperationContext,
  ): Promise<{ processingPRs?: readonly number[] } | void> => {
    const itemId = input.scopeKey;
    const filePath = join(deps.parentDataDir, `${itemId}.md`);
    const item = await readWorkItemFile(filePath);
    deps.log?.debug(`${stage.name}: loaded ${itemId}`, {
      stage: stage.name, itemId, status: item.status,
    });

    if (item.status === "failed") {
      deps.log?.info(`${stage.name}: resetting failed ${deps.parentKind} ${itemId} to in-progress for retry`, {
        stage: stage.name, itemId, previousStatus: "failed",
      });
      await updateWorkItemFileStatus(filePath, "in-progress");
      let content = await readFile(filePath, "utf-8");
      content = content.replace(/^failed_at:.*\n/m, "");
      await writeFile(filePath, content, "utf-8");
    }

    const branch = `${deps.branchPrefix}/${itemId}`;
    const codeReviewId = await findCodeReviewForBranch(deps.vcs, branch);

    if (codeReviewId) {
      await deps.prManager.markProcessing(codeReviewId);
      deps.log?.info(`${stage.name}: PR #${codeReviewId} label ai:pending → ai:processing`, {
        stage: stage.name, itemId, prNumber: codeReviewId,
      });
    }

    const headSnapshot = await captureHeadSnapshot(deps.git);

    const alreadyPlannedChildren = await findChildrenByParentId({
      dataDir: deps.childDataDir,
      parentId: itemId,
    });

    aopPlannerScratch.set(ctx, itemId, {
      itemId, filePath, item, codeReviewId, headSnapshot,
      alreadyPlannedChildren: alreadyPlannedChildren.length > 0 ? alreadyPlannedChildren : undefined,
    });

    if (alreadyPlannedChildren.length > 0) {
      deps.log?.info(
        `${stage.name}: ${itemId} already has ${alreadyPlannedChildren.length} child item(s) — will skip planner and refresh status only`,
        {
          stage: stage.name, itemId,
          childIds: alreadyPlannedChildren,
        },
      );
    }

    if (codeReviewId) {
      return { processingPRs: [codeReviewId] };
    }
  };
}
