import { join } from "node:path";
import type {
  AgentRoleName,
  ConventionsConfig, EventBus, IdempotencyGuard, KindRegistry, KVStore,
  OperationContext, OperatorConfig, ProjectConfig, StateManager, VCSPlatform,
  WorkflowStageEntry,
} from "@operator/core";
import type { AgentsFile } from "../config/schemas.js";
import type { PRManager } from "../delivery/pr-manager.js";
import type { WorkspaceGit } from "../infra/git.js";
import type { Logger } from "../logging/logger.js";
import type { AgentRuntime } from "../agents/runtime.js";
import type { PromptSource } from "@operator/core";
import { resolveRole, buildRunInput } from "../agents/roles.js";
import {
  runStage, FileAgentInvocation, FileVerdictRouter, createDefaultSelectorRegistry,
} from "../pipeline/run-stage.js";
import type { StageDef } from "../pipeline/types.js";
import { FileWorkspaceScope } from "../pipeline/primitives/workspace-scope.js";
import { FileOutputAdapter } from "../pipeline/primitives/persist-output.js";
import { buildConflictFilter } from "../pipeline/primitives/conflict-filter.js";
import { FileBackedWorkItemSource } from "@operator/adapters/work-item-source";
import { TextBlockEventStream } from "@operator/adapters/agent-event-stream";
import { parseAgentOutput } from "../pipeline/primitives/agent-output-protocol.js";
import {
  buildAopPlannerBeforeAgent, buildAopPlannerBuildRunInput,
  buildAopPlannerBuildPR, buildAopPlannerAfterAgent,
  buildAopPlannerSynthesizeAgentResult,
  type AopPlannerHookDeps,
} from "../pipeline/composers/aop-planner-stage.js";
import {
  buildVerifierDrivenCreatorBeforeAgent, buildVerifierDrivenCreatorBuildRunInput,
  buildVerifierDrivenCreatorBuildPR, buildVerifierDrivenCreatorAfterAgent,
  type VerifierDrivenCreatorHookDeps,
} from "../pipeline/composers/verifier-driven-creator-stage.js";
import {
  buildPrFeedbackSupervisorBeforeAgent, buildPrFeedbackSupervisorBuildRunInput,
  buildPrFeedbackSupervisorBuildPR, buildPrFeedbackSupervisorAfterAgent,
  buildPrFeedbackSupervisorSynthesizeAgentResult,
  type PrFeedbackSupervisorHookDeps,
} from "../pipeline/composers/pr-feedback-supervisor-stage.js";
import {
  buildDiscoveryIterationBeforeAgent, buildDiscoveryIterationBuildPR,
  buildDiscoveryIterationAfterAgent, buildDiscoveryIterationSynthesizeAgentResult,
  type DiscoveryIterationHookDeps,
} from "../pipeline/composers/discovery-iteration-stage.js";
import {
  buildWeeklyMetricsBeforeAgent, buildWeeklyMetricsBuildRunInput,
  buildWeeklyMetricsBuildPR, buildWeeklyMetricsAfterAgent,
  type WeeklyMetricsHookDeps,
} from "../pipeline/composers/weekly-metrics-stage.js";
import { buildGitHubRunUrl } from "../infra/env.js";
import type { TrackerPlatform } from "@operator/core";
import type { ActionName, ActionResult } from "./project-runner.js";
import type { KVTemplateSource } from "../agents/kv-template-source.js";
import type { StateContextVars } from "../work-items/work-items.js";

/**
 * Shared dependencies passed into every stage handler factory.
 *
 * Phase B Part 3 (2026-05-20) extracted the per-stage handler inline
 * blocks from `entry.ts` into composer-keyed factories living here.
 * `entry.ts` constructs this bundle once per `executeAction` call and
 * dispatches the right factory by `stageRow.composer` — no stage names
 * appear in `entry.ts` anymore.
 *
 * The factories themselves still embed the runStage assembly because
 * each composer wires different hooks. What changed is that
 * per-stage knobs (agent role, verifier topic, prefixes, displayName,
 * idVarName etc) come from `stageRow.composerConfig` instead of being
 * hardcoded inline.
 */
