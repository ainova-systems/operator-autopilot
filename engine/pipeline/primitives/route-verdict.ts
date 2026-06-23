import type { OperationContext, EventBus, KVStore, StatusSources, WorkItemStatus } from "@operator/core";
import { reconcileEffectiveStatus, computeDrift } from "@operator/core";
import { STAGE_COMPLETED, STAGE_SKIPPED, PIPELINE_FAILED } from "../../events/types.js";
import type { Verdict, AgentResult, StageInput, StageDef } from "../types.js";
import type { PersistOutputResult } from "./persist-output.js";
import { observeExecutionVerdict } from "./observe-status.js";
import { stampWorkItem } from "../../work-items/work-items.js";

/**
 * Verdict-routing primitive — the 8th step of `runStage`.
 *
 * Step 8b scope: emit event-bus notifications keyed to the stage's final
 * verdict so downstream channels (GitHub comment, console log, future
 * Slack/Telegram) can react. Terminal failures always fire a notification;
 * successes emit a `stage.completed` for observability.
 *
 * Labels (`ai:in-review` / `ai:ready-to-merge` / `ai:failed`) are applied
 * inside `FileOutputAdapter.persist` via `applyLabelTransition`. Do not
 * add label-transition logic here — it would mean two code paths setting
 * labels.
 *
 * KV write of `executions/{id}` also lands in Step 13 — the execution
 * history schema is not defined yet and adding a write here without a
 * reader would be dead code.
 */

export interface RouteVerdictInput {
  readonly stageDef: StageDef;
  readonly stageInput: StageInput;
  readonly agentResult: AgentResult;
  readonly persistResult: PersistOutputResult | null;
  /**
   * Present when a work item drove this stage. `route-verdict` then writes
   * an `executionVerdict` observation back into
   * `kv:work-items/{workItemId}.statusSources` so drift detection has the
   * latest verdict signal.
   */
  readonly workItemId?: string;
  /** Execution id to reference in the observation record. */
  readonly executionId?: string;
}

export interface RouteVerdictDeps {
  readonly bus: Pick<EventBus, "emit">;
  /** KVStore for writing execution-verdict observations (Step 14). */
  readonly kv?: KVStore;
}

/** Contract for the verdict router. */
export interface VerdictRouter {
  route(input: RouteVerdictInput, deps: RouteVerdictDeps, ctx: OperationContext): Promise<void>;
}

/** Single implementation. */
export class FileVerdictRouter implements VerdictRouter {
  async route(
    input: RouteVerdictInput,
    deps: RouteVerdictDeps,
    ctx: OperationContext,
  ): Promise<void> {
    const { stageDef, stageInput, agentResult, persistResult } = input;

    const data = {
      stage: stageDef.name,
      scopeKey: stageInput.scopeKey,
      verdict: agentResult.verdict,
      attempts: agentResult.attempts,
      summary: agentResult.summary,
      prNumber: persistResult?.prNumber ?? null,
      committed: persistResult?.committed ?? false,
    };

    await this.observeAndReconcile(input, deps, ctx);

    if (isTerminalFailure(agentResult.verdict)) {
      await deps.bus.emit(PIPELINE_FAILED, {
        traceId: ctx.traceId,
        projectId: ctx.repoId,
        data,
      });
      return;
    }

    await deps.bus.emit(STAGE_COMPLETED, {
      traceId: ctx.traceId,
      projectId: ctx.repoId,
      data,
    });
  }

