import { z } from "zod";

/**
 * Work item kind entry — one row in `kv:work-item-kinds/{kindName}`.
 * Defines a category of work item (finding, task, request, ...). Seeded
 * from `engine/content/prompts/kinds.yaml` into KV.
 *
 * `WorkItem.kind` at runtime is an open string; this schema is the
 * registry entry that tells the engine about branch prefixes, id prefix,
 * terminal status set, etc. (architecture-v5.md §8.1).
 */
export const workItemKindSchema = z.object({
  name: z.string().min(1),
  label: z.string().min(1),
  idPrefix: z.string().min(1),
  dataDir: z.string().min(1),
  branchPrefix: z.string().min(1),
  prPrefix: z.string().min(1),
  terminalStatuses: z.array(z.string().min(1)).min(1),
  /**
   * Kinds that may appear as the parent of items of this kind. A child
   * item's frontmatter `parent_id` MUST point to an item whose kind is
   * in this list. Empty array (or omitted) means "no parent" / top-level.
   *
   * Declarative — the orchestrator never hardcodes "finding spawns task".
   * Adding a new workflow that produces children is one YAML edit:
   * declare the parent kind here, and have the spawning stage write
   * `parent_id` to the new file.
   */
  parentKinds: z.array(z.string().min(1)).optional(),
});

export type WorkItemKindEntry = z.infer<typeof workItemKindSchema>;

/**
 * Convenience alias used by {@link KindRegistry} consumers. The registry
 * returns `KindDefinition` values from `get()` / iterates them via `all`.
 * Same shape as {@link WorkItemKindEntry}; two names for two vantage points
 * (schema/storage vs in-memory kind definition).
 */
export type KindDefinition = WorkItemKindEntry;