export interface StageHandlerSharedDeps {
  readonly config: OperatorConfig;
  readonly project: ProjectConfig;
  readonly tracker?: TrackerPlatform;
  readonly vcs: VCSPlatform;
  readonly prManager: PRManager;
  readonly git: WorkspaceGit;
  readonly state: StateManager;
  readonly kv: KVStore;
  readonly guard: IdempotencyGuard;
  readonly bus: EventBus;
  readonly agentRuntime: AgentRuntime;
  readonly kindRegistry: KindRegistry;
  readonly agentsConfig: AgentsFile;
  readonly promptSource: PromptSource;
  readonly templates: KVTemplateSource;
  readonly stateVars: StateContextVars;
  readonly log: Logger;
  readonly workspacePath: string;
  readonly automationDir: string;
  readonly findingsDir: string;
  readonly tasksDir: string;
  readonly retrospectivesDir: string;
  readonly templatesDir: string;
  readonly baseBranch: string;
  readonly actionCtx: OperationContext;
  readonly action: ActionName;
}

type ComposerFactory = (
  stageRow: WorkflowStageEntry,
  shared: StageHandlerSharedDeps,
) => () => Promise<ActionResult>;

const composerFactories: Record<string, ComposerFactory> = {
  "aop-planner": buildAopPlannerHandler,
  "verifier-driven-creator": buildVerifierDrivenCreatorHandler,
  "pr-feedback-supervisor": buildPrFeedbackSupervisorHandler,
  "discovery-iteration": buildDiscoveryIterationHandler,
  "weekly-metrics": buildWeeklyMetricsHandler,
  "bootstrap-init": buildBootstrapInitHandler,
};

/**
 * Look up the handler factory for the stage row's `composer` field and
 * build the runtime handler. Returns `undefined` when the row has no
 * `composer` (handler-less workflow stage) or names a composer the engine
 * does not recognise (typo / future composer). Caller treats `undefined`
 * as "this stage has no auto-fire handler" and falls back to its action-
 * not-found path.
 */
export function buildStageHandler(
  stageRow: WorkflowStageEntry,
  shared: StageHandlerSharedDeps,
): (() => Promise<ActionResult>) | undefined {
  if (!stageRow.composer) return undefined;
  const factory = composerFactories[stageRow.composer];
  if (!factory) {
    shared.log.warn(
      `stage ${stageRow.name}: unknown composer "${stageRow.composer}" — handler skipped`,
      { stage: stageRow.name, composer: stageRow.composer },
    );
    return undefined;
  }
  return factory(stageRow, shared);
}

// ── Shared helpers ──────────────────────────────────────────────────

function getConfigString(cfg: Record<string, unknown> | undefined, key: string, fallback?: string): string {
  const v = cfg?.[key];
  if (typeof v === "string") return v;
  if (fallback !== undefined) return fallback;
  throw new Error(`composerConfig: missing required string "${key}"`);
}

function getAgentRole(cfg: Record<string, unknown> | undefined, fallback?: AgentRoleName): AgentRoleName {
  return getConfigString(cfg, "agentRole", fallback) as AgentRoleName;
}

function branchPrefixForKind(conv: ConventionsConfig, kind: string): string {
  const map = conv.branches as unknown as Record<string, string>;
  // Convention: branch buckets are pluralised kind names (`tasks`,
  // `findings`, `research`, `improver`). Fallback covers unknown kinds.
  const lookup = kind === "task" ? "tasks" : kind === "finding" ? "findings" : `${kind}s`;
  return map[lookup] ?? `ai/${lookup}`;
}

function prPrefixForKind(conv: ConventionsConfig, kind: string): string {
  const map = conv.prPrefixes as unknown as Record<string, string>;
  return map[kind] ?? `[AI:${kind}]`;
}

function getConfigOptString(cfg: Record<string, unknown> | undefined, key: string): string | undefined {
  const v = cfg?.[key];
  return typeof v === "string" ? v : undefined;
}

function getConfigStringArray(cfg: Record<string, unknown> | undefined, key: string, fallback: string[]): string[] {
  const v = cfg?.[key];
  if (Array.isArray(v) && v.every((x) => typeof x === "string")) return v as string[];
  return fallback;
}

