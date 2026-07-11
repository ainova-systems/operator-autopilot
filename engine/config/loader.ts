import { ZodError, type ZodTypeAny } from "zod";
import type { KVStore, OperationContext } from "@operator/core";
import type {
  OperatorConfig, DefaultsConfig, ConventionsConfig, ProjectConfig,
  EngineDefaultsEntry, AgentProviderEntry, AgentRoleEntry, RepoEntry,
} from "@operator/core";
import {
  ConfigError,
  agentProviderSchema,
  agentRoleSchema,
  engineDefaultsSchema,
  repoSchema,
} from "@operator/core";
import type { AgentsFile } from "./schemas.js";
import { agentsFileSchema } from "./schemas.js";

/**
 * Build DefaultsConfig + ConventionsConfig from an `engine-defaults/global`
 * KV row. Shape-preserving port of the old file-based builder so downstream
 * consumers (`PRManager`, `NotificationRouter`, stage-logic) continue to see
 * the same `ConventionsConfig` object.
 */
function buildDefaults(parsed: EngineDefaultsEntry): { defaults: DefaultsConfig; conventions: ConventionsConfig } {
  return {
    defaults: {
      schedules: {
        prReviewMinutes: parsed.schedules.prReviewMinutes,
        taskSelectMinutes: parsed.schedules.taskSelectMinutes,
        findingSelectMinutes: parsed.schedules.findingSelectMinutes,
        improverDayOfWeek: parsed.schedules.improverDayOfWeek,
        prLifecycleMinutes: parsed.schedules.prLifecycleMinutes,
      },
      limits: {
        maxReviewAttempts: parsed.limits.maxReviewAttempts,
      },
      review: {
        ignoredBotLogins: parsed.review.ignoredBotLogins,
      },
      lifecycle: {
        promoteToReadyAfterIdleHours: parsed.lifecycle.promoteToReadyAfterIdleHours,
        autoMergeReadyAfterHours: parsed.lifecycle.autoMergeReadyAfterHours,
        autoCloseStuckAfterHours: parsed.lifecycle.autoCloseStuckAfterHours,
      },
    },
    conventions: {
      labels: parsed.labels,
      branches: parsed.conventions.branches,
      prPrefixes: parsed.conventions.prPrefixes,
      patterns: parsed.conventions.patterns,
      commentMarker: parsed.conventions.commentMarker,
    },
  };
}

/**
 * Load the full OperatorConfig from KV.
 *
 * Sources (all in KV after `seed.ts` runs):
 *
 * - `engine-defaults/global` — schedules, limits, labels, conventions.
 * - `repos/*` — managed repositories (seed-mirror from `config/repos.yaml`
 *   or UI-added via Step 16).
 *
 * After Step 15 the engine has no file-reading code path for runtime
 * configuration — even defaults and repos are materialised by `seed.ts`
 * and consumed through the KV boundary. The second positional argument
 * (`_configDir`) is retained for callers that still pass the instance
 * config directory; it is unused because the yaml baseline is already
 * mirrored into KV by the time this function runs.
 */
export async function loadOperatorConfig(
  _ctx: OperationContext,
  _configDir: string,
  kv: KVStore,
): Promise<OperatorConfig> {
  const defaultsEntry = await kv.get("engine-defaults", "global");
  if (!defaultsEntry) {
    throw new ConfigError(
      "CONFIG_KV_MISSING",
      "engine-defaults/global not found in KV (did seed.ts run?)",
    );
  }
  const parsedDefaults = parseKVRow(
    engineDefaultsSchema,
    "engine-defaults",
    "global",
    defaultsEntry.value,
  ) as EngineDefaultsEntry;
  const { defaults, conventions } = buildDefaults(parsedDefaults);

  const repoEntries = await kv.list("repos");
  const repos: ProjectConfig[] = repoEntries.map((entry) => {
    // Validate the structural shape, then hand the original value to
    // `toProjectConfig` so passthrough keys (`tracker`, `delivery`) — which
    // `repoSchema` does not enumerate — survive. Validation catches a
    // corrupt `vcs` block; passthrough preserves the historical envelope.
    parseKVRow(repoSchema, "repos", entry.key, entry.value);
    return toProjectConfig(entry.value as RepoEntry & Record<string, unknown>);
  });

  return { defaults, conventions, repos };
}

