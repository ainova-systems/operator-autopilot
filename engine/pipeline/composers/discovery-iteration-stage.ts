import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  OperationContext, StateManager, VCSPlatform, TrackerPlatform,
  ConventionsConfig, DefaultsConfig, PromptSource, KindRegistry,
  WorkItemSource, AgentEventStream, AgentRoleName, WorkItemKind,
} from "@operator/core";
import { errorMessage } from "@operator/core";
import type { AgentRunInput, AgentRuntime, AgentEventSink } from "../../agents/runtime.js";
import type { AgentsFile } from "../../config/schemas.js";
import type { PRManager } from "../../delivery/pr-manager.js";
import type { Logger } from "../../logging/logger.js";
import { resolveRole, instructionsPathToTopic } from "../../agents/roles.js";
import {
  syncWorkItemToDb,
  type StateContextVars, type WorkItemFileData,
} from "../../work-items/work-items.js";
import type { StageDef, StageInput, AgentResult, Verdict } from "../types.js";
import type { WorkspaceHandle } from "../primitives/workspace-scope.js";
import type { AnalyzerDef, DiscoveryPayload } from "../primitives/discovery-selector.js";
import { applyAgentEvents } from "../primitives/aop-applier.js";
import { iterateBestEffort } from "../primitives/analyzer-iteration.js";
import { runRejectionHandler, type RejectionHandlerDeps } from "./closed-pr-recovery.js";
import { createScratchStore } from "./_shared/scratch.js";
import { StageLogicError } from "./errors.js";

/**
 * Generic stage composer for the "discovery iteration" pattern.
 *
 * Pattern shape (kind-agnostic, stage-name-agnostic):
 *
 *  1. `discovery` selector enumerates analyzer definitions from a
 *     configured directory and returns a single StageInput with
 *     `{date, analyzers}`. Null → skip ("no eligible analyzers").
 *  2. `WorkspaceScope.prepare` creates/reuses the singleton branch.
 *  3. `beforeAgent`: iterates all analyzers in order via the
 *     {@link iterateBestEffort} primitive. Per-analyzer the configured
 *     agent (e.g. the analyst role) runs and emits AOP `EMIT child-item`
 *     records routed through {@link applyAgentEvents}. Optionally runs
 *     the rejection-handling sub-flow.
 *  4. `synthesizeAgentResult`: builds the aggregate AgentResult from
 *     scratch — `approved` when at least one child-item came out,
 *     `failed` when every analyzer threw.
 *  5. `buildPR`: pulls the configured success / failed PR template.
 *  6. `afterAgent`: no-op (heavy lifting in step 3-4).
 *
 * The composer is consumed by any stage whose pattern is "iterate a
 * list of analyzer-style sub-tasks, each producing AOP records for the
 * configured child kind". A `research` stage that runs multiple
 * analyzers and produces findings is the canonical example, but any
 * future repo can compose this same pattern by passing its own kind,
 * agent role, verifier topic, branch prefix, and PR templates through
 * {@link DiscoveryIterationHookDeps}.
 */

interface DiscoveryIterationScratch {
  readonly date: string;
  readonly analyzerCount: number;
  readonly childItemIds: string[];
  readonly successCount: number;
  readonly allFailed: boolean;
  readonly failureBody: string | null;
}

const discoveryIterationScratch = createScratchStore<DiscoveryIterationScratch>();

export interface DiscoveryIterationHookDeps {
  readonly vcs: VCSPlatform;
  readonly tracker?: TrackerPlatform;
  readonly state: StateManager;
  readonly prManager: PRManager;
  readonly agentRuntime: AgentRuntime;
  readonly kindRegistry: KindRegistry;
  readonly conventions: ConventionsConfig;
  readonly defaults: DefaultsConfig;
  readonly agentsConfig: AgentsFile;
  readonly promptSource: PromptSource;
  /** File-backed source for `EMIT child-item` work-item creation. */
  readonly workItemSource: WorkItemSource;
  /** Agent event stream wrapping parseAgentOutput. */
  readonly agentEventStream: AgentEventStream;
  readonly automationDir: string;
  /** Data dir where child work-items are produced (e.g. findings dir). */
  readonly childDataDir: string;
  /** Data dir for items the rejection-handler scans (e.g. tasks dir). */
  readonly siblingsDataDir: string;
  readonly templatesDir: string;
  readonly workspacePath: string;
  readonly stateVars?: StateContextVars;
  readonly log?: Logger;