  /**
   * Record the execution-verdict observation and re-reconcile the work item
   * row. No-op when deps.kv or workItemId is absent (stages without a
   * per-item scope — research, improver, init — do not reconcile here).
   */
  private async observeAndReconcile(
    input: RouteVerdictInput,
    deps: RouteVerdictDeps,
    _ctx: OperationContext,
  ): Promise<void> {
    const { kv } = deps;
    const { workItemId, executionId, agentResult, stageDef } = input;
    if (!kv || !workItemId || !executionId) return;
    try {
      const obs = observeExecutionVerdict(executionId, agentResult.verdict, stageDef.name);
      const prior = await kv.get("work-items", workItemId);
      if (!prior) return;
      const priorValue = prior.value as Record<string, unknown>;
      const priorSources = (priorValue["statusSources"] ?? {}) as StatusSources;
      const mergedSources: StatusSources = { ...priorSources, executionVerdict: obs };
      const drift = computeDrift(mergedSources);
      // Post-inversion semantics + 2026-05-13 rename:
      //   `priorValue.status`             = computed status
      //   `priorValue.developFileStatus`  = raw develop-file literal
      // Feed the computed value as `currentKV.status` so the
      // terminal-sticky rule still sees "this was already completed".
      const reconciled = reconcileEffectiveStatus({
        sources: mergedSources,
        currentKV: {
          status: priorValue["status"] as WorkItemStatus | undefined,
          developFileStatus: priorValue["developFileStatus"] as WorkItemStatus | undefined,
        },
      });
      // Drop the legacy `effectiveStatusReason` + `effectiveStatus` keys
      // so stale rows migrate to the new shape on first write.
      const { effectiveStatusReason: _dropReason, effectiveStatus: _dropEff, ...rest } =
        priorValue as Record<string, unknown> & {
          effectiveStatusReason?: unknown;
          effectiveStatus?: unknown;
        };
      void _dropReason; void _dropEff;
      // Bounded-iteration counter — increment on every terminal-failure
      // verdict so the per-item selector can stop the work-item after the
      // configured cap. Approved verdicts leave the counter untouched.
      // Industry-standard "max iteration count" guardrail (Spotify LLM
      // Judge, LangGraph supervisor pattern).
      const priorAttemptCount = typeof priorValue["attemptCount"] === "number"
        ? priorValue["attemptCount"] as number
        : 0;
      const nextAttemptCount = isTerminalFailure(agentResult.verdict)
        ? priorAttemptCount + 1
        : priorAttemptCount;
      await kv.put(
        "work-items",
        workItemId,
        stampWorkItem(priorValue, {
          ...rest,
          status: reconciled.effectiveStatus,
          statusReason: reconciled.effectiveStatusReason,
          // `developFileStatus` (raw develop-file value) stays as-is from
          // the prior row via `...rest` — route-verdict never sees a fresh
          // develop-file read; only syncFilesToState refreshes that field.
          statusSources: mergedSources,
          isActive: drift.isActive,
          hasDrift: drift.hasDrift,
          driftDetails: drift.driftDetails.length > 0 ? drift.driftDetails : undefined,
          attemptCount: nextAttemptCount,
        }),
      );
    } catch {
      // Best-effort: observation write must not mask the real stage verdict.
    }
  }
}

/**
 * Emit a skip event for stages whose selector returned `null`. Called by
 * `runStage` before invoking any agent so `/executions` reports skips too.
 */
export async function emitSkipped(
  stageDef: StageDef,
  reason: string,
  deps: RouteVerdictDeps,
  ctx: OperationContext,
): Promise<void> {
  await deps.bus.emit(STAGE_SKIPPED, {
    traceId: ctx.traceId,
    projectId: ctx.repoId,
    data: { stage: stageDef.name, reason },
  });
}

/**
 * Two-bucket terminal classification:
 *   - failure   → `failed` (orchestration error) or `cancelled` (user aborted).
 *                 Emits PIPELINE_FAILED, increments attemptCount safety net.
 *   - non-failure → `approved` (work produced) or `rejected` (planner caught
 *                 a false positive). Emits STAGE_COMPLETED, attemptCount
 *                 untouched. `rejected` is a SUCCESSFUL agent outcome — the
 *                 planner correctly filtered an invalid finding before any
 *                 work was wasted. The PR-on-PR loop fix (2026-05-13) made
 *                 the selector skip terminal items reliably so attemptCount
 *                 doesn't need to fire as a safety net for rejected.
 */
function isTerminalFailure(verdict: Verdict): boolean {
  return verdict === "failed" || verdict === "cancelled";
}
