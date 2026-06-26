import type { OperationContext, EventBus, VCSPlatform, IdempotencyGuard, StateManager, ConventionsConfig, WorkItem, KVStore } from "@operator/core";
import type { AgentRunInput } from "../agents/runtime.js";
import type { WorkspaceGit } from "../infra/git.js";
import type { PRManager } from "../delivery/pr-manager.js";
import type { Logger } from "../logging/logger.js";
import { FileWorkspaceScope } from "./primitives/workspace-scope.js";
import { FileOutputAdapter } from "./primitives/persist-output.js";
import { ItemSelectorRegistry } from "./primitives/item-selector.js";
import { FileAgentInvocation } from "./primitives/agent-invocation.js";
import { FileVerdictRouter, emitSkipped } from "./primitives/route-verdict.js";
import type { AgentInvocation } from "./primitives/agent-invocation.js";
import type { VerdictRouter } from "./primitives/route-verdict.js";
import type { AgentRuntime } from "../agents/runtime.js";
import type { StageDef, StageInput, StageRunResult, Verdict, AgentResult } from "./types.js";
import type { WorkspaceHandle } from "./primitives/workspace-scope.js";
import {
  ExecutionHistoryWriter, newExecutionId, appendRecentExecutionId,
  appendChildExecutionId, noopExecutionHistory, type ExecutionHistory,
} from "./primitives/execution-history.js";
import { executionScore } from "./primitives/success-score.js";

/**
 * The generic 8-step stage loop (`docs/architecture-v5.md §3`).
 *
 * This file composes primitives; no stage-specific logic lives here. The loop
 * is capped at ~150 lines — if it grows, a primitive is leaking out.
 *
 * Step 8b scope: init stage only (via `bootstrap` selector). Other stages
 * migrate in Steps 9–12; they add selector strategies + stage defs without
 * touching this file.
 */

const DEFAULT_LOCK_TTL_MS = 600_000;

