import type { OperationContext } from "./context.js";
import type { WorkItem } from "./domain.js";
import type { StateManager } from "./state.js";

export type AgentRoleName =
  | "scout"
  | "analyst"
  | "planner"
  | "creator"
  | "verifier"
  | "improver"
  | "diagnoser"
  | "supervisor";

export interface AgentContext {
  readonly role: AgentRoleName;
  readonly operation: OperationContext;
  readonly workspacePath: string;
  readonly workItem?: WorkItem;
  readonly attempt: number;
  readonly previousErrors: string[];
  readonly state: StateManager;
}

export interface AgentOutput {
  readonly raw: string;
  readonly summary?: string;
  readonly metadata?: Record<string, string | number | boolean>;
}

export interface AgentProvider {
  readonly id: string;
  execute(
    prompt: string,
    options: {
      model: string;
      timeoutMs: number;
      tools?: string[];
      maxBudgetUsd?: number;
      systemPromptFile?: string;
      cwd: string;
      env?: Record<string, string>;
    }
  ): Promise<{
    stdout: string;
    exitCode: number;
    durationMs: number;
  }>;
}
