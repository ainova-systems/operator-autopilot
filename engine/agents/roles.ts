import type { AgentRoleName } from "@operator/core";
import type { AgentsFile } from "../config/schemas.js";
import type { FormatType } from "./output-parser.js";
import type { AgentRunInput } from "./runtime.js";
import type { PromptContext } from "./prompt-builder.js";
import type { CLIProviderConfig } from "./providers/cli.js";

/**
 * Expected output format per role.
 * Used by pipeline stages to validate agent output via output-parser.
 */
export const ROLE_OUTPUT_FORMATS: Record<AgentRoleName, FormatType> = {
  analyst: "finding",
  planner: "task",
  creator: "comment",
  verifier: "comment",
  improver: "improver",
  diagnoser: "comment",
  scout: "comment",
  supervisor: "comment",
};

/**
 * Resolved role configuration — typed extract from agents.yaml.
 */
export interface ResolvedRole {
  readonly name: AgentRoleName;
  readonly provider: string;
  readonly description: string;
  readonly instructions: string;
  readonly timeout: number;
  readonly model: string;
  readonly review: boolean;
  readonly tools: string[];
  readonly maxBudget: number;
  readonly context: string[];
  readonly schedule?: string;
}

/**
 * Resolve a role's full configuration from agents.yaml.
 * Fills in defaults for optional fields.
 */
export function resolveRole(config: AgentsFile, roleName: AgentRoleName): ResolvedRole {
  const agent = config.agents[roleName];
  if (!agent) throw new Error(`Unknown agent role: ${roleName}`);

  const provider = agent.provider ?? config.defaultProvider;
  // Model precedence: the role's explicit `model`, else the provider's
  // `defaultModel` (e.g. `auto` for cursor — self-selects the best model),
  // else a hard-coded last-resort constant.
  const providerDefaultModel = config.providers[provider]?.defaultModel;

  return {
    name: roleName,
    provider,
    description: agent.description ?? roleName,
    instructions: agent.instructions,
    timeout: agent.timeout,
    model: agent.model ?? providerDefaultModel ?? "sonnet",
    review: agent.review ?? false,
    tools: agent.tools ? agent.tools.split(",").map((t) => t.trim()) : [],
    maxBudget: agent.maxBudget ?? 5.0,
    context: agent.context ?? [],
    schedule: agent.schedule,
  };
}

/**
 * Extract CLI provider config from agents.yaml providers section.
 */
export function resolveProviderConfig(config: AgentsFile, providerId: string): CLIProviderConfig {
  const provider = config.providers[providerId];
  if (!provider) throw new Error(`Unknown provider: ${providerId}`);

  return {
    command: provider.command,
    defaultArgs: provider.defaultArgs ?? [],
    promptArg: provider.promptArg ?? "-p",
    modelArg: provider.modelArg,
    toolsArg: provider.toolsArg,
    maxBudgetArg: provider.maxBudgetArg,
    systemPromptFileArg: provider.systemPromptFileArg,
    promptFromStdin: provider.promptFromStdin,
  };
}

/**
 * Convert a role's `instructions:` field from `agents.yaml` (e.g.
 * `"agents/creator.md"`) into a {@link PromptSource} topic key (e.g.
 * `"creator"`). Strips the leading `agents/` path segment and the
 * trailing `.md` extension so the topic is relative to the operator
 * repo's `agents/` root — matching the {@link KVPromptSource}
 * convention.
 *
 * Exported for reuse by pipeline stages that construct `PromptContext`
 * inline without going through {@link buildRunInput}.
 */
export function instructionsPathToTopic(instructions: string): string {
  return instructions.replace(/^agents\//, "").replace(/\.md$/, "");
}

/**
 * Build AgentRunInput from a resolved role and prompt context.
 * Used by pipeline stages to prepare agent execution.
 */
export function buildRunInput(
  role: ResolvedRole,
  promptContext: Omit<PromptContext, "contextFiles" | "instructionsTopic">,
  opts: {
    taskContent?: string;
    cwd: string;
    maxRetries?: number;
    verifyCommand?: string;
    verifierModel?: string;
    reviewCriteria?: string;
  },
): AgentRunInput {
  return {
    agentName: role.name,
    providerId: role.provider,
    promptContext: {
      ...promptContext,
      contextFiles: role.context,
      instructionsTopic: instructionsPathToTopic(role.instructions),
    },
    taskContent: opts.taskContent,
    model: role.model,
    timeoutMs: role.timeout * 1000,
    tools: role.tools.length > 0 ? role.tools : undefined,
    maxBudgetUsd: role.maxBudget,
    maxRetries: opts.maxRetries ?? 3,
    verifyCommand: opts.verifyCommand,
    reviewEnabled: role.review,
    verifierModel: opts.verifierModel,
    reviewCriteria: opts.reviewCriteria,
    cwd: opts.cwd,
  };
}
