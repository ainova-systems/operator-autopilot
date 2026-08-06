import { join } from "node:path";
import type { OperationContext } from "@operator/core";
import type { AgentRunInput } from "../../agents/runtime.js";
import { resolveRole, buildRunInput } from "../../agents/roles.js";
import { readWorkItemFile } from "../../work-items/work-items.js";
import type { StageDef, StageInput } from "../types.js";
import type { AopPlannerHookDeps } from "./_shared/aop-planner-deps.js";

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
