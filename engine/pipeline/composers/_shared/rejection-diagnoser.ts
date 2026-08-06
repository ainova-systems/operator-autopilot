import type { OperationContext, PromptSource } from "@operator/core";
import { errorMessage } from "@operator/core";
import type { AgentRuntime, AgentRunInput } from "../../../agents/runtime.js";
import type { AgentsFile } from "../../../config/schemas.js";
import { resolveRole, instructionsPathToTopic } from "../../../agents/roles.js";
import { stripPreamble, stripCodeFences } from "../../../agents/output-parser.js";
import type { Logger } from "../../../logging/logger.js";
import type { StateContextVars, WorkItemFileData } from "../../../work-items/work-items.js";

export interface RejectionDiagnoserDeps {
  readonly agentRuntime: AgentRuntime;
  readonly agentsConfig: AgentsFile;
  readonly promptSource: PromptSource;
  readonly automationDir: string;
  readonly workspacePath: string;
  readonly stateVars?: StateContextVars;
  readonly log?: Logger;
}

export async function runRejectionDiagnoser(
  deps: RejectionDiagnoserDeps,
  ctx: OperationContext,
  item: WorkItemFileData,
  feedback: string,
): Promise<string> {
  try {
    const diagRole = resolveRole(deps.agentsConfig, "diagnoser");
    const runInput: AgentRunInput = {
      agentName: "diagnoser",
      providerId: diagRole.provider,
      promptContext: {
        promptSource: deps.promptSource,
        automationDir: deps.automationDir,
        contextFiles: diagRole.context,
        instructionsTopic: instructionsPathToTopic(diagRole.instructions),
        vars: { TASK_ID: item.id, FEEDBACK: feedback, ...deps.stateVars },
      },
      taskContent: `Analyze rejection for ${item.id}: ${item.title}\n\n${feedback}`,
      model: diagRole.model,
      timeoutMs: diagRole.timeout * 1000,
      tools: diagRole.tools.length > 0 ? diagRole.tools : undefined,
      maxBudgetUsd: diagRole.maxBudget,
      maxRetries: 1,
      reviewEnabled: false,
      cwd: deps.workspacePath,
    };
    const result = await deps.agentRuntime.run(runInput, ctx);
    const cleaned = stripPreamble(stripCodeFences(result.output.trim()));
    const match = cleaned.match(/^recommendation:\s*(.+)$/m);
    const value = match ? match[1].trim() : "poor-implementation";
    deps.log?.info(`rejection: diagnoser for ${item.id} → ${value}`, {
      scope: "rejection", itemId: item.id, recommendation: value,
    });
    return value;
  } catch (err) {
    deps.log?.error(`rejection: diagnoser agent failed for ${item.id}`, {
      scope: "rejection", itemId: item.id, error: errorMessage(err),
      cause: err instanceof Error && err.cause ? String(err.cause) : undefined,
    });
    return "poor-implementation";
  }
}
