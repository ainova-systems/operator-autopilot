import { z } from "zod";

/**
 * Verifier criteria entry — one row in `kv:verifier-criteria/{stageName}`.
 * Defines stage-specific review rules the verifier agent applies after an
 * action agent produces a diff. Seeded from
 * `engine/content/prompts/agents/verifier/{stage}.md` into KV.
 */
export const verifierCriteriaSchema = z.object({
  stageName: z.string().min(1),
  body: z.string(),
});

export type VerifierCriteriaEntry = z.infer<typeof verifierCriteriaSchema>;
