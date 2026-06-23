import { z } from "zod";

/**
 * Agent role entry — one row in `kv:agent-roles/{roleName}`. Defines how
 * the engine spawns a specific LLM role (creator, planner, verifier, ...).
 * Seeded from `engine/content/defaults/agents.yaml` into KV.
 */
export const agentRoleSchema = z.object({
  name: z.string().min(1),
  provider: z.string().min(1),
  description: z.string().optional(),
  instructions: z.string().min(1),
  timeout: z.number().int().positive(),
  model: z.string().optional(),
  review: z.boolean().optional(),
  tools: z.string().optional(),
  maxBudget: z.number().nonnegative().optional(),
  context: z.array(z.string()).optional(),
  schedule: z.string().optional(),
});

export type AgentRoleEntry = z.infer<typeof agentRoleSchema>;
