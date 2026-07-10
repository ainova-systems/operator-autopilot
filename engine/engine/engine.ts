import type { OperationContext } from "@operator/core";
import type { StateManager, IdempotencyGuard } from "@operator/core";
import type { ProjectConfig, OperatorConfig, KVStore } from "@operator/core";
import type { VCSPlatform } from "@operator/core";
import type { EventBus } from "@operator/core";
import type { StageDispatchRegistry } from "@operator/core";
import { ENGINE_STARTED, ENGINE_STOPPED, PROJECT_STARTED, PROJECT_COMPLETED } from "../events/types.js";
import { runProject } from "./project-runner.js";
import type { ActionName, ProjectRunnerDeps, ProjectRunResult, ActionResult } from "./project-runner.js";
import type { Logger } from "../logging/logger.js";
import {
  ExecutionHistoryWriter, newExecutionId, noopExecutionHistory,
  type ExecutionHistory,
} from "../pipeline/primitives/execution-history.js";

// ── Types ────────────────────────────────────────────────────────────

/**
 * TTL on the per-repo workspace lock. A repo pass runs every stage end to end
 * and a single agent stage can take tens of minutes, so this is deliberately
 * far longer than the stage lock's 10 minutes — the TTL is a backstop against
 * a holder that died, not a timeout on honest work. Boot calls
 * `IdempotencyGuard.clearActiveLocks`, so a killed daemon never blocks the next
 * one until natural expiry.
 */
const WORKSPACE_LOCK_TTL_MS = 6 * 60 * 60 * 1000;

/** Synthetic action reported when a repo is skipped because its workspace is busy. */
const WORKSPACE_LOCK_ACTION = "workspace-lock";

export interface EngineDeps {
  readonly config: OperatorConfig;
  readonly state: StateManager;
  readonly bus: EventBus;
  /**
   * Serialises every pass over a repo. Each repo owns exactly one git clone
   * (see {@link EngineDeps.resolveWorkspace}), so two concurrent passes would
   * fight over one working tree and one HEAD.
   *
   * `runStage` already locks `stage:{name}:{repoId}`, which is keyed on the
   * stage NAME — it stops a stage from running twice, but happily lets a
   * different stage of another cycle check out a branch in the same clone
   * mid-agent. That is exactly what corrupted managed-repo PR #1251 on
   * 2026-07-09. This lock is the missing mutex, and it is required rather than
   * optional: a caller that forgets it must not silently lose the invariant.
   */
  readonly guard: IdempotencyGuard;
  /** Create VCSPlatform for a project. */
  readonly createVCS: (project: ProjectConfig) => VCSPlatform;
  /** Resolve workspace path for a project. */
  readonly resolveWorkspace: (project: ProjectConfig) => string;
  /**
   * Prepare the workspace for a project — clone/fetch + checkout base branch,
   * or dirty-check when an override path is in effect. Called ONCE per project
   * per cycle before any stage runs. Throws on failure; the engine treats the
   * project as failed for this cycle and records a synthetic `workspace` action.
   *
   * Before Step 8a this lived inline at the top of every `executeAction` call
   * (so every stage re-cloned / re-fetched). The 2026-04-15 ordering bug
   * (`checkInitialized` ran before the workspace directory existed) motivated
   * hoisting it to cycle start.
   */
  readonly prepareWorkspace: (project: ProjectConfig, workspacePath: string, ctx: OperationContext) => Promise<void>;
  /**
   * Reconcile workspace files (`.operator/data/findings/*`, `.operator/data/tasks/*`)
   * into the state store. Called ONCE per project per cycle right after
   * `prepareWorkspace`, so every stage in the cycle reads a fully-reconciled
   * state. The sync contract (`docs/architecture-v5.md §6.3`) names this the
   * single reconciler and forbids it running inside stage code.
   */
  readonly syncWorkspace: (project: ProjectConfig, workspacePath: string, ctx: OperationContext) => Promise<void>;
  /** Execute a pipeline action for a project. */
  readonly executeAction: (action: ActionName, project: ProjectConfig, vcs: VCSPlatform, workspacePath: string, ctx: OperationContext) => Promise<ActionResult>;
  /**
   * Optional per-cycle repo enumerator. When provided, {@link Engine.runOnce}
   * calls it at cycle start and iterates the returned list instead of
   * `config.repos`. Used by entry.ts to source repos from KV so managed-repo
   * edits land on the next cycle without daemon restart.
   */
  readonly enumerateRepos?: (ctx: OperationContext) => Promise<readonly ProjectConfig[]>;
  /** Optional logger for cycle-level observability. */
  readonly log?: Logger;
  /**
   * Optional KV store. When supplied, every cycle materialises a parent
   * execution row under `executions/cycle-…` so the App UI can render
   * the full tree (cycle ▸ stages ▸ agent attempts). Stage rows in the
   * same cycle carry `parentExecutionId` pointing here. Without `kv`,
   * cycle observability falls back to log-only.
   */
  readonly kv?: KVStore;
  /**
   * Dispatch registry — source of normal order, feature gating, schedule
   * policy. Built once in the composition root and reused for every
   * project this cycle. Phase B Part 1 made this required by lifting the
   * stage-name knowledge out of the runner.
   */
  readonly dispatchRegistry: StageDispatchRegistry;
}

