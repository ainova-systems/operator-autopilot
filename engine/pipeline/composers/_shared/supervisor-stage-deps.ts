import type {
  DefaultsConfig, PromptSource, KindRegistry, WorkItemSource, AgentEventStream, AgentRoleName,
} from "@operator/core";
import type { AgentsFile } from "../../../config/schemas.js";
import type { PRManager } from "../../../delivery/pr-manager.js";
import type { WorkspaceGit } from "../../../infra/git.js";
import type { Logger } from "../../../logging/logger.js";
import type { StateContextVars } from "../../../work-items/work-items.js";

/** Dependencies + stage-shape parameters for the PR-feedback supervisor composer. */
export interface PrFeedbackSupervisorHookDeps {
  readonly prManager: PRManager;
  readonly git: WorkspaceGit;
  readonly agentsConfig: AgentsFile;
  readonly promptSource: PromptSource;
  readonly defaults: DefaultsConfig;
  readonly automationDir: string;
  readonly workspacePath: string;
  readonly kindRegistry: KindRegistry;
  readonly workItemSource: WorkItemSource;
  readonly agentEventStream: AgentEventStream;
  readonly stateVars?: StateContextVars;
  readonly log?: Logger;
  readonly debug?: boolean;
  readonly debugRunUrl?: string;
  readonly agentRole: AgentRoleName;
  readonly verifierTopic: string;
}
