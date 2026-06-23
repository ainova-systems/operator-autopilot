import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  OperationContext, VCSPlatform, StateManager, ConventionsConfig, PromptSource,
  KindRegistry, WorkItemSource, AgentEventStream, AgentRoleName,
} from "@operator/core";
import { errorMessage } from "@operator/core";
import type { AgentRunInput } from "../../agents/runtime.js";
import type { AgentsFile } from "../../config/schemas.js";
import type { PRManager } from "../../delivery/pr-manager.js";
import type { Logger } from "../../logging/logger.js";
import { resolveRole, instructionsPathToTopic, ROLE_OUTPUT_FORMATS } from "../../agents/roles.js";
import { stripPreamble, stripCodeFences, parseAgentOutput } from "../../agents/output-parser.js";
import type { StageDef, StageInput, AgentResult, Verdict } from "../types.js";
import type { WorkspaceHandle } from "../primitives/workspace-scope.js";
import type { SingletonPayload } from "../primitives/singleton-selector.js";
import { type StateContextVars } from "../../work-items/work-items.js";
import { applyAgentEvents } from "../primitives/aop-applier.js";
import { aggregateRetrospectiveMetrics } from "../primitives/metrics-aggregator.js";
import { createScratchStore } from "./_shared/scratch.js";
import { StageLogicError } from "./errors.js";

/**
 * Generic stage composer for the "weekly metrics" pattern — singleton-
 * scope stage that aggregates a periodic metrics brief, feeds it to a
 * single agent, writes the agent's markdown report, and routes any
 * supplementary AOP EMIT records (improver-style status updates) through
 * the WorkItemSource.
 *
 * Pattern shape (kind-agnostic, stage-name-agnostic):
 *
 *   1. `singleton` selector emits a single StageInput with
 *      `{scopeKey: scopeKey}` — one PR per scope key (e.g. per week).
 *   2. `WorkspaceScope.prepare` creates or reuses the singleton branch.
 *   3. `beforeAgent`: aggregate metrics into a markdown brief, stash in
 *      scratch. Optionally markProcessing on any existing PR.
 *   4. `buildRunInput`: construct the configured agent's input using
 *      the metrics brief as `taskContent`.
 *   5. `runStage` invokes the agent.
 *   6. `afterAgent`: clean the agent output, write the report file,
 *      apply any AOP EMIT records as supplementary actions.
 *   7. `buildPR`: pulls the configured success / failed PR templates.
 *
 * The composer is consumed by any stage matching this pattern.
 * A weekly `retrospective` stage that produces a markdown report is
 * the canonical example.
 */

interface WeeklyMetricsScratch {
  readonly scopeKey: string;
  readonly metrics: string;
  success: boolean;
  failureReason: string | null;
}

const weeklyMetricsScratch = createScratchStore<WeeklyMetricsScratch>();

export interface WeeklyMetricsHookDeps {
  readonly vcs: VCSPlatform;
  readonly state: StateManager;
  readonly prManager: PRManager;
  readonly kindRegistry: KindRegistry;
  readonly conventions: ConventionsConfig;
  readonly agentsConfig: AgentsFile;
  readonly promptSource: PromptSource;
  readonly workItemSource: WorkItemSource;
  readonly agentEventStream: AgentEventStream;
  readonly automationDir: string;
  /** Directory the report file is written to (e.g. retrospectives dir). */
  readonly reportsDir: string;
  readonly templatesDir: string;
  readonly workspacePath: string;
  readonly stateVars?: StateContextVars;
  readonly log?: Logger;

  // ── Stage-shape parameters ────────────────────────────────────────
  /** Agent role producing the markdown report (e.g. `"improver"`). */
  readonly agentRole: AgentRoleName;
  /** Verifier chain topic suffix, used as `verifier/{verifierTopic}`. */
  readonly verifierTopic: string;
  /** Variable name used in the prompt template (e.g. `"WEEK"`). */
  readonly scopeVarName: string;
  /** PR title prefix (e.g. `"[AI:Improver]"`). */
  readonly prPrefix: string;
  /** Success PR body template filename. */
  readonly prTemplate: string;
  /** Failure PR body template filename. */
  readonly prFailedTemplate: string;
  /** Human-facing display name (e.g. `"Weekly optimization"`). */
  readonly displayName: string;
  /** Human-facing display name for the agent (e.g. `"Improver"`). */
  readonly agentDisplayName: string;
}

