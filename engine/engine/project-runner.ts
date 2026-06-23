import type { OperationContext } from "@operator/core";
import type { StateManager } from "@operator/core";
import type { ProjectConfig, DefaultsConfig, ConventionsConfig } from "@operator/core";
import type { VCSPlatform } from "@operator/core";
import type {
  StageDispatchRegistry,
  StageDispatchEntry,
  ScheduleSpec,
} from "@operator/core";

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

    if (result.status === "completed") {
      await markScheduleRun(entry, project.id, deps, ctx);
    }
  }

  return { projectId: project.id, actions: results };
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