export interface EngineRunResult {
  readonly projects: ProjectRunResult[];
  readonly durationMs: number;
}

// ── Engine ───────────────────────────────────────────────────────────

/**
 * Main orchestrator engine.
 * Ports orchestrator.sh: iterate repos, dispatch to project-runner, collect results.
 */
export class Engine {
  constructor(private readonly deps: EngineDeps) {}

  /**
   * Run one cycle: process all (or filtered) repos.
   * Ports orchestrator.sh main loop.
   */
  async runOnce(
    ctx: OperationContext,
    options?: {
      repoFilter?: string;
      forceAction?: string;
      dryRun?: boolean;
    },
  ): Promise<EngineRunResult> {
    const startTime = Date.now();
    const startedAtIso = new Date(startTime).toISOString();
    this.deps.log?.info(`Cycle ▸ started`, {
      traceId: ctx.traceId,
      repoFilter: options?.repoFilter, forceAction: options?.forceAction, dryRun: options?.dryRun,
    });

    // Cycle materialises as its own execution row so the App UI can
    // render the parent → child tree. Stage rows under runStage point
    // back at this id via `parentExecutionId`.
    const cycleHistory: ExecutionHistory = this.deps.kv
      ? new ExecutionHistoryWriter(newExecutionId("cycle", ctx), this.deps.kv)
      : noopExecutionHistory;
    await cycleHistory.start({
      traceId: ctx.traceId, repoId: "*", stageName: "cycle",
      startedAt: startedAtIso,
      scopeKey: options?.repoFilter ?? options?.forceAction ?? undefined,
    }, ctx);

    await this.deps.bus.emit(ENGINE_STARTED, {
      traceId: ctx.traceId,
      projectId: "*",
      data: { repoFilter: options?.repoFilter, forceAction: options?.forceAction },
    });

    const results: ProjectRunResult[] = [];

    const repos = this.deps.enumerateRepos
      ? await this.deps.enumerateRepos(ctx)
      : this.deps.config.repos;
    this.deps.log?.info(`Cycle: enumerated ${repos.length} repo(s)`, {
      traceId: ctx.traceId, repoIds: repos.map((r) => r.id),
    });
    await cycleHistory.event("cycle.repos-enumerated", `${repos.length} repo(s)`, {
      level: "info",
      payload: { repoIds: repos.map((r) => r.id), forceAction: options?.forceAction },
    });

    for (const project of repos) {
      // Filter by repo ID if specified
      if (options?.repoFilter && project.id !== options.repoFilter) continue;

      if (ctx.signal.aborted) break;

      const projectResult = await this.processProject(
        project, ctx, options?.forceAction, options?.dryRun,
        cycleHistory.executionId,
      );
      results.push(projectResult);
    }

    const durationMs = Date.now() - startTime;
    const succeeded = results.filter((r) => r.actions.every((a) => a.status !== "failed")).length;
    const failed = results.filter((r) => r.actions.some((a) => a.status === "failed")).length;
    await this.deps.bus.emit(ENGINE_STOPPED, {
      traceId: ctx.traceId,
      projectId: "*",
      data: { projectCount: results.length, succeeded, failed },
    });
    await cycleHistory.finalize({
      finishedAt: new Date().toISOString(),
      durationMs,
      status: failed === 0 ? "completed" : "failed",
      summary: `${results.length} repo(s): ${succeeded} succeeded, ${failed} failed`,
      successScore: results.length === 0 ? undefined : succeeded / results.length,
    }, ctx);
    this.deps.log?.info(`Cycle ◂ done in ${durationMs}ms (succeeded=${succeeded}, failed=${failed}, repos=${results.length})`, {
      traceId: ctx.traceId, durationMs, succeeded, failed, repos: results.length,
    });

    return { projects: results, durationMs };
  }