/**
 * Assemble an {@link AgentsFile} document from KV rows. Mirrors the
 * previous yaml schema so `resolveRole` / `resolveProviderConfig` keep
 * working unchanged.
 *
 * The `defaultProvider` is encoded in KV as the synthetic row
 * `agent-providers/_default` written by `seed-sources.ts`. That row carries
 * `{ id, command }` where `id` is the provider name to prefer when a role
 * omits its own `provider` entry.
 */
export async function loadAgentsConfig(
  _ctx: OperationContext,
  _configDir: string,
  kv: KVStore,
): Promise<AgentsFile> {
  const [roleEntries, providerEntries] = await Promise.all([
    kv.list("agent-roles"),
    kv.list("agent-providers"),
  ]);

  const providers: Record<string, Omit<AgentProviderEntry, "id">> = {};
  let defaultProvider: string | undefined;
  for (const entry of providerEntries) {
    const row = parseKVRow(
      agentProviderSchema,
      "agent-providers",
      entry.key,
      entry.value,
    ) as AgentProviderEntry;
    if (entry.key === "_default") {
      defaultProvider = row.id;
      continue;
    }
    // Strip `id` — agents.yaml keyed providers by map key, not by an id field.
    const { id: _ignored, ...rest } = row;
    providers[entry.key] = rest;
  }

  const agents: Record<string, Omit<AgentRoleEntry, "name">> = {};
  for (const entry of roleEntries) {
    const row = parseKVRow(
      agentRoleSchema,
      "agent-roles",
      entry.key,
      entry.value,
    ) as AgentRoleEntry;
    const { name: _ignored, ...rest } = row;
    agents[entry.key] = rest;
  }

  const candidate = {
    defaultProvider: defaultProvider ?? "claude",
    providers,
    agents,
  };

  try {
    return agentsFileSchema.parse(candidate);
  } catch (err) {
    if (err instanceof ZodError) {
      const issues = err.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
      throw new ConfigError(
        "CONFIG_KV_VALIDATION",
        `KV-materialised agents config failed validation:\n${issues}`,
        { cause: err },
      );
    }
    throw err;
  }
}

/**
 * Re-validate a KV row at the read boundary. Post-Step-15 every consumer
 * reads runtime config from KV — user edits via `/api/kv/*` are validated
 * on write, but rows can still be corrupted by direct `sqlite3` surgery or
 * by a future schema bump. Re-parsing here turns corruption into a typed
 * `ConfigError` with category/key and Zod issues so the operator can
 * diagnose and fix the row instead of staring at a deep-stack panic.
 */
function parseKVRow(schema: ZodTypeAny, category: string, key: string, value: unknown): unknown {
  try {
    return schema.parse(value);
  } catch (err) {
    if (err instanceof ZodError) {
      const issues = err.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
      throw new ConfigError(
        "KV_ROW_INVALID",
        `KV row ${category}/${key} failed schema validation at read boundary:\n${issues}`,
        { cause: err },
      );
    }
    throw err;
  }
}

/**
 * Convert a KV `repos/{id}` row into the runtime `ProjectConfig` shape. The
 * KV schema (`repoSchema`) is narrower than the historical repos.yaml shape
 * — extra fields (`tracker`, `features`, `limits`, `delivery`) are copied
 * through as-is when present.
 */
function toProjectConfig(row: RepoEntry & Record<string, unknown>): ProjectConfig {
  return {
    id: row.id,
    vcs: {
      platform: row.vcs.platform,
      repo: row.vcs.repo,
      branch: row.vcs.branch,
      tokenEnvVar: row.vcs.tokenEnvVar,
    },
    tracker: row.tracker as ProjectConfig["tracker"],
    features: row.features as ProjectConfig["features"],
    limits: row.limits as ProjectConfig["limits"],
    delivery: row.delivery as ProjectConfig["delivery"],
    lifecycle: row.lifecycle as ProjectConfig["lifecycle"],
    debug: row.debug,
  };
}
