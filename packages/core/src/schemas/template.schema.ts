import { z } from "zod";

/**
 * Template entry — a PR body template or a format snippet. Seeded from
 * markdown files under `engine/content/templates/` and text snippets under
 * `engine/content/templates/formats/` into `kv:templates/{name}`.
 *
 * Body is raw text. Variables are resolved with `{KEY}` placeholder
 * substitution at render time (see `engine/agents/prompt-builder.ts`).
 */
export const templateSchema = z.object({
  name: z.string().min(1),
  body: z.string(),
  description: z.string().optional(),
});

export type TemplateEntry = z.infer<typeof templateSchema>;
