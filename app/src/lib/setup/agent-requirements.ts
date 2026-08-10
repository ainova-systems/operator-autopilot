import { readEnvVar, type EnvRecord } from "./which.js";

/**
 * Derive "what must be installed and exported before the engine can run"
 * from the agent configuration itself, rather than hard-coding a list of
 * CLI names in the setup screen.
 *
 * The provider/role split is configuration (`agent-providers` and
 * `agent-roles` in KV, seeded from `engine/content/defaults/agents.yaml`),
 * so a deployment that moves every role onto one vendor must see a
 * preflight that asks for one CLI — not for whatever the shipped default
 * happened to be.
 */
export interface ProviderLike {
  readonly id: string;
  readonly command: string;
  readonly envVars?: readonly string[];
  readonly envVarsAnyOf?: readonly string[];
}

export interface RoleLike {
  readonly name: string;
  readonly provider: string;
}

export interface AgentRequirement {
  readonly providerId: string;
  readonly command: string;
  /** Every one of these must be set. */
  readonly envVars: readonly string[];
  /** At least one of these must be set. */
  readonly envVarsAnyOf: readonly string[];
  /** Role names that route to this provider, sorted. */
  readonly usedBy: readonly string[];
}

export interface AgentRequirementsResult {
  readonly requirements: readonly AgentRequirement[];
  /** Provider ids a role references that no provider row defines. */
  readonly unknownProviders: readonly string[];
}

export function collectAgentRequirements(
  roles: readonly RoleLike[],
  providers: readonly ProviderLike[],
): AgentRequirementsResult {
  const byId = indexProviders(providers);

  const usedBy = new Map<string, string[]>();
  const unknown = new Set<string>();
  for (const role of roles) {
    if (!byId.has(role.provider)) {
      unknown.add(role.provider);
      continue;
    }
    const list = usedBy.get(role.provider) ?? [];
    list.push(role.name);
    usedBy.set(role.provider, list);
  }

  const requirements: AgentRequirement[] = [];
  for (const [providerId, roleNames] of usedBy) {
    const provider = byId.get(providerId);
    if (!provider) continue;
    requirements.push({
      providerId,
      command: provider.command,
      envVars: [...(provider.envVars ?? [])],
      envVarsAnyOf: [...(provider.envVarsAnyOf ?? [])],
      usedBy: [...roleNames].sort(),
    });
  }
  requirements.sort((a, b) => a.providerId.localeCompare(b.providerId));

  return { requirements, unknownProviders: [...unknown].sort() };
}

/**
 * Names of the environment variables this provider needs but the given
 * environment does not supply. An `envVarsAnyOf` group that is entirely
 * unset is reported as one combined entry (`"A or B"`), because setting
 * either one satisfies it.
 */
export function missingEnvVars(
  requirement: AgentRequirement,
  env: EnvRecord,
): string[] {
  const missing = requirement.envVars.filter((name) => !isSet(env, name));
  const anyOf = requirement.envVarsAnyOf;
  if (anyOf.length > 0 && !anyOf.some((name) => isSet(env, name))) {
    missing.push(anyOf.join(" or "));
  }
  return missing;
}

function isSet(env: EnvRecord, name: string): boolean {
  const value = readEnvVar(env, name);
  return value !== undefined && value.trim().length > 0;
}

/**
 * Collapse the provider list onto one entry per id. The KV category carries
 * a synthetic `_default` row whose value re-states an existing provider id
 * with nothing but a command; the richer definition has to win so its env
 * requirements survive the merge.
 */
function indexProviders(providers: readonly ProviderLike[]): Map<string, ProviderLike> {
  const byId = new Map<string, ProviderLike>();
  for (const provider of providers) {
    const existing = byId.get(provider.id);
    if (!existing || envDeclarationCount(provider) > envDeclarationCount(existing)) {
      byId.set(provider.id, provider);
    }
  }
  return byId;
}

function envDeclarationCount(provider: ProviderLike): number {
  return (provider.envVars?.length ?? 0) + (provider.envVarsAnyOf?.length ?? 0);
}
