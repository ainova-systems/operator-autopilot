import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { load as yamlLoad } from "js-yaml";
import type { KVStore } from "@operator/core";
import { agentProviderSchema, agentRoleSchema } from "@operator/core";
import { resolveContentRoot } from "../baseline.js";
import {
  collectAgentRequirements,
  type AgentRequirementsResult,
  type ProviderLike,
  type RoleLike,
} from "./agent-requirements.js";

/**
 * Where the preflight learns which agent CLIs this instance needs.
 *
 * A configured instance answers from its own KV, so a deployment that has
 * repointed its roles is checked against what it actually runs. A database
 * the engine has never booted has no `agent-roles` rows yet — the wizard
 * runs before the first cycle, which is the whole point — so the shipped
 * `engine/content/defaults/agents.yaml` stands in. That file is data, not
 * engine code: reading it does not breach the app-never-imports-engine rule
 * (same arrangement as `baseline.ts`).
 */
export interface AgentConfig {
  readonly roles: readonly RoleLike[];
  readonly providers: readonly ProviderLike[];
  readonly source: "kv" | "baseline";
}

interface AgentsYaml {
  readonly defaultProvider?: string;
  readonly providers?: Record<string, Record<string, unknown>>;
  readonly agents?: Record<string, Record<string, unknown>>;
}

export async function loadAgentConfig(kv: KVStore | null): Promise<AgentConfig> {
  if (kv) {
    const fromKv = await readFromKV(kv);
    if (fromKv.roles.length > 0) return fromKv;
  }
  return readFromBaseline();
}

export async function loadAgentRequirements(kv: KVStore | null): Promise<AgentRequirementsResult> {
  const config = await loadAgentConfig(kv);
  return collectAgentRequirements(config.roles, config.providers);
}

async function readFromKV(kv: KVStore): Promise<AgentConfig> {
  const [roleEntries, providerEntries] = await Promise.all([
    kv.list("agent-roles"),
    kv.list("agent-providers"),
  ]);

  const roles: RoleLike[] = [];
  for (const entry of roleEntries) {
    const parsed = agentRoleSchema.safeParse(entry.value);
    if (parsed.success) roles.push({ name: parsed.data.name, provider: parsed.data.provider });
  }

  const providers: ProviderLike[] = [];
  for (const entry of providerEntries) {
    const parsed = agentProviderSchema.safeParse(entry.value);
    if (parsed.success) providers.push(toProviderLike(parsed.data));
  }

  return { roles, providers, source: "kv" };
}

async function readFromBaseline(): Promise<AgentConfig> {
  const path = join(resolveContentRoot(), "defaults", "agents.yaml");
  let raw: AgentsYaml;
  try {
    raw = (yamlLoad(await readFile(path, "utf-8")) ?? {}) as AgentsYaml;
  } catch {
    // A missing or unreadable baseline is not fatal: the preflight simply
    // reports that no agent roles are configured yet.
    return { roles: [], providers: [], source: "baseline" };
  }

  const providers: ProviderLike[] = Object.entries(raw.providers ?? {}).map(([id, entry]) =>
    toProviderLike({ id, ...entry }),
  );
  const roles: RoleLike[] = Object.entries(raw.agents ?? {})
    .map(([name, entry]) => ({ name, provider: String(entry?.["provider"] ?? "") }))
    .filter((role) => role.provider.length > 0);

  return { roles, providers, source: "baseline" };
}

function toProviderLike(entry: Record<string, unknown> & { id: string }): ProviderLike {
  return {
    id: entry.id,
    command: typeof entry["command"] === "string" ? entry["command"] : entry.id,
    envVars: stringArray(entry["envVars"]),
    envVarsAnyOf: stringArray(entry["envVarsAnyOf"]),
  };
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}