function payloadOf(stageName: string, input: StageInput): SingletonPayload {
  const data = input.data as SingletonPayload | undefined;
  if (!data || typeof data.scopeKey !== "string") {
    throw new StageLogicError(
      "INVALID_STAGE_INPUT",
      `${stageName} hook: missing SingletonPayload (scopeKey: ${input.scopeKey})`,
    );
  }
  return data;
}

export function buildWeeklyMetricsBeforeAgent(deps: WeeklyMetricsHookDeps) {
  return async (
    stage: StageDef,
    input: StageInput,
    workspace: WorkspaceHandle,
    ctx: OperationContext,
  ): Promise<void> => {
    const { scopeKey } = payloadOf(stage.name, input);
    deps.log?.info(`${stage.name}: aggregating metrics for ${scopeKey}`, {
      stage: stage.name, scopeKey,
    });

    try {
      const existingPR = await deps.prManager.findOpenPR(workspace.branch);
      if (existingPR) {
        await deps.prManager.markProcessing(existingPR.id);
        deps.log?.debug(`${stage.name}: markProcessing PR #${existingPR.id}`, {
          stage: stage.name, scopeKey, prNumber: existingPR.id,
        });
      }
    } catch (err) {
      deps.log?.warn(`${stage.name}: markProcessing failed (non-fatal)`, {
        stage: stage.name, scopeKey,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    const metrics = await aggregateRetrospectiveMetrics({
      vcs: deps.vcs,
      kindRegistry: deps.kindRegistry,
      workspacePath: deps.workspacePath,
      conventions: deps.conventions,
    });

    weeklyMetricsScratch.set(ctx, scopeKey, {
      scopeKey, metrics, success: false, failureReason: null,
    });
    deps.log?.debug(`${stage.name}: metrics brief length=${metrics.length} chars`, {
      stage: stage.name, scopeKey, length: metrics.length,
    });
  };
}

export function buildWeeklyMetricsBuildRunInput(deps: WeeklyMetricsHookDeps) {
  return async (
    stage: StageDef,
    input: StageInput,
    ctx: OperationContext,
  ): Promise<AgentRunInput> => {
    const { scopeKey } = payloadOf(stage.name, input);
    const scratch = weeklyMetricsScratch.get(ctx, scopeKey);
    if (!scratch) {
      throw new StageLogicError(
        "STAGE_SCRATCH_MISSING",
        `${stage.name} buildRunInput: missing scratch for ${scopeKey} — beforeAgent not run`,
      );
    }

    const role = resolveRole(deps.agentsConfig, deps.agentRole);
    const reviewCriteria = role.review
      ? await deps.promptSource.loadChain(`verifier/${deps.verifierTopic}`)
      : undefined;

    return {
      agentName: deps.agentRole,
      providerId: role.provider,
      promptContext: {
        promptSource: deps.promptSource,
        automationDir: deps.automationDir,
        contextFiles: role.context.length > 0 ? role.context : [],
        instructionsTopic: instructionsPathToTopic(role.instructions),
        vars: { [deps.scopeVarName]: scopeKey, ...deps.stateVars },
      },
      taskContent: scratch.metrics,
      model: role.model,
      timeoutMs: role.timeout * 1000,
      tools: role.tools.length > 0 ? role.tools : undefined,
      maxBudgetUsd: role.maxBudget,
      maxRetries: 2,
      reviewEnabled: role.review,
      reviewCriteria,
      cwd: deps.automationDir,
    };
  };
}

export function buildWeeklyMetricsAfterAgent(deps: WeeklyMetricsHookDeps) {
  return async (
    stage: StageDef,
    input: StageInput,
    agentResult: AgentResult,
    _workspace: WorkspaceHandle,
    ctx: OperationContext,
  ): Promise<{ verdictOverride?: Verdict; summaryOverride?: string } | void> => {
    const { scopeKey } = payloadOf(stage.name, input);
    const scratch = weeklyMetricsScratch.get(ctx, scopeKey);
    if (!scratch) {
      throw new StageLogicError(
        "STAGE_SCRATCH_MISSING",
        `${stage.name} afterAgent: missing scratch for ${scopeKey} — beforeAgent not run`,
      );
    }

    try {
      await mkdir(deps.reportsDir, { recursive: true });
    } catch (err) {
      deps.log?.warn(`${stage.name}: could not create ${deps.reportsDir}`, {
        stage: stage.name, scopeKey, error: errorMessage(err),
      });
    }

    if (agentResult.verdict !== "approved") {
      const reason = agentResult.summary || `${deps.agentDisplayName} agent failed. Review logs.`;
      scratch.success = false;
      scratch.failureReason = reason;
      try {
        await writeFile(
          join(deps.reportsDir, `${scopeKey}.failed`),
          `${deps.agentDisplayName} failed for ${scopeKey}: ${reason}\n`,
          "utf-8",
        );
      } catch (err) {
        deps.log?.warn(`${stage.name}: could not write failure marker for ${scopeKey}`, {
          stage: stage.name, scopeKey, error: errorMessage(err),
        });
      }
      deps.log?.warn(`${stage.name}: ${scopeKey} verdict=${agentResult.verdict} (${reason})`, {
        stage: stage.name, scopeKey, verdict: agentResult.verdict, reason,
      });
      return {
        summaryOverride: `${stage.name} ${scopeKey}: ${reason}`,
      };
    }

    let cleaned: string;
    try {
      const stripped = stripPreamble(stripCodeFences(agentResult.output.trim()));
      const parsed = parseAgentOutput(stripped, ROLE_OUTPUT_FORMATS[deps.agentRole]);
      cleaned = parsed.raw;
    } catch (err) {
      deps.log?.warn(`${stage.name}: ${deps.agentRole} output failed frontmatter validation, persisting cleaned output`, {
        stage: stage.name, scopeKey, error: errorMessage(err),
      });
      cleaned = stripPreamble(stripCodeFences(agentResult.output.trim()));
    }

    const outputPath = join(deps.reportsDir, `${scopeKey}.md`);
    await writeFile(outputPath, cleaned, "utf-8");
    scratch.success = true;

    try {
      const applied = await applyAgentEvents(
        agentResult.output,
        {
          stream: deps.agentEventStream,
          source: deps.workItemSource,
          registry: deps.kindRegistry,
          log: deps.log,
        },
        {},
        ctx,
      );
      if (applied.applied.statusUpdates.length > 0 || applied.applied.childItems.length > 0) {
        deps.log?.info(
          `${stage.name}: ${scopeKey} applied ${applied.applied.statusUpdates.length} status-update(s) and ${applied.applied.childItems.length} child-item(s) via AOP`,
          {
            stage: stage.name, scopeKey,
            statusUpdates: applied.applied.statusUpdates.length,
            childItems: applied.applied.childItems.length,
          },
        );
      }
    } catch (err) {
      deps.log?.warn(`${stage.name}: ${scopeKey} applyAgentEvents failed (non-fatal)`, {
        stage: stage.name, scopeKey, error: errorMessage(err),
      });
    }

    deps.log?.info(`${stage.name}: ${scopeKey} generated (${cleaned.length} chars)`, {
      stage: stage.name, scopeKey, outputPath, length: cleaned.length,
    });

    return {
      summaryOverride: `${stage.name} ${scopeKey} generated`,
    };
  };
}

export function buildWeeklyMetricsBuildPR(deps: WeeklyMetricsHookDeps) {
  return async (
    stage: StageDef,
    input: StageInput,
    ctx: OperationContext,
  ): Promise<{ title: string; body: string; commitMessage: string; onSuccess?: "in-review" | "ready-to-merge" | "none" }> => {
    const { scopeKey } = payloadOf(stage.name, input);
    const scratch = weeklyMetricsScratch.get(ctx, scopeKey);
    if (!scratch) {
      throw new StageLogicError(
        "STAGE_SCRATCH_MISSING",
        `${stage.name} buildPR: missing scratch for ${scopeKey} — beforeAgent not run`,
      );
    }

    try {
      if (!scratch.success) {
        const body = await deps.prManager
          .loadTemplate(deps.templatesDir, deps.prFailedTemplate, {
            [deps.scopeVarName]: scopeKey,
            FAILURE_REASON: scratch.failureReason ?? `${deps.agentDisplayName} agent failed. Review logs.`,
          })
          .catch(() => `${deps.agentDisplayName} agent failed for ${scopeKey}.`);
        return {
          title: `${deps.prPrefix} ${scopeKey}: failed`,
          body,
          commitMessage: `${deps.displayName} ${scopeKey}: failed`,
        };
      }

      const body = await deps.prManager
        .loadTemplate(deps.templatesDir, deps.prTemplate, { [deps.scopeVarName]: scopeKey })
        .catch(() => `## ${deps.displayName} ${scopeKey}`);
      return {
        title: `${deps.prPrefix} ${scopeKey}`,
        body,
        commitMessage: `${deps.displayName} ${scopeKey}`,
        onSuccess: "in-review",
      };
    } finally {
      weeklyMetricsScratch.clear(ctx, scopeKey);
    }
  };
}
