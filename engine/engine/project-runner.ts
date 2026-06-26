import type { OperationContext } from "@operator/core";
import type { StateManager, WorkItemKind, WorkItemStatus } from "@operator/core";
import type { ProjectConfig, DefaultsConfig, ConventionsConfig } from "@operator/core";
import type { VCSPlatform } from "@operator/core";
import type {
  StageDispatchRegistry,
  StageDispatchEntry,
  ScheduleSpec,
} from "@operator/core";

/** Hard ceiling on the backoff exponent so `2 ** n` never overflows to Infinity. */
const MAX_BACKOFF_EXPONENT = 30;

// ── Types ────────────────────────────────────────────────────────────

/**
 * Open string alias. The set of known actions is supplied by the
 * `StageDispatchRegistry` at runtime; engine code never branches on
 * specific stage names. Pre-Phase-B the type was a closed union of
 * per-repo demo stage names — the rename to `string` is the type-level
 * half of the cron-dispatch genericisation.
 */
export type ActionName = string;

export interface ProjectRunnerDeps {
  readonly state: StateManager;
  readonly vcs: VCSPlatform;
  readonly defaults: DefaultsConfig;
  readonly conventions: ConventionsConfig;
  readonly workspacePath: string;
  /**
   * Registry of stages the engine knows about — ordering, feature gating,
   * schedule policy. Pre-Phase-B this was hardcoded inside the runner;
   * Phase B Part 1 lifts it into injected deps so the runner has zero
   * stage-name awareness. Part 2 will source the registry from KV.
   */
  readonly dispatchRegistry: StageDispatchRegistry;
  /** Execute a specific action. Caller provides the implementation. */
  readonly executeAction: (action: ActionName, ctx: OperationContext) => Promise<ActionResult>;
}

export interface ActionResult {
  readonly action: ActionName;
  readonly status: "completed" | "skipped" | "failed";
  readonly message?: string;
  /** ID captured for immediate execution (just-selected pattern). */
  readonly selectedId?: string;
}

export interface ProjectRunResult {
  readonly projectId: string;
  readonly actions: ActionResult[];
}

// ── Runner ───────────────────────────────────────────────────────────

/**
 * Run all applicable actions for a single project.
 *
 * Dispatch order, feature gating, and schedule policy all come from
 * `deps.dispatchRegistry`. No stage name is hardcoded in this file.
 */
export async function runProject(
  project: ProjectConfig,
  deps: ProjectRunnerDeps,
  ctx: OperationContext,
  forceAction?: string,
  options?: { skipScheduleCheck?: boolean },
): Promise<ProjectRunResult> {
  const results: ActionResult[] = [];

  // Forced action
  if (forceAction) {
    const chain = deps.dispatchRegistry.forceChain(forceAction);
    if (!chain) {
      return {
        projectId: project.id,
        actions: [{ action: forceAction, status: "failed", message: `Unknown action: ${forceAction}` }],
      };
    }

    for (const action of chain) {
      const result = await safeExecute(action, deps, ctx);
      results.push(result);
    }
    return { projectId: project.id, actions: results };
  }

  // Normal execution order — sourced from registry. The first entry in a
  // typical engine config is `init`, which self-skips cheaply when the
  // repo is already initialised. This replaces the pre-Step-8a
  // `checkInitialized` gate that skipped every other stage on
  // `initialized === false`, which caused the 2026-04-15 first-cycle
  // ordering bug (workspace not yet cloned when `fs.access` ran).
  for (const entry of deps.dispatchRegistry.normalOrder) {
    if (!entry.isEnabled(project.features)) continue;

    if (!options?.skipScheduleCheck && !await isScheduleDue(entry, project.id, deps, ctx)) continue;

    const result = await safeExecute(entry.action, deps, ctx);
    results.push(result);

    // `queue-fill` generators (research) advance their throttle on completion
    // AND on a skip — a run that found nothing eligible is still an "attempt"
    // and must not re-fire every cycle. The empty-run counter drives the
    // exponential backoff: a run that produced an output PR resets it, a run
    // that produced nothing bumps it (see `updateQueueFillBackoff`).
    if (entry.schedule.kind === "queue-fill") {
      if (result.status === "completed" || result.status === "skipped") {
        await markScheduleRun(entry, project.id, deps, ctx);
        await updateQueueFillBackoff(entry.schedule, project.id, result.status, deps, ctx);
      }
    } else if (result.status === "completed") {
      await markScheduleRun(entry, project.id, deps, ctx);
    }
  }

  return { projectId: project.id, actions: results };
}

/**
 * After a `queue-fill` run, reset or bump the consecutive-empty-run counter
 * that drives the exponential backoff. "Produced something" is detected by an
 * in-flight output PR existing now: a research run that found findings opens a
 * PR (`inFlightBranchPrefix`); a run that found nothing opens none. A skipped
 * run (no eligible analyzers) is always empty.
 */
