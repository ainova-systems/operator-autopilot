import { z } from "zod";

/**
 * Common metadata envelope attached to every KV row.
 *
 * - `source` tells the app which code path owns this row:
 *     `"content"` = seeded from `engine/content/` (seed-once mode)
 *     `"yaml"`    = seeded from `config/*.yaml` (seed-mirror mode, readonly)
 *     `"ui"`      = created through the app
 * - `readonly` gates UI edit operations. Yaml-sourced rows are always readonly.
 * - `modifiedFromBaseline` flips true when the shipped content file hash drifts
 *   from the KV row's hash (seed-once mode only). Used by the app to show a
 *   "modified from baseline" badge.
 * - `version` is an optimistic-lock counter incremented on every write.
 *
 * See architecture-v5.md §4.4 (two seed modes) and §15a (app multi-instance).
 */
export const metadataSchema = z.object({
  source: z.enum(["content", "yaml", "ui"]),
  readonly: z.boolean(),
  modifiedFromBaseline: z.boolean().optional(),
  version: z.number().int().nonnegative().optional(),
});

export type KVMetadata = z.infer<typeof metadataSchema>;