  // ── Stage-shape parameters ────────────────────────────────────────
  /** Agent role producing the AOP child-item records (e.g. `"analyst"`). */
  readonly agentRole: AgentRoleName;
  /** Verifier chain topic suffix, used as `verifier/{verifierTopic}`. */
  readonly verifierTopic: string;
  /** Child work-item kind that the agent's EMIT child-item records produce. */
  readonly childKind: WorkItemKind;
  /** PR title prefix (e.g. `"[AI:Research]"`). */
  readonly prPrefix: string;
  /** Success-path PR body template filename. */
  readonly prTemplate: string;
  /** Failure-path PR body template filename. */
  readonly prFailedTemplate: string;
  /** Human-facing display name for the stage / commit messages (e.g. `"research"`). */
  readonly displayName: string;
  /** Branch prefix used by rejection-handler when scanning siblings. */
  readonly siblingsBranchPrefix: string;
}

function payloadOf(stageName: string, input: StageInput): DiscoveryPayload {
  const data = input.data as DiscoveryPayload | undefined;
  if (!data || typeof data.date !== "string" || !Array.isArray(data.analyzers)) {
    throw new StageLogicError(
      "INVALID_STAGE_INPUT",
      `${stageName} hook: missing DiscoveryPayload (scopeKey: ${input.scopeKey})`,
    );
  }
  return data;
}

/**
 * Head+tail excerpt of an agent's raw output for the per-analyzer INFO line.
 * The full output also lands in `execution-logs` via the history sink; this
 * keeps the single log line readable while still surfacing what the analyst
 * concluded (e.g. why it emitted zero findings).
 */
function outputExcerpt(output: string, max = 1200): string {
  const trimmed = output.trim();
  if (trimmed.length <= max) return trimmed;
  const headLen = Math.floor(max * 0.6);
  const tailLen = Math.floor(max * 0.4);
  return `${trimmed.slice(0, headLen)}\n…[${trimmed.length - headLen - tailLen} chars omitted]…\n${trimmed.slice(-tailLen)}`;
}

async function runSingleAnalyzer(
  deps: DiscoveryIterationHookDeps,
  stageName: string,
  ctx: OperationContext,
  date: string,
  analyzer: AnalyzerDef,
  history: AgentEventSink,
): Promise<string | null> {
  deps.log?.info(`${stageName}: running analyzer ${analyzer.id} (schedule=${analyzer.schedule})`, {
    stage: stageName, analyzerId: analyzer.id, schedule: analyzer.schedule,
  });
  const sourceKey = `${analyzer.id}#${date}`;
  if (await deps.state.isKnownItem(ctx, ctx.repoId, sourceKey)) {
    deps.log?.info(`${stageName}: analyzer ${analyzer.id} already ran for ${date}, skipping`, {
      stage: stageName, analyzerId: analyzer.id, date, reason: "known-item",
    });
    return null;
  }

  const timestamp = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const role = resolveRole(deps.agentsConfig, deps.agentRole);
  const reviewCriteria = role.review
    ? await deps.promptSource.loadChain(`verifier/${deps.verifierTopic}`)
    : undefined;

  const runInput: AgentRunInput = {
    agentName: deps.agentRole,
    providerId: role.provider,
    promptContext: {
      promptSource: deps.promptSource,
      automationDir: deps.automationDir,
      contextFiles: role.context.length > 0 ? role.context : ["base"],
      instructionsTopic: instructionsPathToTopic(role.instructions),
      vars: {
        DATE: date,
        ANALYZER_NAME: analyzer.id,
        TIMESTAMP: timestamp,
        ...deps.stateVars,
      },
    },
    taskContent: analyzer.body,
    model: role.model,
    timeoutMs: role.timeout * 1000,
    tools: role.tools.length > 0 ? role.tools : undefined,
    maxBudgetUsd: role.maxBudget,
    maxRetries: 1,
    reviewEnabled: role.review,
    reviewCriteria,
    cwd: deps.workspacePath,
    // Route each analyzer's run through the stage's execution-history sink so
    // its full prompt + output land in `execution-logs` — without this the
    // analyst's reasoning (and WHY it emitted zero findings) is invisible
    // outside the daemon's console.
    history,
  };

  const result = await deps.agentRuntime.run(runInput, ctx);
  deps.log?.info(`${stageName}: analyzer ${analyzer.id} agent output (${result.output.length} chars)`, {
    stage: stageName, analyzerId: analyzer.id, outputChars: result.output.length,
    outputExcerpt: outputExcerpt(result.output),
  });

  const applied = await applyAgentEvents(
    result.output,
    {
      stream: deps.agentEventStream,
      source: deps.workItemSource,
      registry: deps.kindRegistry,
      log: deps.log,
    },
    { date },
    ctx,
  );

  if (applied.applied.childItems.length === 0) {
    deps.log?.info(`${stageName}: analyzer ${analyzer.id} reported no findings (NO_NEW_FINDINGS path)`, {
      stage: stageName, analyzerId: analyzer.id, date,
      applierVerdict: applied.verdict,
      applierSummary: applied.summary,
    });
    await deps.state.markKnownItem(ctx, ctx.repoId, sourceKey);
    return null;
  }

  const childItem = applied.applied.childItems[0];
  const fileData: WorkItemFileData = {
    id: childItem.id,
    kind: deps.childKind,
    title: childItem.title,
    body: childItem.body,
    status: "pending",
    priority: childItem.priority,
    source: childItem.source ?? analyzer.id,
    createdAt: childItem.createdAt,
  };
  await deps.state.markKnownItem(ctx, ctx.repoId, sourceKey);
  await syncWorkItemToDb(deps.state, ctx, fileData);
  deps.log?.info(`${stageName}: analyzer ${analyzer.id} created ${deps.childKind} ${childItem.id} (P${childItem.priority}) via AOP applier`, {
    stage: stageName, analyzerId: analyzer.id, childItemId: childItem.id,
    priority: childItem.priority,
  });
  return childItem.id;
}