async function updateQueueFillBackoff(
  schedule: Extract<ScheduleSpec, { kind: "queue-fill" }>,
  repoId: string,
  status: ActionResult["status"],
  deps: ProjectRunnerDeps,
  ctx: OperationContext,
): Promise<void> {
  const produced = status === "completed"
    && await hasInFlightOutput(schedule.inFlightBranchPrefix, deps);
  if (produced) {
    await deps.state.setCounter(ctx, repoId, schedule.backoffStateKey, 0);
    return;
  }
  const empty = await deps.state.getCounter(ctx, repoId, schedule.backoffStateKey);
  await deps.state.setCounter(
    ctx, repoId, schedule.backoffStateKey, Math.min(empty + 1, MAX_BACKOFF_EXPONENT),
  );
}

/**
 * True when an open (unmerged, unclosed) PR exists whose head branch starts
 * with `prefix` — i.e. the stage's own previous output still awaits human
 * merge. Used to keep `queue-fill` from piling up output PRs faster than they
 * are accepted.
 */
async function hasInFlightOutput(prefix: string, deps: ProjectRunnerDeps): Promise<boolean> {
  const reviews = await deps.vcs.getCodeReviews();
  return reviews.some(
    (pr) => !pr.closed && typeof pr.branch === "string" && pr.branch.startsWith(prefix),
  );
}

// ── Scheduling ───────────────────────────────────────────────────────

/**
 * Check if an action is due based on its schedule policy. Pure function
 * over the registry entry — no stage-name awareness.
 */
export async function isScheduleDue(
  entry: StageDispatchEntry,
  repoId: string,
  deps: ProjectRunnerDeps,
  ctx: OperationContext,
): Promise<boolean> {
  return evaluateSchedule(entry.schedule, repoId, deps, ctx);
}

async function evaluateSchedule(
  schedule: ScheduleSpec,
  repoId: string,
  deps: ProjectRunnerDeps,
  ctx: OperationContext,
): Promise<boolean> {
  switch (schedule.kind) {
    case "always":
      return true;
    case "interval":
      return deps.state.isScheduleDue(ctx, repoId, schedule.stateKey, schedule.intervalMinutes);
    case "daily": {
      const currentHour = new Date().getUTCHours();
      if (currentHour !== schedule.hourUtc) return false;
      return deps.state.isScheduleDue(ctx, repoId, schedule.stateKey, schedule.guardMinutes);
    }
    case "weekly": {
      const currentDow = new Date().getUTCDay() || 7; // 1=Mon..7=Sun
      if (currentDow !== schedule.dayOfWeek) return false;
      return deps.state.isScheduleDue(ctx, repoId, schedule.stateKey, schedule.guardMinutes);
    }
    case "queue-fill": {
      // 1. In-flight guard — a prior output PR still awaits human merge. Don't
      //    pile up another (findings enter the queue only once their research
      //    PR merges, so the backlog below won't reflect unmerged output).
      if (await hasInFlightOutput(schedule.inFlightBranchPrefix, deps)) return false;
      // 2. Exponential backoff throttle — base interval doubled per consecutive
      //    empty run, capped at maxBackoffMinutes (e.g. 7 days).
      const empty = await deps.state.getCounter(ctx, repoId, schedule.backoffStateKey);
      const intervalMinutes = Math.min(
        schedule.baseIntervalMinutes * 2 ** Math.min(empty, MAX_BACKOFF_EXPONENT),
        schedule.maxBackoffMinutes,
      );
      if (!await deps.state.isScheduleDue(ctx, repoId, schedule.stateKey, intervalMinutes)) {
        return false;
      }
      // 3. Queue depth — fire while the backlog is below target.
      const backlog = await deps.state.listWorkItems(ctx, {
        kind: schedule.targetKind as WorkItemKind,
        status: [...schedule.countStatuses] as WorkItemStatus[],
      });
      return backlog.length < schedule.target;
    }
  }
}

async function markScheduleRun(
  entry: StageDispatchEntry,
  repoId: string,
  deps: ProjectRunnerDeps,
  ctx: OperationContext,
): Promise<void> {
  if (entry.schedule.kind === "always") return;
  await deps.state.markScheduleRun(ctx, repoId, entry.schedule.stateKey);
}

// ── Safe execution ───────────────────────────────────────────────────

async function safeExecute(
  action: ActionName,
  deps: ProjectRunnerDeps,
  ctx: OperationContext,
): Promise<ActionResult> {
  try {
    return await deps.executeAction(action, ctx);
  } catch (err) {
    return { action, status: "failed", message: String(err) };
  }
}
