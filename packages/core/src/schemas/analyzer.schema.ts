import { z } from "zod";

/**
 * Analyzer entry — one row in `kv:analyzers/{stageName}/{analyzerId}`.
 * Defines a single analyzer definition consumed by `discovery` selector
 * stages (research being the main customer). Seeded from
 * `engine/content/prompts/analyzers/*.md` on first boot; managed repos
 * may add their own analyzers under `.operator/stages/research/*.md`.
 */
export const analyzerSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  body: z.string().min(1),
  schedule: z.string().optional(),
  enabled: z.boolean().optional(),
});

export type AnalyzerEntry = z.infer<typeof analyzerSchema>;