export function buildDiscoveryIterationBeforeAgent(deps: DiscoveryIterationHookDeps) {
  return async (
    stage: StageDef,
    input: StageInput,
    _workspace: WorkspaceHandle,
    ctx: OperationContext,
    history: AgentEventSink,
  ): Promise<void> => {
    const payload = payloadOf(stage.name, input);
    const date = payload.date;

    const iter = await iterateBestEffort(
      payload.analyzers,
      (analyzer) => runSingleAnalyzer(deps, stage.name, ctx, date, analyzer, history),
      {
        onItemError: (analyzer, err) => {
          deps.log?.error(`${stage.name}: analyzer ${analyzer.id} failed`, {
            stage: stage.name, analyzerId: analyzer.id, error: errorMessage(err),
            cause: err instanceof Error && err.cause ? String(err.cause) : undefined,
          });
        },
      },
    );
    const childItemIds: string[] = iter.results;
    const successCount = iter.successCount;
    const analyzerCount = payload.analyzers.length;
    const allFailed = analyzerCount > 0 && successCount === 0;
    let failureBody: string | null = null;

    if (allFailed && childItemIds.length === 0) {
      const sentinelPath = join(deps.automationDir, "data", `.failed-${date}`);
      try {
        await writeFile(sentinelPath, `${deps.displayName} failed on ${date}\n`, "utf-8");
      } catch (err) {
        deps.log?.warn(`${stage.name}: could not write failure sentinel ${sentinelPath}`, {
          stage: stage.name, error: errorMessage(err),
        });
      }
      failureBody = await deps.prManager
        .loadTemplate(deps.templatesDir, deps.prFailedTemplate, {
          DATE: date,
          FAILURE_REASON: "All analyzers failed. Review logs.",
        })
        .catch(() => `All analyzers failed on ${date}. Review logs.`);
      deps.log?.warn(`${stage.name}: all ${analyzerCount} analyzers failed for ${date}`, {
        stage: stage.name, date, analyzerCount,
      });
    }

    // Rejection-handler sub-flow (kept inline pending F10-8 absorption).
    const rejectionDeps: RejectionHandlerDeps = {
      vcs: deps.vcs, tracker: deps.tracker, state: deps.state,
      agentRuntime: deps.agentRuntime,
      kindRegistry: deps.kindRegistry,
      conventions: deps.conventions, agentsConfig: deps.agentsConfig,
      promptSource: deps.promptSource,
      automationDir: deps.automationDir,
      findingsDir: deps.childDataDir,
      tasksDir: deps.siblingsDataDir,
      templatesDir: deps.templatesDir,
      workspacePath: deps.workspacePath,
      stateVars: deps.stateVars, log: deps.log,
    };
    const rejectionResult = await runRejectionHandler(rejectionDeps, ctx);
    deps.log?.info(`${stage.name}: rejection pass processed ${rejectionResult.processed} item(s) (reopened=${rejectionResult.reopened}, rejected=${rejectionResult.rejected}, duplicated=${rejectionResult.duplicated})`, {
      stage: stage.name, ...rejectionResult,
    });

    discoveryIterationScratch.set(ctx, date, {
      date, analyzerCount, childItemIds,
      successCount, allFailed, failureBody,
    });
  };
}