function mapRunStageResultToActionResult(
  action: ActionName,
  result: { status: string; prNumber?: number; reason?: string },
  displayMessage: string,
): ActionResult {
  return {
    action,
    status: result.status === "completed" ? "completed"
      : result.status === "skipped" ? "skipped"
      : "failed",
    message: result.prNumber ? `${displayMessage} PR #${result.prNumber}`
      : result.reason ? result.reason
      : `${displayMessage} completed`,
  };
}

/**
 * Build the `runStage` deps bundle every composer needs. Common to all
 * six factories so we don't duplicate the same eight-property literal.
 * `state` is included for composers that need the state-manager hook
 * (most do); `perItemFilter` is optional (only task-execute uses it).
 */
function commonRunStageDeps(shared: StageHandlerSharedDeps): {
  guard: IdempotencyGuard;
  workspace: FileWorkspaceScope;
  persistOutput: FileOutputAdapter;
  parentExecutionId: string | undefined;
  selectors: ReturnType<typeof createDefaultSelectorRegistry>;
  agentInvocation: FileAgentInvocation;
  verdictRouter: FileVerdictRouter;
  bus: EventBus;
  vcs: VCSPlatform;
  prManager: PRManager;
  agentRuntime: AgentRuntime;
  git: WorkspaceGit;
  workspacePath: string;
  kv: KVStore;
  state: StateManager;
  conventions: ConventionsConfig;
  log: Logger;
} {
  return {
    guard: shared.guard,
    workspace: new FileWorkspaceScope(),
    persistOutput: new FileOutputAdapter(),
    parentExecutionId: shared.actionCtx.parentExecutionId,
    selectors: createDefaultSelectorRegistry(),
    agentInvocation: new FileAgentInvocation(),
    verdictRouter: new FileVerdictRouter(),
    bus: shared.bus,
    vcs: shared.vcs,
    prManager: shared.prManager,
    agentRuntime: shared.agentRuntime,
    git: shared.git,
    workspacePath: shared.workspacePath,
    kv: shared.kv,
    state: shared.state,
    conventions: shared.config.conventions,
    log: shared.log,
  };
}

// ── Composer factories ──────────────────────────────────────────────

function buildAopPlannerHandler(
  stageRow: WorkflowStageEntry,
  shared: StageHandlerSharedDeps,
): () => Promise<ActionResult> {
  return async () => {
    const cfg = stageRow.composerConfig;
    const parentKind = getConfigString(cfg, "parentKind", "finding");
    const childKind = getConfigString(cfg, "childKind", "task");
    const conv = shared.config.conventions;
    const branchPrefix = branchPrefixForKind(conv, parentKind);
    const prPrefix = prPrefixForKind(conv, parentKind);
    const maxActiveKey = getConfigOptString(cfg, "maxActiveLimitKey");
    const maxActive = maxActiveKey
      ? (shared.project.limits as Record<string, number | undefined> | undefined)?.[maxActiveKey] ?? 2
      : 2;
    const parentDataDir = parentKind === "finding" ? shared.findingsDir : join(shared.workspacePath, shared.kindRegistry.dataDirFor(parentKind));
    const childDataDir = childKind === "task" ? shared.tasksDir : join(shared.workspacePath, shared.kindRegistry.dataDirFor(childKind));

    const workItemSource = new FileBackedWorkItemSource({
      registry: shared.kindRegistry, workspacePath: shared.workspacePath,
    });
    const agentEventStream = new TextBlockEventStream(parseAgentOutput);
    const hookDeps: AopPlannerHookDeps = {
      state: shared.state, vcs: shared.vcs, prManager: shared.prManager, git: shared.git,
      kindRegistry: shared.kindRegistry, workItemSource, agentEventStream,
      parentDataDir, childDataDir,
      automationDir: shared.automationDir, workspacePath: shared.workspacePath, templatesDir: shared.templatesDir,
      agentsConfig: shared.agentsConfig, promptSource: shared.promptSource,
      stateVars: shared.stateVars, log: shared.log,
      debug: shared.project.debug,
      debugRunUrl: buildGitHubRunUrl() ?? undefined,
      kv: shared.kv,
      parentKind,
      agentRole: getAgentRole(cfg),
      verifierTopic: getConfigString(cfg, "verifierTopic"),
      branchPrefix,
      prPrefix,
      prTemplate: getConfigString(cfg, "prTemplate"),
      displayName: getConfigString(cfg, "displayName"),
      idPrefix: getConfigString(cfg, "idPrefix"),
      idVarName: getConfigString(cfg, "idVarName"),
      seqVarName: getConfigString(cfg, "seqVarName"),
    };
    const stageDef: StageDef = {
      name: stageRow.name, agent: stageRow.agent, selector: "per-item",
      selectorConfig: { kind: parentKind, status: "pending" },
      merge: "gated", branchScope: "per-item",
      branchPrefix,
      maxActive,
      schedule: stageRow.schedule, enabled: stageRow.enabled,
      outputSink: stageRow.outputSink,
      reviewEnabled: stageRow.reviewEnabled,
      baseBranch: shared.baseBranch,
    };
    const result = await runStage(stageDef, {
      ...commonRunStageDeps(shared),
      beforeAgent: buildAopPlannerBeforeAgent(hookDeps),
      buildRunInput: buildAopPlannerBuildRunInput(hookDeps),
      synthesizeAgentResult: buildAopPlannerSynthesizeAgentResult(hookDeps),
      buildPR: buildAopPlannerBuildPR(hookDeps),
      afterAgent: buildAopPlannerAfterAgent(hookDeps),
    }, shared.actionCtx);
    return mapRunStageResultToActionResult(shared.action, result, `${hookDeps.displayName}-plan`);
  };
}

