import type {
  StateManager, VCSPlatform, KindRegistry,
  WorkItemSource, AgentEventStream, AgentRoleName, WorkItemKind,
} from "@operator/core";
import type { AgentsFile } from "../../../config/schemas.js";
import type { PromptSource } from "@operator/core";
import type { PRManager } from "../../../delivery/pr-manager.js";
import type { WorkspaceGit } from "../../../infra/git.js";
import type { Logger } from "../../../logging/logger.js";
import type { StateContextVars } from "../../../work-items/work-items.js";

export interface AopPlannerHookDeps {
  readonly state: StateManager;
  readonly vcs: VCSPlatform;
  readonly prManager: PRManager;
  readonly git: WorkspaceGit;
  readonly kindRegistry: KindRegistry;
  /** Storage directory for parent work-items (e.g. the findings dir). */
  readonly parentDataDir: string;
  /** Storage directory for child work-items (e.g. the tasks dir). */
  readonly childDataDir: string;
  readonly automationDir: string;
  readonly workspacePath: string;
  readonly templatesDir: string;
  readonly agentsConfig: AgentsFile;
  readonly promptSource: PromptSource;
  readonly workItemSource: WorkItemSource;
  readonly agentEventStream: AgentEventStream;
  readonly stateVars?: StateContextVars;
  readonly log?: Logger;
  readonly debug?: boolean;
  readonly debugRunUrl?: string;
  readonly kv?: import("@operator/core").KVStore;

  // ── Stage-shape parameters ────────────────────────────────────────
  /** Parent work-item kind (e.g. `"finding"`). */
  readonly parentKind: WorkItemKind;
  /** Planner agent role (e.g. `"planner"`). */
  readonly agentRole: AgentRoleName;
  /** Verifier chain topic suffix, used as `verifier/{verifierTopic}`. */
  readonly verifierTopic: string;
  /** Branch prefix for the parent's PRs (e.g. `"ai/findings"`). */
  readonly branchPrefix: string;
  /** PR title prefix (e.g. `"[AI:Finding]"`). */
  readonly prPrefix: string;
  /** In-progress PR body template filename. */
  readonly prTemplate: string;
  /** Human-facing display name (e.g. `"Finding"`). */
  readonly displayName: string;
  /** ID prefix for parent items (e.g. `"F"`) — used for parsing date / seq. */
  readonly idPrefix: string;
  /** Prompt variable name for the parent id (e.g. `"FINDING_ID"`). */
  readonly idVarName: string;
  /** Prompt variable name for the seq (e.g. `"FINDING_SEQ"`). */
  readonly seqVarName: string;
}