  /**
   * Take the repo's workspace lock, then run the full pass. A repo whose
   * workspace is already held by another cycle is skipped for this cycle
   * rather than queued — the next cycle picks it up.
   */
  private async processProject(
    project: ProjectConfig,
    ctx: OperationContext,
    forceAction?: string,
    dryRun?: boolean,
    parentExecutionId?: string,
  ): Promise<ProjectRunResult> {
    const projectCtx: OperationContext = {
      ...ctx,
      repoId: project.id,
      action: forceAction || "poll",
      // Threaded through ctx so entry.ts handlers can pass it into
      // runStage without changing the ProjectRunnerDeps signature.
      parentExecutionId,
    };

    const lockKey = `workspace:${project.id}`;
    const lock = await this.deps.guard.acquire(lockKey, WORKSPACE_LOCK_TTL_MS, projectCtx);
    if (!lock) {
      // WARN, not INFO: reaching here means two cycles overlapped. The skip
      // itself is safe, but the overlap is the condition that produced the
      // 2026-07-09 cross-branch commit and should be visible without grepping.
      this.deps.log?.warn(`Project ${project.id} ← skipped: workspace locked by a concurrent cycle`, {
        traceId: ctx.traceId, repoId: project.id, lockKey, reason: "workspace-locked",
      });
      return {
        projectId: project.id,
        actions: [{
          action: WORKSPACE_LOCK_ACTION,
          status: "skipped",
          message: "Workspace locked by a concurrent cycle",
        }],
      };
    }

    try {
      return await this.runProjectPass(project, projectCtx, ctx, forceAction, dryRun, parentExecutionId);
    } finally {
      await this.deps.guard.release(lock, projectCtx);
    }
  }

