import { z } from "zod";

/**
 * Prompt entry — one agent role prompt, verifier criteria, or context
 * fragment. Seeded from markdown files under `engine/content/prompts/agents/`
 * into `kv:prompts/{topic}` where topic mirrors the file path without extension.
 *
 * Body is markdown. Optional frontmatter carries display metadata the UI
 * uses when rendering the prompt editor; the engine's `KVPromptSource`
 * strips frontmatter before sending the body to the agent runtime.
 */
export const promptSchema = z.object({
  topic: z.string().min(1),
  body: z.string(),
  title: z.string().optional(),
  description: z.string().optional(),
});

export type PromptEntry = z.infer<typeof promptSchema>;
