import { z } from "zod";

/**
 * Engine defaults entry — singleton `kv:engine-defaults/global` that carries
 * the baseline schedules, limits, review tuning, labels, and naming
 * conventions every repo inherits. Seeded from
 * `engine/content/defaults/defaults.yaml` on engine boot.
 *
 * Runtime consumers (`loadOperatorConfig`) query the `global` key directly.
 * Keeping the file as a single KV row (rather than sharding each group) keeps
 * the UI write path simple — one JSON document edited in the editor — while
 * matching the shape `OperatorConfig` expects without an extra join at read
 * time.
 */
/**
 * PR lifecycle automation. Drives the `pr-lifecycle` action that scans
 * open AI PRs and promotes / merges / closes based on age + label.
 *
 * - `promoteToReadyAfterIdleHours` — flip `ai:in-review` to
 *   `ai:ready-to-merge` after the PR has been idle (no commit, comment,
 *   or label change) for N hours. `null` disables the rule.
 * - `autoMergeReadyAfterHours` — merge a `ai:ready-to-merge` PR after
 *   N hours of additional idle. `null` keeps the human-merge step.
 *   When set, requires the platform's `mergeCodeReview` capability.
 * - `autoCloseStuckAfterHours` — close PRs that have been on
 *   `ai:processing` or `ai:failed` for N hours (typically a daemon
 *   crash or unrecoverable agent failure). `null` disables the rule.
 *
 * Per-repo overrides live on `repos/{id}.lifecycle`; per-work-item
 * overrides live as `lifecycle_*` frontmatter fields. Resolution order:
 * `item < repo < defaults`, with `null` meaning "inherit", and any
 * concrete number (including 0) winning.
 */
export const lifecycleConfigSchema = z.object({
  promoteToReadyAfterIdleHours: z.number().nonnegative().nullable().optional(),
  autoMergeReadyAfterHours: z.number().nonnegative().nullable().optional(),
  autoCloseStuckAfterHours: z.number().nonnegative().nullable().optional(),
});

export type LifecycleConfigEntry = z.infer<typeof lifecycleConfigSchema>;

export const engineDefaultsSchema = z.object({
  schedules: z.object({
    prReviewMinutes: z.number(),
    taskSelectMinutes: z.number(),
    findingSelectMinutes: z.number(),
    dailyResearchHour: z.number().min(0).max(23),
    improverDayOfWeek: z.number().min(1).max(7),
    /** How often the `pr-lifecycle` sweep runs (minutes). */
    prLifecycleMinutes: z.number().positive(),
  }),
  lifecycle: lifecycleConfigSchema,
  workspace: z.object({
    baseDir: z.string().min(1),
  }).optional(),
  limits: z.object({
    maxReviewAttempts: z.number().int().positive(),
  }),
  review: z.object({
    ignoredBotLogins: z.array(z.string()),
  }),
  labels: z.object({
    pending: z.string(),
    processing: z.string(),
    /**
     * Applied-changes / review-loop-active label. Signals "AI handled
     * current feedback, waiting on the next CI run or comment". The
     * pr-feedback selector scans PRs with this label for fresh feedback.
     */
    inReview: z.string(),
    /**
     * Terminal AI-handoff label — pr-review verified the PR without
     * committing further changes (clean workspace after approved
     * verdict). Excluded from pr-feedback so the PR sits here until
     * the human merges.
     */
    readyToMerge: z.string(),
    failed: z.string(),
    manual: z.string().optional(),
    cancelled: z.string().optional(),
    rejected: z.string().optional(),
  }),
  conventions: z.object({
    branches: z.object({
      aiPrefix: z.string(),
      init: z.string(),
      tasks: z.string(),
      findings: z.string(),
      research: z.string(),
      improver: z.string(),
    }),
    prPrefixes: z.object({
      task: z.string(),
      finding: z.string(),
      research: z.string(),
      improver: z.string(),
      init: z.string(),
      failed: z.string().optional(),
      manual: z.string().optional(),
    }),
    patterns: z.object({
      taskId: z.string(),
      findingPrefix: z.string(),
    }),
    commentMarker: z.string(),
  }),
});

export type EngineDefaultsEntry = z.infer<typeof engineDefaultsSchema>;

/**
 * Agent provider entry — one row in `kv:agent-providers/{id}`. Describes how
 * to spawn a specific CLI agent provider (command, args, env vars). Seeded
 * from the `providers:` map of `engine/content/defaults/agents.yaml`.
 *
 * Split out from `agent-roles/*` because roles reference a provider by name;
 * keeping the two categories distinct lets the UI edit a provider without
 * round-tripping every role that uses it.
 */
export const agentProviderSchema = z.object({
  id: z.string().min(1),
  command: z.string().min(1),
  defaultArgs: z.array(z.string()).optional(),
  promptArg: z.string().optional(),
  modelArg: z.string().optional(),
  /**
   * Model id used for a role on this provider when the role declares no
   * explicit `model`. Lets a provider pick a sensible house default (e.g.
   * `auto` for cursor-agent, which self-selects the best available model)
   * instead of falling back to a hard-coded constant that may not exist on
   * the provider. A role's own `model` always wins.
   */
  defaultModel: z.string().optional(),
  toolsArg: z.string().optional(),
  maxBudgetArg: z.string().optional(),
  systemPromptFileArg: z.string().optional(),
  outputMode: z.enum(["stdout", "file"]).optional(),
  envVars: z.array(z.string()).optional(),
  envVarsAnyOf: z.array(z.string()).optional(),
  /**
   * When true, the user prompt is written to the child's stdin instead of
   * being passed via `promptArg`. Required for CLIs that accept prompts
   * larger than the OS argv limit (~32 KB on Windows). When false or absent,
   * the legacy argv path is used.
   */
  promptFromStdin: z.boolean().optional(),
});

export type AgentProviderEntry = z.infer<typeof agentProviderSchema>;