function buildVerifierDrivenCreatorHandler(
  stageRow: WorkflowStageEntry,
  shared: StageHandlerSharedDeps,
): () => Promise<ActionResult> {
  return async () => {
    const cfg = stageRow.composerConfig;
    const kind = getConfigString(cfg, "kind", "task");
    const conv = shared.config.conventions;
    const branchPrefix = branchPrefixForKind(conv, kind);
    const prPrefix = prPrefixForKind(conv, kind);
    const maxActiveKey = getConfigOptString(cfg, "maxActiveLimitKey");
    const maxActive = maxActiveKey
      ? (shared.project.limits as Record<string, number | undefined> | undefined)?.[maxActiveKey] ?? 2
      : 2;
    const dataDir = kind === "task" ? shared.tasksDir : join(shared.workspacePath, shared.kindRegistry.dataDirFor(kind));

    let verifyCommand: string | undefined;
    try {
      const { load } = await import("js-yaml");
      const { readFile } = await import("node:fs/promises");
      const projectYaml = await readFile(join(shared.automationDir, "project.yaml"), "utf-8");
      const proj = load(projectYaml) as Record<string, unknown>;
      const scripts = proj.scripts as Record<string, string> | undefined;
      verifyCommand = scripts?.verify;
    } catch {
      // project.yaml missing — stage runs without a verify hook.
    }

    const hookDeps: VerifierDrivenCreatorHookDeps = {
      state: shared.state, vcs: shared.vcs, prManager: shared.prManager, git: shared.git,
      dataDir, automationDir: shared.automationDir, workspacePath: shared.workspacePath, templatesDir: shared.templatesDir,
      agentsConfig: shared.agentsConfig, promptSource: shared.promptSource,
      stateVars: shared.stateVars, verifyCommand, log: shared.log,
      debug: shared.project.debug,
      debugRunUrl: buildGitHubRunUrl() ?? undefined,
      kv: shared.kv,
      kind,
      agentRole: getAgentRole(cfg),
      verifierTopic: getConfigString(cfg, "verifierTopic"),
      branchPrefix,
      prPrefix,
      prTemplate: getConfigString(cfg, "prTemplate"),
      displayName: getConfigString(cfg, "displayName"),
    };
    const filter = buildConflictFilter({
      state: shared.state, kindRegistry: shared.kindRegistry, dataDir, kind, log: shared.log,
    });
    const stageDef: StageDef = {
      name: stageRow.name, agent: stageRow.agent, selector: "per-item",
      selectorConfig: { kind, status: "pending" },
      merge: "gated", branchScope: "per-item",
      branchPrefix,
      maxActive,
      schedule: stageRow.schedule, enabled: stageRow.enabled,
      outputSink: stageRow.outputSink,
      reviewEnabled: stageRow.reviewEnabled,
      baseBranch: shared.baseBranch,
    };
    const result = await runStage(stageDef, {
      ...commonRunStageDeps(shared),
      perItemFilter: filter,
      beforeAgent: buildVerifierDrivenCreatorBeforeAgent(hookDeps),
      buildRunInput: buildVerifierDrivenCreatorBuildRunInput(hookDeps),
      buildPR: buildVerifierDrivenCreatorBuildPR(hookDeps),
      afterAgent: buildVerifierDrivenCreatorAfterAgent(hookDeps),
    }, shared.actionCtx);
    return mapRunStageResultToActionResult(shared.action, result, `${hookDeps.displayName}-execute`);
  };
}