export interface RunStageDeps {
  readonly guard: IdempotencyGuard;
  readonly workspace: FileWorkspaceScope;
  readonly persistOutput: FileOutputAdapter;
  readonly selectors: ItemSelectorRegistry;
  readonly agentInvocation: AgentInvocation;
  readonly verdictRouter: VerdictRouter;
  readonly bus: Pick<EventBus, "emit">;
  readonly vcs: VCSPlatform;
  readonly prManager: PRManager;
  readonly agentRuntime: AgentRuntime;
  readonly git: WorkspaceGit;
  readonly workspacePath: string;
  readonly log?: Logger;
  /** StateManager for per-item selector queries. Optional — omit for bootstrap-only stages. */
  readonly state?: StateManager;
  /** Conventions — used by per-item selector for branch-prefix capacity check. */
  readonly conventions?: ConventionsConfig;
  /**
   * KV store for execution-history writes (Step 14). When provided, runStage
   * emits `executions/{id}` + `execution-events/{id}/{seq}` + `execution-logs/{id}`
   * rows; when omitted, execution history is a no-op (unit tests omit for brevity).
   */
  readonly kv?: KVStore;
  /**
   * Cycle execution id this stage runs under. Recorded on the stage's
   * own execution row so the App UI can render the parent → child
   * tree. The composition root creates the cycle row and threads its
   * id here.
   */
  readonly parentExecutionId?: string;
  /** Optional per-stage filter for per-item selector (task-execute uses it for conflict/deps). */
  readonly perItemFilter?: (item: WorkItem, ctx: OperationContext) => Promise<boolean>;
  /**
   * Per-stage AgentRunInput builder. Supplied by the composition root so this
   * file stays agnostic about role resolution + prompt assembly. In Step 8b
   * there is only one entry (init→scout); later steps extend the map.
   */
  readonly buildRunInput: (stageDef: StageDef, input: StageInput, ctx: OperationContext) => Promise<AgentRunInput>;
  /**
   * Optional pre-agent hook (init uses it to scaffold .operator/ dirs).
   *
   * Return value is used by the label-safety-net in runStage's `finally`
   * block:
   *
   * - `processingPRs` — list of PR numbers the hook has transitioned to
   *   `ai:processing`. If the stage throws between this point and a
   *   successful `persistOutput` finalization, runStage guarantees these
   *   PRs flip to `ai:failed` via `prManager.markFailed` (best-effort +
   *   WARN) so no PR is ever left stuck in `ai:processing`. This is the
   *   structural cure for the 2026-04-20 PR #754/#779 incidents — a
   *   stage that marks processing MUST finish the transition, and
   *   runStage enforces it.
   *
   * Hooks that do not touch labels omit this field (or return nothing).
   */
  readonly beforeAgent?: (
    stageDef: StageDef,
    input: StageInput,
    workspace: WorkspaceHandle,
    ctx: OperationContext,
  ) => Promise<{ processingPRs?: readonly number[] } | void>;
  /**
   * Optional post-agent hook — runs AFTER invokeAgent but BEFORE persistOutput.
   * Used by finding-plan / task-execute to parse agent output, create child
   * work items, validate HEAD-read-only contracts, write failure_reason to
   * frontmatter, and compute a verdict override. Runs inside the same
   * workspace the agent just left.
   *
   * Return value lets the hook reshape the agent result before persist:
   * - `verdictOverride`: flip verdict (e.g. "approved" → "rejected" when a
   *   VALID verdict came with no task blocks — finding-plan contract check).
   * - `summaryOverride`: replace the agent summary with a hook-computed one
   *   (e.g. "2 tasks created: T-0001, T-0002" for finding-plan success).
   */
  readonly afterAgent?: (
    stageDef: StageDef,
    input: StageInput,
    agentResult: AgentResult,
    workspace: WorkspaceHandle,
    ctx: OperationContext,
  ) => Promise<{ verdictOverride?: Verdict; summaryOverride?: string } | void>;
  /**
   * Builds the PR title+body for persist-output. Stage-specific. Receives
   * {@link OperationContext} so stages that keep per-invocation scratch
   * state (research's analyzer results) can look it up by traceId.
   */
  readonly buildPR: (stageDef: StageDef, input: StageInput, ctx: OperationContext) => Promise<{
    title: string;
    body: string;
    commitMessage: string;
    /**
     * Label-transition hint on approved verdict.
     * - `"in-review"` flips to `ai:in-review` (applied changes, review
     *   cycle open — research / finding-plan / task-execute success).
     * - `"ready-to-merge"` flips to `ai:ready-to-merge` (verified, human
     *   merge pending — pr-review clean-workspace success path).
     * - `"none"` (default) leaves the PR as-created.
     */
    onSuccess?: "in-review" | "ready-to-merge" | "none";
  }>;
  /**
   * Optional hook that synthesizes an {@link AgentResult} WITHOUT invoking the
   * `AgentRuntime`. Used by stages whose agent work happens across multiple
   * sub-runs orchestrated inside `beforeAgent` (research's per-analyzer loop —
   * Step 11). When present, runStage skips steps 4-5 (buildRunInput +
   * invokeAgent) entirely and takes the synthesized result as the agent
   * outcome for the `afterAgent` + `persistOutput` phases.
   *
   * Set via `synthesizeAgentResult`; `buildRunInput` is ignored when it is
   * provided. Single-input stages (init, pr-review, finding-plan, task-execute)
   * continue to leave this undefined and use the normal agent-invocation path.
   */
  readonly synthesizeAgentResult?: (
    stageDef: StageDef,
    input: StageInput,
    workspace: WorkspaceHandle,
    ctx: OperationContext,
    // Returning `null` falls through to normal agent invocation —
    // useful for stages that opt-in conditionally (e.g. finding-plan
    // skipping the planner when child tasks already exist).
  ) => Promise<AgentResult | null>;
}