  /** The repo pass proper. Runs under the workspace lock taken by {@link processProject}. */
  private async runProjectPass(
    project: ProjectConfig,
    projectCtx: OperationContext,
    ctx: OperationContext,
    forceAction?: string,
    dryRun?: boolean,
    parentExecutionId?: string,
  ): Promise<ProjectRunResult> {
    const projectStart = Date.now();
    this.deps.log?.info(`Project ${project.id} ▸ started`, {
      traceId: ctx.traceId, repoId: project.id, forceAction, dryRun,
    });

    await this.deps.bus.emit(PROJECT_STARTED, {
      traceId: ctx.traceId,
      projectId: project.id,
    });

    const vcs = this.deps.createVCS(project);
    const workspacePath = this.deps.resolveWorkspace(project);

    // Cycle-level workspace prep + file→state sync. The sync contract
    // names `syncWorkspace` the single reconciler, once per cycle.
    try {
      this.deps.log?.info(`Project ${project.id}: preparing workspace at ${workspacePath}`, {
        traceId: ctx.traceId, repoId: project.id, workspacePath,
      });
      const prepStart = Date.now();
      await this.deps.prepareWorkspace(project, workspacePath, projectCtx);
      this.deps.log?.info(`Project ${project.id}: workspace prepared in ${Date.now() - prepStart}ms`, {
        traceId: ctx.traceId, repoId: project.id, durationMs: Date.now() - prepStart,
      });
      const syncStart = Date.now();
      await this.deps.syncWorkspace(project, workspacePath, projectCtx);
      this.deps.log?.info(`Project ${project.id}: workspace synced in ${Date.now() - syncStart}ms`, {
        traceId: ctx.traceId, repoId: project.id, durationMs: Date.now() - syncStart,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const errorCode = err instanceof Error && "code" in err ? String((err as { code: unknown }).code) : undefined;
      this.deps.log?.error(`Project ${project.id} ✗ workspace prep failed: ${message}`, {
        traceId: ctx.traceId, repoId: project.id, errorCode, durationMs: Date.now() - projectStart,
      });
      // Surface the workspace-prep failure as a synthetic `executions/{id}`
      // row so the App UI shows every cycle outcome, not just the ones
      // that made it into a stage. Without this, a dirty-workspace abort
      // is invisible in `/executions` — the operator only sees the daemon
      // log line. The synthetic row points at the cycle parent so it
      // joins the cycle tree cleanly.
      if (this.deps.kv) {
        const prepHistory = new ExecutionHistoryWriter(
          newExecutionId("workspace-prep", projectCtx),
          this.deps.kv,
        );
        try {
          await prepHistory.start({
            traceId: ctx.traceId,
            repoId: project.id,
            stageName: "workspace-prep",
            startedAt: new Date(projectStart).toISOString(),
            parentExecutionId,
          }, projectCtx);
          await prepHistory.event("workspace-prep.failed", message, {
            level: "error",
            payload: { errorCode },
          });
          await prepHistory.finalize({
            finishedAt: new Date().toISOString(),
            durationMs: Date.now() - projectStart,
            status: "failed",
            error: message,
            successScore: 0,
            summary: `Workspace prep failed: ${message}`.slice(0, 1000),
          }, projectCtx);
        } catch {
          // Best-effort — never let an observability write failure mask
          // the original prep failure.
        }
      }
      const failResult: ProjectRunResult = {
        projectId: project.id,
        actions: [{ action: "branch-cleanup", status: "failed", message: `Workspace prep failed: ${message}` }],
      };
      await this.deps.bus.emit(PROJECT_COMPLETED, {
        traceId: ctx.traceId,
        projectId: project.id,
        data: {
          actionCount: failResult.actions.length,
          completed: 0,
          failed: 1,
          workspaceFailed: true,
        },
      });
      return failResult;
    }

    const runnerDeps: ProjectRunnerDeps = {
      state: this.deps.state,
      vcs,
      defaults: this.deps.config.defaults,
      conventions: this.deps.config.conventions,
      workspacePath,
      dispatchRegistry: this.deps.dispatchRegistry,
      executeAction: (action, actionCtx) =>
        this.deps.executeAction(action, project, vcs, workspacePath, actionCtx),
    };

    const result = await runProject(project, runnerDeps, projectCtx, forceAction, { skipScheduleCheck: dryRun });

    await this.deps.bus.emit(PROJECT_COMPLETED, {
      traceId: ctx.traceId,
      projectId: project.id,
      data: {
        actionCount: result.actions.length,
        completed: result.actions.filter((a) => a.status === "completed").length,
        failed: result.actions.filter((a) => a.status === "failed").length,
      },
    });
    this.deps.log?.info(`Project ${project.id} ◂ done in ${Date.now() - projectStart}ms`, {
      traceId: ctx.traceId, repoId: project.id, durationMs: Date.now() - projectStart,
      actionCount: result.actions.length,
      completed: result.actions.filter((a) => a.status === "completed").length,
      failed: result.actions.filter((a) => a.status === "failed").length,
      skipped: result.actions.filter((a) => a.status === "skipped").length,
    });

    return result;
  }
}

/**
 * Build a one-line summary of engine results (for workflow output).
 * Ports orchestrator.sh summary generation.
 */
export function buildSummary(result: EngineRunResult): string {
  const lines = result.projects.map((p) => {
    const failed = p.actions.filter((a) => a.status === "failed");
    const status = failed.length > 0 ? "FAILED" : "OK";
    const details = p.actions
      .filter((a) => a.status !== "skipped")
      .map((a) => `${a.action}:${a.status}`)
      .join(", ");
    return `- **${p.projectId}**: ${status}${details ? ` (${details})` : ""}`;
  });
  return `## Engine Run\n\n${lines.join("\n")}\n\nDuration: ${(result.durationMs / 1000).toFixed(1)}s`;
}