function buildPrFeedbackSupervisorHandler(
  stageRow: WorkflowStageEntry,
  shared: StageHandlerSharedDeps,
): () => Promise<ActionResult> {
  return async () => {
    const cfg = stageRow.composerConfig;
    const conv = shared.config.conventions;
    const branchPrefixes = getConfigStringArray(cfg, "branchPrefixes", [
      conv.branches.tasks,
      conv.branches.findings,
      conv.branches.research,
      conv.branches.improver,
    ]);
    const workItemSource = new FileBackedWorkItemSource({
      registry: shared.kindRegistry, workspacePath: shared.workspacePath,
    });
    const agentEventStream = new TextBlockEventStream(parseAgentOutput);
    const hookDeps: PrFeedbackSupervisorHookDeps = {
      prManager: shared.prManager, git: shared.git, agentsConfig: shared.agentsConfig, promptSource: shared.promptSource,
      defaults: shared.config.defaults,
      automationDir: shared.automationDir, workspacePath: shared.workspacePath,
      kindRegistry: shared.kindRegistry, workItemSource, agentEventStream,
      stateVars: shared.stateVars, log: shared.log,
      debug: shared.project.debug,
      debugRunUrl: buildGitHubRunUrl() ?? undefined,
      agentRole: getAgentRole(cfg),
      verifierTopic: getConfigString(cfg, "verifierTopic"),
    };
    const stageDef: StageDef = {
      name: stageRow.name, agent: stageRow.agent, selector: "pr-feedback",
      selectorConfig: {
        branchPrefixes,
        ignoreBots: shared.config.defaults.review.ignoredBotLogins,
        maxAttemptsPerPR: shared.config.defaults.limits.maxReviewAttempts,
        commentMarker: conv.commentMarker,
      },
      merge: "gated", branchScope: "pr",
      schedule: stageRow.schedule, enabled: stageRow.enabled,
      outputSink: stageRow.outputSink,
      reviewEnabled: stageRow.reviewEnabled,
      baseBranch: shared.baseBranch,
    };
    const result = await runStage(stageDef, {
      ...commonRunStageDeps(shared),
      beforeAgent: buildPrFeedbackSupervisorBeforeAgent(hookDeps),
      synthesizeAgentResult: buildPrFeedbackSupervisorSynthesizeAgentResult(hookDeps),
      buildRunInput: buildPrFeedbackSupervisorBuildRunInput(hookDeps),
      buildPR: buildPrFeedbackSupervisorBuildPR(hookDeps),
      afterAgent: buildPrFeedbackSupervisorAfterAgent(hookDeps),
    }, shared.actionCtx);
    return mapRunStageResultToActionResult(shared.action, result, "supervisor");
  };
}

