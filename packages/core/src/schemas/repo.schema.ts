import { z } from "zod";
import { lifecycleConfigSchema } from "./engine-defaults.schema.js";

/**
 * Repo entry — one row in `kv:repos/{id}`. Describes a managed repository
 * the operator should work on. Two sources feed this category:
 *
 * - `config/repos.yaml` via seed-mirror mode (metadata.source = "yaml",
 *   metadata.readonly = true). Rows rebuilt every engine start.
 * - The app UI (metadata.source = "ui", metadata.readonly = false).
 *
 * See architecture-v5.md §4.4 for the seed-mirror lifecycle.
 */
/**
 * Per-repo stage gates. The keys here are the set of feature flags a stage's
 * `dispatch.featureFlags` may reference (see `stages.yaml`). Unknown keys are
 * stripped (not rejected) at the validation boundary: persisted `kv:repos/*`
 * rows — especially UI-owned ones the seed-mirror does not rebuild — can carry
 * a legacy flag from before a schema change, and the read boundary must tolerate
 * that drift rather than crash boot. A stripped flag never reaches runtime, so a
 * dead toggle (like the removed `issueSync`) is inert, not a hard error.
 */
export const repoFeaturesSchema = z.object({
  prReview: z.boolean().optional(),
  taskSelect: z.boolean().optional(),
  taskExecute: z.boolean().optional(),
  dailyResearch: z.boolean().optional(),
  improver: z.boolean().optional(),
  findingSelect: z.boolean().optional(),
  findingExecute: z.boolean().optional(),
});

export const repoLimitsSchema = z.object({
  maxActiveTasks: z.number().int().positive().optional(),
  maxActiveFindings: z.number().int().positive().optional(),
});

export const repoVcsSchema = z.object({
  platform: z.literal("github"),
  repo: z.string().min(1),
  branch: z.string().min(1),
  tokenEnvVar: z.string().min(1),
});

export const repoSchema = z.object({
  id: z.string().min(1),
  debug: z.boolean().optional(),
  vcs: repoVcsSchema,
  features: repoFeaturesSchema.optional(),
  limits: repoLimitsSchema.optional(),
  /**
   * Per-repo override of the global `lifecycle` block from
   * `engine-defaults`. Any field left undefined inherits the default.
   * `null` on a field means "explicitly disable this automation for
   * this repo" and overrides the inherited value.
   */
  lifecycle: lifecycleConfigSchema.optional(),
});

export type RepoEntry = z.infer<typeof repoSchema>;
