import { z } from "zod";

/**
 * Workflow stage entry — one row in `kv:workflow-stages/{name}`. Defines
 * a single stage in the operator pipeline. Seeded from
 * `engine/content/prompts/stages.yaml` into KV.
 *
 * Stages are configuration, not code. Adding a stage = one yaml entry +
 * one prompt file under `engine/content/prompts/agents/`. The engine
 * never switches on stage name — the generic runner composes primitives
 * around `inputSource` / agent / `outputSink`, and the PR-resume loop
 * hooks back into the same stage when `reviewEnabled` is true.
 */

export const mergeShorthandSchema = z.enum(["gated", "auto"]);

export const mergeConditionsSchema = z.object({
  requireHuman: z.boolean().optional(),
  requireCIGreen: z.boolean().optional(),
  requireVerifierApproval: z.boolean().optional(),
  maxDiffLines: z.number().int().positive().optional(),
  allowedPaths: z.array(z.string()).optional(),
});

/**
 * How the runner interprets the agent's stdout.
 *
 * - `single-document` — exactly one YAML frontmatter-document, produces
 *   one output work item.
 * - `multi-document` — N frontmatter-documents separated by `---`, one
 *   output work item per document. Default for generator stages.
 * - `code-changes` — agent mutates the working tree through Edit/Write
 *   tools; the runner commits the diff, no document output expected.
 * - `structured-report` — one document whose body is written as the
 *   kind's artifact file (retrospective report per week).
 */
export const outputParserSchema = z.enum([
  "single-document",
  "multi-document",
  "code-changes",
  "structured-report",
]);

/**
 * How the runner materialises a parsed agent output.
 *
 * - `work-item-files` — frontmatter file per document under the output
 *   kind's `dataDir`.
 * - `code-changes` — commit the working-tree diff.
 * - `both` — agent emitted documents AND code changes.
 */
export const commitModeSchema = z.enum(["work-item-files", "code-changes", "both"]);

/**
 * Stage input contract.
 *
 * Declares the work-item kind+status the stage reads from and the vars
 * substituted into the agent prompt. Var values support `${item.field}`
 * substitution resolved against the selected work item before the prompt
 * is built.
 *
 * `iterate`, `recoveryPolicy`, and `preAgentPrimitive` are runner
 * extension points that name entries in the runner's registry — no
 * stage writes its own pre-agent code, every variation is a registered
 * primitive or policy.
 */
export const stageInputSourceSchema = z.object({
  kind: z.string().optional(),
  status: z.string().optional(),
  vars: z.record(z.string(), z.string()).optional(),
  /** Run the agent once per iterator item and aggregate outputs. */
  iterate: z.string().optional(),
  /** Pre-agent recovery applied to the selected item. */
  recoveryPolicy: z.enum(["reset-failed-to-pending"]).optional(),
  /** Pre-agent primitive that produces `taskContent`. */
  preAgentPrimitive: z.string().optional(),
});

/**
 * Stage output contract.
 *
 * Agent output → `parser` → document(s) or code changes → `commitMode`
 * → files or diff → `prTemplate` renders the PR body.
 */
export const stageOutputSinkSchema = z.object({
  kind: z.string().optional(),
  parser: outputParserSchema,
  commitMode: commitModeSchema,
  prTemplate: z.string().optional(),
});

/**
 * Per-stage dispatch policy — controls how the project-runner picks up
 * the stage each cycle: order in the run loop, feature gating against
 * project `features`, and the schedule cadence. Phase B Part 2 (2026-05-20)
 * moved this from in-code `buildDefaultDispatchRegistry` into the stage
 * row itself so adding a stage = one YAML row, no TS.
 *
 * `schedule` is a structured descriptor — NOT a cron string. The runner
 * does not own a cron parser; the four kinds below cover every cadence
 * the engine actually needs today (always-on, fixed interval, daily-at-
 * UTC-hour, weekly-on-UTC-day). The legacy cron-string `schedule` field
 * on the same workflow-stage row remains for documentation / future
 * cron-scheduler integration; it is NOT consulted by the registry
 * builder.
 */
const dispatchScheduleSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("always") }),
  z.object({
    kind: z.literal("interval"),
    intervalMinutes: z.number().int().positive(),
    stateKey: z.string().min(1),
  }),
  z.object({
    kind: z.literal("daily"),
    hourUtc: z.number().int().min(0).max(23),
    guardMinutes: z.number().int().positive(),
    stateKey: z.string().min(1),
  }),
  z.object({
    kind: z.literal("weekly"),
    dayOfWeek: z.number().int().min(1).max(7),
    guardMinutes: z.number().int().positive(),
    stateKey: z.string().min(1),
  }),
]);

const dispatchPolicySchema = z.object({
  /** Lower runs earlier in the project cycle (10, 20, … convention). */
  order: z.number().int(),
  /**
   * Project-features key(s) gating this stage. Empty = always feature-
   * enabled. Multi-key arrays = AND (every flag must be `!== false`) —
   * legacy compound gates such as `taskSelect && taskExecute` express
   * here as `["taskSelect", "taskExecute"]`. `null` flag values in the
   * project's `features` map count as "not set" → grant.
   */
  featureFlags: z.array(z.string().min(1)).optional(),
  schedule: dispatchScheduleSchema,
});

export const workflowStageSchema = z.object({
  name: z.string().min(1),
  agent: z.string().min(1),
  selector: z.enum(["per-item", "singleton", "discovery", "pr-feedback", "bootstrap"]),
  selectorConfig: z.record(z.string(), z.unknown()).optional(),
  merge: z.union([mergeShorthandSchema, mergeConditionsSchema]),
  branchScope: z.enum(["per-item", "singleton", "pr"]),
  branchPrefix: z.string().optional(),
  prTemplate: z.string().optional(),
  maxActive: z.number().int().positive().optional(),
  schedule: z.string(),
  enabled: z.boolean(),

  inputSource: stageInputSourceSchema.optional(),
  outputSink: stageOutputSinkSchema,
  /**
   * Stage accepts re-entry on fresh PR feedback. When true, the
   * resume selector routes fresh-comment PRs of this stage's branch
   * prefix back into the same stage with the feedback appended as
   * agent context. Set false for one-shot discovery stages that must
   * not loop on comments (research).
   */
  reviewEnabled: z.boolean(),

  /**
   * Cron-dispatch policy — order/feature-flags/schedule. Optional for
   * backward compatibility while the seed catches up; stages without a
   * `dispatch` block are skipped by the registry builder (they remain
   * defined as workflow stages but the project-runner won't auto-fire
   * them every cycle).
   */
  dispatch: dispatchPolicySchema.optional(),

  /**
   * Names the parameterised composer that builds this stage's hook
   * chain (beforeAgent / buildRunInput / buildPR / afterAgent). The
   * composition root (`entry.ts`) maps each value to a known composer
   * module under `engine/pipeline/composers/`. Phase B Part 3
   * (2026-05-20) makes the handler dispatch fully config-driven —
   * after the matching `entry.ts` refactor lands, adding a new stage =
   * one YAML row (this `composer` + `dispatch` block) + one prompt
   * file, no TypeScript edits.
   *
   * Closed string union for two reasons:
   *   - Composers carry stage-shape contracts (which selector, which
   *     scratch store, which hook ordering) that aren't expressible
   *     as data. Adding a new composer is a code change by design.
   *   - Schema-time validation catches typos in YAML before the engine
   *     boots with an unbuildable stage.
   *
   * Optional during the migration window so existing seeds continue
   * to validate before each row carries the field.
   */
  composer: z
    .enum([
      "aop-planner",
      "verifier-driven-creator",
      "discovery-iteration",
      "weekly-metrics",
      "pr-feedback-supervisor",
      "closed-pr-recovery",
      "bootstrap-init",
    ])
    .optional(),

  /**
   * Free-form configuration consumed by the composer factory at handler-
   * build time. Schema is intentionally `record(unknown)` here — each
   * composer factory does its own typed `parse` over the subset it
   * cares about (e.g. `aop-planner` reads `agentRole`, `verifierTopic`,
   * `parentKind`, `childKind`, `idPrefix`, `idVarName`, `seqVarName`,
   * `displayName`, `prTemplate`). Lets new stages set per-stage knobs
   * (which agent role, which verifier topic, what work-item kind it
   * spawns) entirely via YAML, no TypeScript edits.
   */
  composerConfig: z.record(z.string(), z.unknown()).optional(),
});

export type WorkflowStageEntry = z.infer<typeof workflowStageSchema>;