function buildDiscoveryIterationHandler(
  stageRow: WorkflowStageEntry,
  shared: StageHandlerSharedDeps,
): () => Promise<ActionResult> {
  return async () => {
    const cfg = stageRow.composerConfig;
    const conv = shared.config.conventions;
    const childKind = getConfigString(cfg, "childKind", "finding");
    const childDataDir = childKind === "finding" ? shared.findingsDir : join(shared.workspacePath, shared.kindRegistry.dataDirFor(childKind));
    const workItemSource = new FileBackedWorkItemSource({
      registry: shared.kindRegistry, workspacePath: shared.workspacePath,
    });
    const agentEventStream = new TextBlockEventStream(parseAgentOutput);
    const tracker = shared.tracker;
    const hookDeps: DiscoveryIterationHookDeps = {
      vcs: shared.vcs, tracker,
      state: shared.state, prManager: shared.prManager, agentRuntime: shared.agentRuntime,
      kindRegistry: shared.kindRegistry, workItemSource, agentEventStream,
      conventions: conv, defaults: shared.config.defaults,
      agentsConfig: shared.agentsConfig, promptSource: shared.promptSource,
      automationDir: shared.automationDir,
      childDataDir,
      siblingsDataDir: shared.tasksDir,
      templatesDir: shared.templatesDir, workspacePath: shared.workspacePath,
      stateVars: shared.stateVars, log: shared.log,
      agentRole: getAgentRole(cfg),
      verifierTopic: getConfigString(cfg, "verifierTopic"),
      childKind,
      prPrefix: conv.prPrefixes.research,
      prTemplate: getConfigString(cfg, "prTemplate"),
      prFailedTemplate: getConfigString(cfg, "prFailedTemplate"),
      displayName: getConfigString(cfg, "displayName"),
      siblingsBranchPrefix: conv.branches.tasks,
    };
    const stageDef: StageDef = {
      name: stageRow.name, agent: stageRow.agent, selector: "discovery",
      selectorConfig: {
        discoveryDir: ".operator/analyst",
        retroDay: shared.config.defaults.schedules.improverDayOfWeek,
      },
      merge: "gated",
      branchScope: "per-item",
      branchPrefix: conv.branches.research,
      schedule: stageRow.schedule, enabled: stageRow.enabled,
      outputSink: stageRow.outputSink,
      reviewEnabled: stageRow.reviewEnabled,
      baseBranch: shared.baseBranch,
    };
    const result = await runStage(stageDef, {
      ...commonRunStageDeps(shared),
      beforeAgent: buildDiscoveryIterationBeforeAgent(hookDeps),
      buildRunInput: async () => {
        throw new Error(`${stageRow.name} buildRunInput should not be invoked — synthesizeAgentResult is present`);
      },
      synthesizeAgentResult: buildDiscoveryIterationSynthesizeAgentResult(hookDeps),
      afterAgent: buildDiscoveryIterationAfterAgent(hookDeps),
      buildPR: buildDiscoveryIterationBuildPR(hookDeps),
    }, shared.actionCtx);
    return mapRunStageResultToActionResult(shared.action, result, "Research");
  };
}

function buildWeeklyMetricsHandler(
  stageRow: WorkflowStageEntry,
  shared: StageHandlerSharedDeps,
): () => Promise<ActionResult> {
  return async () => {
    const cfg = stageRow.composerConfig;
    const conv = shared.config.conventions;
    const workItemSource = new FileBackedWorkItemSource({
      registry: shared.kindRegistry, workspacePath: shared.workspacePath,
    });
    const agentEventStream = new TextBlockEventStream(parseAgentOutput);
    const hookDeps: WeeklyMetricsHookDeps = {
      vcs: shared.vcs, state: shared.state, prManager: shared.prManager,
      kindRegistry: shared.kindRegistry,
      workItemSource,
      agentEventStream,
      conventions: conv,
      agentsConfig: shared.agentsConfig, promptSource: shared.promptSource,
      automationDir: shared.automationDir,
      reportsDir: shared.retrospectivesDir,
      templatesDir: shared.templatesDir, workspacePath: shared.workspacePath,
      stateVars: shared.stateVars, log: shared.log,
      agentRole: getAgentRole(cfg),
      verifierTopic: getConfigString(cfg, "verifierTopic"),
      scopeVarName: getConfigString(cfg, "scopeVarName"),
      prPrefix: conv.prPrefixes.improver,
      prTemplate: getConfigString(cfg, "prTemplate"),
      prFailedTemplate: getConfigString(cfg, "prFailedTemplate"),
      displayName: getConfigString(cfg, "displayName"),
      agentDisplayName: getConfigString(cfg, "agentDisplayName"),
    };
    const stageDef: StageDef = {
      name: stageRow.name, agent: stageRow.agent, selector: "singleton",
      selectorConfig: {
        scopeKind: "week",
        requiredFileTemplate: ".operator/data/retrospectives/{scopeKey}.md",
      },
      merge: "gated", branchScope: "per-item",
      branchPrefix: "ai/retrospective",
      schedule: stageRow.schedule, enabled: stageRow.enabled,
      outputSink: stageRow.outputSink,
      reviewEnabled: stageRow.reviewEnabled,
      baseBranch: shared.baseBranch,
    };
    const result = await runStage(stageDef, {
      ...commonRunStageDeps(shared),
      beforeAgent: buildWeeklyMetricsBeforeAgent(hookDeps),
      buildRunInput: buildWeeklyMetricsBuildRunInput(hookDeps),
      buildPR: buildWeeklyMetricsBuildPR(hookDeps),
      afterAgent: buildWeeklyMetricsAfterAgent(hookDeps),
    }, shared.actionCtx);
    return mapRunStageResultToActionResult(shared.action, result, "Retrospective");
  };
}