export async function runStage(
  stageDef: StageDef,
  deps: RunStageDeps,
  ctx: OperationContext,
): Promise<StageRunResult> {
  const startedAt = Date.now();
  const startedAtIso = new Date(startedAt).toISOString();
  // v5 logging audit §14 — stage entry trace is mandatory.
  deps.log?.info(`Stage ${stageDef.name} → started`, {
    stage: stageDef.name,
    agent: stageDef.agent,
    selector: stageDef.selector,
    branchScope: stageDef.branchScope,
  });

  // Allocate the execution-history writer early so lock/selector skips also
  // produce a row. Null-object pattern — no conditional guards downstream.
  const history: ExecutionHistory = deps.kv
    ? new ExecutionHistoryWriter(newExecutionId(stageDef.name, ctx), deps.kv)
    : noopExecutionHistory;
  // Surface the execution id on every subsequent stage log so app/UI
  // and grep workflows can cross-reference KV rows without manual
  // lookup. The id is opaque to humans but invaluable to tooling.
  if (history.executionId) {
    deps.log?.info(`Stage ${stageDef.name}: executionId=${history.executionId}`, {
      stage: stageDef.name, executionId: history.executionId, traceId: ctx.traceId,
    });
  }

  // 1. acquireLock
  const lockKey = `stage:${stageDef.name}:${ctx.repoId}`;
  const lock = await deps.guard.acquire(lockKey, DEFAULT_LOCK_TTL_MS, ctx);
  if (!lock) {
    // v5 logging audit §14 — skip-with-reason is a DECISION; INFO required.
    deps.log?.info(`Stage ${stageDef.name} ← skipped: locked by concurrent run`, {
      stage: stageDef.name, reason: "locked", durationMs: Date.now() - startedAt,
    });
    await emitSkipped(stageDef, "locked", { bus: deps.bus }, ctx);
    await history.start({
      traceId: ctx.traceId, repoId: ctx.repoId, stageName: stageDef.name,
      agent: stageDef.agent, startedAt: startedAtIso,
      parentExecutionId: deps.parentExecutionId,
    }, ctx);
    if (deps.parentExecutionId && deps.kv) {
      await appendChildExecutionId(deps.kv, deps.parentExecutionId, history.executionId);
    }
    await history.finalize({
      finishedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
      // Skipped runs are non-events for the success-rate signal — neither
      // a positive (no work was actually done) nor a failure (nothing
      // went wrong). Score stays `null` ("pending / not graded") so the
      // statistic is not biased by frequent stage skips.
      status: "completed", summary: "skipped: locked", successScore: null,
    }, ctx);
    return { status: "skipped", reason: "locked" };
  }

  // Label safety-net — set from beforeAgent's return. If the stage throws
  // between markProcessing and a successful persistOutput finalization,
  // the `finally` block guarantees these PRs flip to `ai:failed`
  // (best-effort + WARN). No PR is ever left stuck on `ai:processing`.
  let processingPRs: readonly number[] = [];
  let finalized = false;

  try {
    // 2. selectInput
    const input = await deps.selectors.select(
      stageDef,
      {
        vcs: deps.vcs, workspacePath: deps.workspacePath, log: deps.log,
        state: deps.state, conventions: deps.conventions,
        perItemFilter: deps.perItemFilter,
      },
      ctx,
    );
    if (!input) {
      deps.log?.info(`Stage ${stageDef.name} ← skipped: no input`, {
        stage: stageDef.name, reason: "no-input", durationMs: Date.now() - startedAt,
      });
      await emitSkipped(stageDef, "no-input", { bus: deps.bus }, ctx);
      await history.start({
        traceId: ctx.traceId, repoId: ctx.repoId, stageName: stageDef.name,
        agent: stageDef.agent, startedAt: startedAtIso,
        parentExecutionId: deps.parentExecutionId,
      }, ctx);
      if (deps.parentExecutionId && deps.kv) {
        await appendChildExecutionId(deps.kv, deps.parentExecutionId, history.executionId);
      }
      await history.finalize({
        finishedAt: new Date().toISOString(),
        durationMs: Date.now() - startedAt,
        // See note at the locked-skip path above — a skipped run is not a
        // success or failure data point.
        status: "completed", summary: "skipped: no input", successScore: null,
      }, ctx);
      return { status: "skipped", reason: "no-input" };
    }
    const workItemId = extractWorkItemId(input);
    await history.start({
      traceId: ctx.traceId, repoId: ctx.repoId, stageName: stageDef.name,
      agent: stageDef.agent, scopeKey: input.scopeKey, workItemId,
      startedAt: startedAtIso,
      parentExecutionId: deps.parentExecutionId,
    }, ctx);
    await history.event("input.selected", `picked ${input.scopeKey}`, {
      scopeKey: input.scopeKey, reason: input.reason, workItemId,
    }, ctx);
    if (workItemId && deps.kv) {
      await appendRecentExecutionId(deps.kv, workItemId, history.executionId);
    }
    if (deps.parentExecutionId && deps.kv) {
      await appendChildExecutionId(deps.kv, deps.parentExecutionId, history.executionId);
    }
    deps.log?.info(`Stage ${stageDef.name}: input selected`, {
      stage: stageDef.name, scopeKey: input.scopeKey, reason: input.reason,
    });

    // 3. initWorkspace
    const branch = composeBranch(stageDef, input);
    const workspace = await deps.workspace.prepare(
      { branch, baseBranch: stageDef.baseBranch },
      deps.git,
      ctx,
      deps.log,
    );
    deps.log?.info(`Stage ${stageDef.name}: workspace ready`, {
      stage: stageDef.name, branch: workspace.branch, baseBranch: workspace.baseBranch,
      existedRemote: workspace.existedRemote,
    });
    await history.event("workspace.prepared", `branch=${workspace.branch}`, {
      branch: workspace.branch, baseBranch: workspace.baseBranch,
      existedRemote: workspace.existedRemote,
    }, ctx);

    // Capture HEAD after checkout, before the agent runs. persist uses this to
    // detect an agent that commits its fix directly (clean tree, advanced
    // HEAD) and forward that commit to origin instead of letting the
    // finally-block resetToBase discard it. Best-effort — an empty string
    // makes persist fall back to the dirty-tree-only path.
    let preAgentHeadSha = "";
    try {
      preAgentHeadSha = (await deps.git.headSha()).trim();
    } catch (err) {
      deps.log?.warn(`Stage ${stageDef.name}: failed to capture pre-agent HEAD SHA (non-fatal)`, {
        stage: stageDef.name, error: err instanceof Error ? err.message : String(err),
      });
    }

    // 4-5. beforeAgent hook + prompt construction (stage-specific, injected).
    // If the hook returns `processingPRs`, the finally block below guarantees
    // label recovery when the stage does not reach a successful persist.
    if (deps.beforeAgent) {
      deps.log?.debug(`Stage ${stageDef.name}: running beforeAgent hook`, { stage: stageDef.name });
      const hookResult = await deps.beforeAgent(stageDef, input, workspace, ctx);
      if (hookResult?.processingPRs && hookResult.processingPRs.length > 0) {
        processingPRs = hookResult.processingPRs;
      }
    }

    // 6. invokeAgent (verdict + summary out) — OR synthesize the result when
    // the stage drives its agent work itself (research's per-analyzer loop).
    let agentResult: AgentResult;
    const synthesized = deps.synthesizeAgentResult
      ? await deps.synthesizeAgentResult(stageDef, input, workspace, ctx)
      : null;
    if (synthesized) {
      deps.log?.debug(`Stage ${stageDef.name}: synthesizeAgentResult path (agent invocation bypassed)`, {
        stage: stageDef.name,
      });
      agentResult = synthesized;
      deps.log?.info(`Stage ${stageDef.name}: synthesized verdict=${agentResult.verdict}`, {
        stage: stageDef.name, verdict: agentResult.verdict,
        attempts: agentResult.attempts, summary: agentResult.summary.slice(0, 200),
      });
    } else {
      const runInput = await deps.buildRunInput(stageDef, input, ctx);
      await history.event("agent.spawned", `${stageDef.agent} invoked`, {
        agent: stageDef.agent, maxRetries: runInput.maxRetries,
      }, ctx);
      // Inject the execution-history sink so AgentRuntime can emit
      // per-attempt structured events (full prompts, full stdout,
      // verify stderr, verifier feedback) into KV.
      const runInputWithHistory = { ...runInput, history };
      agentResult = await deps.agentInvocation.invoke(
        stageDef, input, runInputWithHistory,
        { agentRuntime: deps.agentRuntime, log: deps.log },
        ctx,
      );
      deps.log?.info(`Stage ${stageDef.name}: agent ${stageDef.agent} returned verdict=${agentResult.verdict}`, {
        stage: stageDef.name, agent: stageDef.agent,
        verdict: agentResult.verdict, attempts: agentResult.attempts,
        summary: agentResult.summary.slice(0, 200),
      });
    }
    await history.event("agent.output", `verdict=${agentResult.verdict}`, {
      verdict: agentResult.verdict, attempts: agentResult.attempts,
      summaryChars: agentResult.summary.length,
      summary: agentResult.summary.slice(0, 500),
    }, ctx);

    // 6b. afterAgent hook — stage-specific output processing (parse verdict,
    // create child work items, validate read-only contracts, etc.). May flip
    // the agent's verdict (e.g. finding-plan approves only on VALID+tasks).
    if (deps.afterAgent) {
      deps.log?.debug(`Stage ${stageDef.name}: running afterAgent hook`, { stage: stageDef.name });
      const override = await deps.afterAgent(stageDef, input, agentResult, workspace, ctx);
      if (override?.verdictOverride && override.verdictOverride !== agentResult.verdict) {
        deps.log?.info(`Stage ${stageDef.name}: afterAgent overrode verdict ${agentResult.verdict} → ${override.verdictOverride}`, {
          stage: stageDef.name, originalVerdict: agentResult.verdict, newVerdict: override.verdictOverride,
        });
        agentResult = {
          ...agentResult,
          verdict: override.verdictOverride,
          summary: override.summaryOverride ?? agentResult.summary,
        };
      } else if (override?.summaryOverride && override.summaryOverride !== agentResult.summary) {
        agentResult = { ...agentResult, summary: override.summaryOverride };
      }
    }

    // 7. persistOutput — frozen signature (architecture-v5.md §3.1.1).
    // The adapter decides label transitions from agentResult.verdict +
    // stagePersistInput.onSuccess; runStage only supplies the stage artefacts.
    const pr = await deps.buildPR(stageDef, input, ctx);
    const draft = agentResult.verdict !== "approved";
    const onSuccess = pr.onSuccess ?? "none";
    const persistResult = await deps.persistOutput.persist(
      stageDef, input, agentResult, workspace,
      {
        commitMessage: pr.commitMessage,
        pr: { title: pr.title, body: pr.body, draft },
        onSuccess,
        itemId: workItemId,
        itemPath: extractItemPath(input),
        preAgentHeadSha,
      },
      { git: deps.git, prManager: deps.prManager, vcs: deps.vcs, log: deps.log,
        kv: deps.kv, workspacePath: deps.workspacePath },
      ctx,
    );

    await history.event("persist.result", `committed=${persistResult.committed}`, {
      committed: persistResult.committed, sha: persistResult.sha,
      prNumber: persistResult.prNumber, prExisted: persistResult.prExisted,
    }, ctx);

    // Persist completed — its `applyLabelTransition` already drove the
    // final ai:processing → ai:in-review / ai:ready-to-merge / ai:failed
    // transition for us. Mark the stage finalized so the safety-net in
    // `finally` is a no-op.
    finalized = true;

    // 8. routeVerdict (events; labels stay with persist-output until Step 13).
    await deps.verdictRouter.route(
      {
        stageDef, stageInput: input, agentResult, persistResult,
        workItemId, executionId: history.executionId,
      },
      { bus: deps.bus, kv: deps.kv },
      ctx,
    );

    // Execution status mapping:
    //   - approved → completed (work produced, agent succeeded)
    //   - rejected → completed (agent correctly filtered a false positive;
    //                from the orchestration view the stage ran cleanly and
    //                produced a valid terminal outcome — NOT a failure)
    //   - failed   → failed (real orchestration error)
    //   - cancelled → failed (user-aborted; terminal-without-success)
    const finalStatus: StageRunResult["status"] =
      agentResult.verdict === "approved" || agentResult.verdict === "rejected"
        ? "completed"
        : "failed";
    const durationMs = Date.now() - startedAt;
    if (finalStatus === "completed") {
      deps.log?.info(`Stage ${stageDef.name} ← completed`, {
        stage: stageDef.name, verdict: agentResult.verdict,
        prNumber: persistResult.prNumber, branch: workspace.branch,
        sha: persistResult.sha, committed: persistResult.committed, durationMs,
      });
    } else {
      deps.log?.warn(`Stage ${stageDef.name} ← failed: ${agentResult.summary.slice(0, 200)}`, {
        stage: stageDef.name, verdict: agentResult.verdict,
        prNumber: persistResult.prNumber, branch: workspace.branch,
        summary: agentResult.summary, durationMs,
      });
    }

    // Success-rate metric:
    //   - approved + PR created → undefined (pending: outcome decided once
    //     the PR is merged, closed, or rejected; backfilled by
    //     `reconcileAndWrite` on the cycle that observes the terminal
    //     transition).
    //   - approved + no PR → 1 (non-PR stage success, e.g. init self-skip
    //     or research that produced no findings — terminal at finalize
    //     time, nothing to wait for).
    //   - rejected → 1 (terminal SUCCESS for the agent — caught a false
    //     positive; rejection is the right answer). PR may be open as
    //     a data-sync vehicle but the agent's work is done.
    //   - failed / cancelled → graded by `executionScore` (now continuous —
    //     1 on a clean one-shot, 0.7 with one internal agent retry, 0.49
    //     with two, floored at SCORE_FLOOR for deeper chains).
    //
    // PR-emitting approved executions still publish `undefined` (pending)
    // because the terminal lifecycle outcome (merged vs closed-without-
    // merge) is decided later by the reconciler — `reconcileAndWrite`
    // backfills these once the PR resolves so per-execution rows reflect
    // the real terminal score.
    const verdictApproved = agentResult.verdict === "approved";
    const successScore = verdictApproved && persistResult.prNumber
      ? undefined
      : executionScore({ verdict: agentResult.verdict, attempts: agentResult.attempts });
    await history.event(
      finalStatus === "completed" ? "stage.completed" : "stage.failed",
      `verdict=${agentResult.verdict} successScore=${successScore ?? "pending"}`,
      { verdict: agentResult.verdict, prNumber: persistResult.prNumber, successScore },
      ctx,
    );
    await history.finalize({
      finishedAt: new Date().toISOString(),
      durationMs, status: finalStatus, verdict: agentResult.verdict,
      summary: agentResult.summary.slice(0, 1000),
      prNumber: persistResult.prNumber ?? undefined,
      attempts: agentResult.attempts,
      successScore,
    }, ctx);

    return {
      status: finalStatus,
      verdict: agentResult.verdict,
      prNumber: persistResult.prNumber ?? undefined,
      branch: workspace.branch,
    };
  } catch (err) {
    // Execution history captures errors too so the UI shows the real cause,
    // not just "it crashed".
    try {
      await history.finalize({
        finishedAt: new Date().toISOString(),
        durationMs: Date.now() - startedAt,
        status: "failed", error: err instanceof Error ? err.message : String(err),
        successScore: 0,
      }, ctx);
    } catch {
      // Best-effort; swallow secondary KV failures so the original error
      // keeps propagating.
    }
    throw err;
  } finally {
    // Label safety-net — if beforeAgent moved any PR to ai:processing and we
    // did NOT reach a successful persist (exception mid-flight, or persist
    // itself threw), force the PR back to ai:failed so it never sits in
    // ai:processing indefinitely. Closes the 2026-04-20 stuck-label
    // failure mode structurally: a stage cannot touch ai:processing
    // without guaranteeing the terminal transition.
    if (!finalized && processingPRs.length > 0) {
      for (const prId of processingPRs) {
        try {
          await deps.prManager.markFailed(prId);
          deps.log?.warn(
            `Stage ${stageDef.name}: safety-net flipped PR #${prId} ai:processing → ai:failed (stage did not finalize)`,
            { stage: stageDef.name, prNumber: prId, reason: "safety-net" },
          );
        } catch (err) {
          deps.log?.error(
            `Stage ${stageDef.name}: safety-net markFailed for PR #${prId} failed — PR may remain ai:processing until next cycle`,
            {
              stage: stageDef.name, prNumber: prId,
              error: err instanceof Error ? err.message : String(err),
            },
          );
        }
      }
    }
    await deps.guard.release(lock, ctx);
    await deps.git.resetToBase(stageDef.baseBranch).catch((err) => {
      // v5 logging audit §14 — never swallow silently. finally-block errors
      // are best-effort cleanup, so WARN (not ERROR) so they don't shadow
      // the real exception from the try.
      deps.log?.warn(`Stage ${stageDef.name}: resetToBase failed (non-fatal)`, {
        stage: stageDef.name, baseBranch: stageDef.baseBranch,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }
}

/**
 * Pull the `workItemId` out of a selector's `StageInput.data` when present.
 * Per-item / pr-feedback selectors populate this; bootstrap / discovery /
 * singleton selectors omit it. Null when the stage has no per-item scope.
 */
function extractWorkItemId(input: StageInput): string | undefined {
  const data = input.data as { workItemId?: string; branch?: string } | undefined;
  if (typeof data?.workItemId === "string") return data.workItemId;
  // pr-review payload carries `branch` (e.g. `ai/findings/F20260416-0002`)
  // but no `workItemId` — the item id sits at the tail of the branch.
  // Lifting it here lets the executions row record `workItemId` so the
  // work-item detail page can show its review history.
  if (typeof data?.branch === "string") {
    const match = /^ai\/[^/]+\/(.+)$/.exec(data.branch);
    if (match) return match[1];
  }
  return undefined;
}

/**
 * Pull the item file path out of the selector input. Per-item selector
 * stores the loaded `WorkItem` — its `branch` may be used to reconstruct
 * the feature-branch file path later; today we rely on
 * `.operator/data/{kind}s/{id}.md` as a convention. Returns `undefined`
 * when no item is in flight.
 */
function extractItemPath(input: StageInput): string | undefined {
  const data = input.data as { workItem?: { id?: string; kind?: string } } | undefined;
  const item = data?.workItem;
  if (!item?.id || !item?.kind) return undefined;
  // MVP parity: every shipped kind (finding/task/request) follows
  // `.operator/data/{kind}s/{id}.md`. When kind registry adds richer paths
  // post-MVP, replace this with `registry.dataDirFor(kind)`.
  return `.operator/data/${item.kind}s/${item.id}.md`;
}

/**
 * Compose the branch name for a stage+input pair.
 *
 * - `singleton` branchScope → `branchPrefix` only (e.g. `ai/init`).
 * - `per-item` branchScope → `branchPrefix/scopeKey` (e.g. `ai/tasks/T-0001`).
 * - `pr` branchScope → the PR's existing branch, passed through via
 *   `input.data.branch`.
 */
function composeBranch(stageDef: StageDef, input: StageInput): string {
  if (stageDef.branchScope === "pr") {
    const data = input.data as { branch?: string } | undefined;
    if (!data?.branch) {
      throw new Error(`pr-scoped stage ${stageDef.name} requires input.data.branch`);
    }
    return data.branch;
  }
  if (!stageDef.branchPrefix) {
    throw new Error(`stage ${stageDef.name} requires branchPrefix`);
  }
  if (stageDef.branchScope === "singleton") {
    return stageDef.branchPrefix;
  }
  // per-item
  return `${stageDef.branchPrefix}/${input.scopeKey}`;
}

/** Re-export factories for convenience from the composition root. */
export { FileWorkspaceScope, FileOutputAdapter, FileAgentInvocation, FileVerdictRouter };
export { createDefaultSelectorRegistry } from "./primitives/item-selector.js";
