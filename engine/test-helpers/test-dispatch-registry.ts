import type {
  DefaultsConfig,
  ScheduleSpec,
  StageDispatchEntry,
  StageDispatchRegistry,
} from "@operator/core";

/**
 * Shared test helper — builds the canonical eight-action dispatch
 * registry the production engine uses today (init, branch-cleanup,
 * pr-lifecycle, pr-review, finding-plan, task-execute, research,
 * improver). Lives in `test-helpers/` so the unit tests for
 * `engine.ts`, `project-runner.ts`, and the smoke harness can share
 * one fixture without depending on the production
 * `buildStageDispatchRegistryFromKV` (which needs a live KV).
 *
 * The shape here mirrors what `buildStageDispatchRegistryFromKV`
 * produces from the seeded `engine/content/prompts/stages.yaml`
 * dispatch blocks plus the composition-root extras. Research uses the
 * production `queue-fill` schedule (not a clock-driven `daily` default).
 * Keep both in sync — if you change a feature-flag mapping or a schedule
 * key here, the production YAML / extras must move with it.
 */
export function buildTestDispatchRegistry(defaults: DefaultsConfig): StageDispatchRegistry {
  const schedules = defaults.schedules;

  const entries: StageDispatchEntry[] = [
    {
      action: "init",
      order: 10,
      schedule: { kind: "always" },
      isEnabled: () => true,
    },
    {
      action: "branch-cleanup",
      order: 20,
      schedule: interval(schedules.prReviewMinutes, "cleanup"),
      isEnabled: () => true,
    },
    {
      action: "pr-lifecycle",
      order: 30,
      schedule: interval(schedules.prLifecycleMinutes, "prLifecycle"),
      isEnabled: () => true,
    },
    {
      action: "pr-review",
      order: 40,
      schedule: interval(schedules.prReviewMinutes, "prReview"),
      isEnabled: (features) => features?.prReview !== false,
    },
    {
      action: "finding-plan",
      order: 50,
      schedule: interval(schedules.findingSelectMinutes, "findingSelect"),
      isEnabled: (features) =>
        features?.findingExecute !== false && features?.findingSelect !== false,
    },
    {
      action: "task-execute",
      order: 60,
      schedule: interval(schedules.taskSelectMinutes, "taskSelect"),
      isEnabled: (features) =>
        features?.taskExecute !== false && features?.taskSelect !== false,
    },
    {
      action: "research",
      order: 70,
      schedule: {
        kind: "queue-fill",
        targetKind: "finding",
        countStatuses: ["pending", "reopened"],
        target: 5,
        inFlightBranchPrefix: "ai/research",
        baseIntervalMinutes: 120,
        maxBackoffMinutes: 10080,
        stateKey: "research",
        backoffStateKey: "research-empty",
      },
      isEnabled: (features) => features?.dailyResearch !== false,
    },
    {
      action: "improver",
      order: 80,
      schedule: {
        kind: "weekly", dayOfWeek: schedules.improverDayOfWeek,
        guardMinutes: 60 * 24 * 6, stateKey: "improver",
      },
      isEnabled: (features) => features?.improver !== false,
    },
  ];

  const byAction = new Map(entries.map((e) => [e.action, e]));
  const normalOrder = [...entries].sort((a, b) => a.order - b.order);

  return {
    normalOrder,
    get: (action: string) => byAction.get(action),
    forceChain: (action: string) => byAction.has(action) ? [action] : undefined,
  };
}

function interval(intervalMinutes: number, stateKey: string): ScheduleSpec {
  return { kind: "interval", intervalMinutes, stateKey };
}
