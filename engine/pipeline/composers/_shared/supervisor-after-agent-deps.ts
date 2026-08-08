import type { KindRegistry, WorkItemSource, AgentEventStream } from "@operator/core";
import type { PRManager } from "../../../delivery/pr-manager.js";
import type { WorkspaceGit } from "../../../infra/git.js";
import type { Logger } from "../../../logging/logger.js";

export interface SupervisorAfterAgentDeps {
  readonly prManager: PRManager;
  readonly git: WorkspaceGit;
  readonly kindRegistry: KindRegistry;
  readonly workItemSource: WorkItemSource;
  readonly agentEventStream: AgentEventStream;
  readonly log?: Logger;
  readonly debug?: boolean;
  readonly debugRunUrl?: string;
}