function buildBootstrapInitHandler(
  stageRow: WorkflowStageEntry,
  shared: StageHandlerSharedDeps,
): () => Promise<ActionResult> {
  return async () => {
    const cfg = stageRow.composerConfig;
    const conv = shared.config.conventions;
    const scaffoldDirs = getConfigStringArray(cfg, "scaffoldDirs", [
      "context", "analyst", "creator", "verifier", "planner", "improver",
      "data/tasks", "data/findings", "data/retrospectives",
    ]);
    const readmeTemplate = getConfigString(cfg, "readmeTemplate", "operator-user-readme.md");
    const commitMessage = getConfigString(cfg, "commitMessage", "Initialize .operator for AI Operator");
    const prTemplate = getConfigString(cfg, "prTemplate", "init-pr-body.md");
    const agentRole = getConfigString(cfg, "agentRole", "scout") as AgentRoleName;
    const verifierTopic = getConfigString(cfg, "verifierTopic", "init");

    const stageDef: StageDef = {
      name: stageRow.name, agent: stageRow.agent, selector: "bootstrap",
      selectorConfig: { requiredFile: ".operator/project.yaml" },
      merge: "gated",
      branchScope: "singleton",
      branchPrefix: conv.branches.init,
      schedule: stageRow.schedule, enabled: stageRow.enabled,
      outputSink: stageRow.outputSink,
      reviewEnabled: stageRow.reviewEnabled,
      baseBranch: shared.baseBranch,
    };
    const result = await runStage(stageDef, {
      ...commonRunStageDeps(shared),
      beforeAgent: async () => {
        const operatorDir = join(shared.workspacePath, ".operator");
        const { mkdir, writeFile } = await import("node:fs/promises");
        for (const dir of scaffoldDirs) {
          const full = join(operatorDir, dir);
          await mkdir(full, { recursive: true });
          await writeFile(join(full, ".gitkeep"), "", "utf-8");
        }
        try {
          const readme = await shared.templates.load(readmeTemplate);
          await writeFile(join(operatorDir, "README.md"), readme, "utf-8");
        } catch {
          // README template missing in KV is non-fatal — init proceeds without it.
        }
      },
      buildRunInput: async () => {
        const role = resolveRole(shared.agentsConfig, agentRole);
        return buildRunInput(
          role,
          {
            promptSource: shared.promptSource, automationDir: shared.automationDir, vars: {
              REPO_NAME: shared.project.vcs.repo,
              REPO_ID: shared.project.id,
              BRANCH_MAIN: shared.baseBranch,
              BRANCH_DEVELOP: shared.baseBranch,
              ...shared.stateVars,
            },
          },
          {
            taskContent: `Initialize .operator/ for repository ${shared.project.vcs.repo} (${shared.project.id}). Analyze the codebase and generate project.yaml (scripts and context config), context files, and analyzer rules.`,
            cwd: shared.workspacePath,
            maxRetries: 2,
            reviewCriteria: role.review
              ? await shared.promptSource.loadChain(`verifier/${verifierTopic}`)
              : undefined,
          },
        );
      },
      buildPR: async () => ({
        title: `${conv.prPrefixes.init} ${commitMessage}`,
        body: await shared.prManager.loadTemplate(shared.templatesDir, prTemplate, { FILE_LIST: "" })
          .catch(() => `## ${commitMessage}\n\nGenerated by AI Operator — ${agentRole} agent.`),
        commitMessage,
      }),
    }, shared.actionCtx);
    return mapRunStageResultToActionResult(shared.action, result, "Init");
  };
}