export function buildDiscoveryIterationSynthesizeAgentResult(_deps: DiscoveryIterationHookDeps) {
  return async (
    stage: StageDef,
    input: StageInput,
    _workspace: WorkspaceHandle,
    ctx: OperationContext,
  ): Promise<AgentResult> => {
    const payload = payloadOf(stage.name, input);
    const scratch = discoveryIterationScratch.get(ctx, payload.date);
    if (!scratch) {
      throw new StageLogicError(
        "STAGE_SCRATCH_MISSING",
        `${stage.name} synthesize: missing scratch for ${payload.date} — beforeAgent not run`,
      );
    }
    const verdict: Verdict = scratch.allFailed ? "failed" : "approved";
    const summary = scratch.allFailed
      ? `all ${scratch.analyzerCount} analyzers failed`
      : `${scratch.childItemIds.length} finding(s) from ${scratch.analyzerCount} analyzer(s)`;
    return { verdict, output: "", attempts: 1, summary };
  };
}

export function buildDiscoveryIterationBuildPR(deps: DiscoveryIterationHookDeps) {
  return async (
    stage: StageDef,
    input: StageInput,
    ctx: OperationContext,
  ): Promise<{ title: string; body: string; commitMessage: string; onSuccess?: "in-review" | "ready-to-merge" | "none" }> => {
    const payload = payloadOf(stage.name, input);
    const scratch = discoveryIterationScratch.get(ctx, payload.date);
    if (!scratch) {
      throw new StageLogicError(
        "STAGE_SCRATCH_MISSING",
        `${stage.name} buildPR: missing scratch for ${payload.date} — beforeAgent not run`,
      );
    }

    try {
      if (scratch.allFailed) {
        const body = scratch.failureBody
          ?? (await deps.prManager
            .loadTemplate(deps.templatesDir, deps.prFailedTemplate, {
              DATE: payload.date,
              FAILURE_REASON: "All analyzers failed. Review logs.",
            })
            .catch(() => `All analyzers failed on ${payload.date}. Review logs.`));
        return {
          title: `${deps.prPrefix} ${payload.date}: failed`,
          body,
          commitMessage: `Daily ${deps.displayName} ${payload.date}: all analyzers failed`,
        };
      }

      const findingList = scratch.childItemIds.length > 0
        ? scratch.childItemIds.map((id) => `- **${id}**`).join("\n")
        : "No new findings.";
      const body = await deps.prManager
        .loadTemplate(deps.templatesDir, deps.prTemplate, {
          DATE: payload.date,
          ANALYZER_COUNT: String(scratch.analyzerCount),
          FINDING_COUNT: String(scratch.childItemIds.length),
          FINDING_LIST: findingList,
        })
        .catch(() => `## ${deps.displayName} ${payload.date}\n\n${findingList}`);
      return {
        title: `${deps.prPrefix} ${payload.date}: ${scratch.childItemIds.length} findings`,
        body,
        commitMessage: `Daily ${deps.displayName} ${payload.date}, ${scratch.childItemIds.length} findings`,
        onSuccess: "in-review",
      };
    } finally {
      discoveryIterationScratch.clear(ctx, payload.date);
    }
  };
}

export function buildDiscoveryIterationAfterAgent(_deps: DiscoveryIterationHookDeps) {
  return async (
    _stage: StageDef,
    _input: StageInput,
    _agentResult: AgentResult,
    _workspace: WorkspaceHandle,
    _ctx: OperationContext,
  ): Promise<{ verdictOverride?: Verdict; summaryOverride?: string } | void> => {
    // No-op: synthesizeAgentResult already produced the final verdict.
  };
}
