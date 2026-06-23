import { z } from "zod";

// ─── agents.yaml ────────────────────────────────────────────────────────

const providerSchema = z.object({
  command: z.string(),
  defaultArgs: z.array(z.string()).optional(),
  promptArg: z.string().optional(),
  modelArg: z.string().optional(),
  // Fallback model id for a role on this provider that declares no `model`
  // (e.g. `auto` for cursor-agent). A role's explicit `model` always wins.
  defaultModel: z.string().optional(),
  toolsArg: z.string().optional(),
  maxBudgetArg: z.string().optional(),
  systemPromptFileArg: z.string().optional(),
  outputMode: z.enum(["stdout", "file"]).default("stdout"),
  envVars: z.array(z.string()).optional(),
  envVarsAnyOf: z.array(z.string()).optional(),
  promptFromStdin: z.boolean().optional(),
});

const agentSchema = z.object({
  provider: z.string(),
  description: z.string().optional(),
  instructions: z.string(),
  timeout: z.number().default(600),
  model: z.string().optional(),
  review: z.boolean().optional(),
  tools: z.string().optional(),
  maxBudget: z.number().optional(),
  schedule: z.string().optional(),
  context: z.array(z.string()).optional(),
});

export const agentsFileSchema = z.object({
  version: z.string().optional(),
  defaultProvider: z.string().default("claude"),
  providers: z.record(z.string(), providerSchema),
  agents: z.record(z.string(), agentSchema),
});

export type AgentsFile = z.infer<typeof agentsFileSchema>;

// ─── project.yaml (.operator/project.yaml) ──────────────────────────────

export const projectYamlSchema = z.object({
  scripts: z.object({
    init: z.string().optional(),
    verify: z.string().optional(),
  }).optional(),
  context: z.string().optional(),
});

export type ProjectYaml = z.infer<typeof projectYamlSchema>;
