import type { ProjectFeaturesConfig } from "../types/config.js";

/**
 * Schedule policy for a single dispatch entry — how the project-runner
 * decides whether the stage fires this cycle.
 *
 * - `always`     — fires every cycle (stage's own beforeAgent decides skip).
 * - `interval`   — fires when `intervalMinutes` have elapsed since the last
 *   `markScheduleRun` for `stateKey`.
 * - `daily`      — fires once per UTC day at `hourUtc`, gated by a guard
 *   window of `guardMinutes` since the last run.
 * - `weekly`     — fires once per ISO week on `dayOfWeek` (1=Mon..7=Sun),
 *   gated by `guardMinutes`.
 */
export type ScheduleSpec =
  | { readonly kind: "always" }
  | {
      readonly kind: "interval";
      readonly intervalMinutes: number;
      readonly stateKey: string;
    }
  | {
      readonly kind: "daily";
      readonly hourUtc: number;
      readonly guardMinutes: number;
      readonly stateKey: string;
    }
  | {
      readonly kind: "weekly";
      readonly dayOfWeek: number;
      readonly guardMinutes: number;
      readonly stateKey: string;
    };

/**
 * One stage's dispatch profile.
 *
 * The registry returns a flat list of these; project-runner reads them to
 * decide ordering, feature-gating, and scheduling without ever branching
 * on the stage name itself. Behaviour comes from data on the entry, not
 * from a switch statement.
 */
export interface StageDispatchEntry {
  /** Stage name as it appears in `kv:workflow-stages/*`. */
  readonly action: string;
  /** Position in normal execution order. Smaller fires first. */
  readonly order: number;
  /** Schedule policy. */
  readonly schedule: ScheduleSpec;
  /**
   * Resolve whether the project's `features` block grants this stage. The
   * mapping from feature flag(s) → stage is per-entry so legacy compound
   * checks (e.g. a per-repo `taskExecute && taskSelect`) stay co-located with
   * the entry that needs them. Implementations return `true` when no
   * gating applies.
   */
  isEnabled(features: ProjectFeaturesConfig | undefined): boolean;
}

/**
 * Stage dispatch registry — open-typed source of truth for what stages the
 * engine knows about, in what order they run, how they are gated, and how
 * they are scheduled.
 *
 * The composition root (`engine/entry.ts`) builds the concrete registry;
 * `project-runner.ts` consumes it as injected deps. The registry is the
 * mechanism by which the engine stops hardcoding stage names at the
 * dispatch layer — the next layer down (composing each stage's hooks) is
 * still per-stage in the composition root, which is appropriate.
 */
export interface StageDispatchRegistry {
  /** Stages in execution order. Smaller `order` fires first. */
  readonly normalOrder: readonly StageDispatchEntry[];
  /** Lookup by stage name. Returns `undefined` for unknown actions. */
  get(action: string): StageDispatchEntry | undefined;
  /**
   * Returns the chain of actions for `--force <name>`. Most stages chain
   * only to themselves; the chain shape exists because the legacy
   * `task-select` / `finding-select` once chained into their execute
   * counterparts. Returns `undefined` for unknown actions so the caller
   * can surface a clear error.
   */
  forceChain(action: string): readonly string[] | undefined;
}
