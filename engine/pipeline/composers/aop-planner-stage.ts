import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { OperationContext } from "@operator/core";
import type { AgentRunInput } from "../../agents/runtime.js";
import { resolveRole, buildRunInput } from "../../agents/roles.js";
import { findCodeReviewForBranch } from "../../delivery/vcs-helpers.js";
import {
  readWorkItemFile, updateWorkItemFileStatus,
} from "../../work-items/work-items.js";
import type { StageDef, StageInput, AgentResult } from "../types.js";
import type { WorkspaceHandle } from "../primitives/workspace-scope.js";
import { findChildrenByParentId } from "../primitives/idempotency-scan.js";
import { captureHeadSnapshot } from "../primitives/head-snapshot-contract.js";
import { aopPlannerScratch } from "./_shared/aop-planner-scratch.js";
import type { AopPlannerHookDeps } from "./_shared/aop-planner-deps.js";
import {
  buildCatchUpPlannerPr,
  buildPlanPlannerPr,
  buildRejectionPlannerPr,
} from "./_shared/planner-pr-body.js";

export type { AopPlannerHookDeps } from "./_shared/aop-planner-deps.js";
export { buildAopPlannerAfterAgent } from "./aop-planner-after-agent.js";

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

export function buildAopPlannerBuildRunInput(deps: AopPlannerHookDeps) {
  return async (
    _stage: StageDef,
    input: StageInput,
    _ctx: OperationContext,
  ): Promise<AgentRunInput> => {
    const itemId = input.scopeKey;
    const filePath = join(deps.parentDataDir, `${itemId}.md`);
    const item = await readWorkItemFile(filePath);
    const role = resolveRole(deps.agentsConfig, deps.agentRole);
    const reviewCriteria = role.review
      ? await deps.promptSource.loadChain(`verifier/${deps.verifierTopic}`)
      : undefined;

    // itemId conforms to {idPrefix}{date}-{seq} — slice 1..9 = date,
    // split on `-`[1] = seq. The idPrefix length is fixed at 1 by the
    // current id-pattern convention.
    const datePart = itemId.slice(deps.idPrefix.length, deps.idPrefix.length + 8);
    const itemSeq = itemId.split("-")[1] ?? "0001";
    const timestamp = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

    const { buildExecutionHistoryBlock } = await import("../primitives/execution-context.js");
    const historyBlock = await buildExecutionHistoryBlock(deps.kv, itemId);
    const taskContent = historyBlock
      ? `${historyBlock}\n${item.body}`
      : item.body;

    // Pass through the parent finding's path (either explicit
    // frontmatter `path:` or the body-derived heuristic via
    // `derivePathFromBody` — picks up the `**Domain**` field findings
    // emit). Without this, the prompt-builder's layers 3 + 5 cannot
    // filter `.operator/context/{backend,frontend}.md` and every
    // finding-plan execution carries both contexts (~6k extra chars
    // per call). Symmetrical to the wiring in
    // `verifier-driven-creator-stage.beforeAgent`.
    const itemPath = item.path ?? undefined;

    return buildRunInput(
      role,
      {
        promptSource: deps.promptSource,
        automationDir: deps.automationDir,
        vars: {
          [deps.idVarName]: itemId,
          DATE: datePart,
          [deps.seqVarName]: itemSeq,
          TIMESTAMP: timestamp,
          ...deps.stateVars,
        },
        rulesFrom: itemPath ? deps.agentRole : undefined,
        contextPath: itemPath,
      },
      {
        taskContent,
        cwd: deps.workspacePath,
        maxRetries: 2,
        reviewCriteria,
      },
    );
  };
}

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
