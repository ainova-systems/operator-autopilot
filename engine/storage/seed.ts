import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { load as yamlLoad } from "js-yaml";
import { ZodError, type ZodTypeAny } from "zod";
import type { KVStore, OperationContext } from "@operator/core";
import {
  ConfigError,
  agentProviderSchema,
  agentRoleSchema,
  analyzerSchema,
  engineDefaultsSchema,
  promptSchema,
  repoSchema,
  verifierCriteriaSchema,
  templateSchema,
  workItemKindSchema,
  workflowStageSchema,
} from "@operator/core";
import type { Logger } from "../logging/logger.js";
import {
  loadAgentProviders,
  loadAgentRoles,
  loadAnalyzers,
  loadEngineDefaults,
  loadPrompts,
  loadVerifierCriteria,
  loadTemplates,
  loadWorkItemKinds,
  loadWorkflowStages,
  type SeedCandidate,
} from "./seed-sources.js";

export interface SeedOptions {
  readonly configDir: string;
  /** Categories to reseed (overwrite even if already present). `"all"` forces every seed-once category. */
  readonly reseedCategories?: ReadonlySet<string>;
}

export interface SeedResult {
  readonly seededOnce: Record<string, number>;
  readonly mirrored: { readonly upserted: number; readonly deleted: number };
}

interface SeedOnceSpec {
  readonly category: string;
  readonly schema: ZodTypeAny;
  readonly load: () => Promise<SeedCandidate[]>;
  /**
   * When true, every boot overwrites the shipped `source: "content"` rows
   * with the current baseline — used for infra-critical categories that
   * are NOT editable through the UI today (provider flags, engine
   * defaults). `source: "ui"` rows are left alone so user edits through
   * Step 16 survive a boot.
   *
   * When false/absent, the category is seed-once — existing rows are kept
   * untouched unless the operator invokes `--reseed <category>`.
   */
  readonly overwriteContentOnBoot?: boolean;
}

const SEED_ONCE_SPECS: readonly SeedOnceSpec[] = [
  { category: "prompts", schema: promptSchema, load: loadPrompts, overwriteContentOnBoot: true },
  { category: "verifier-criteria", schema: verifierCriteriaSchema, load: loadVerifierCriteria, overwriteContentOnBoot: true },
  { category: "templates", schema: templateSchema, load: loadTemplates, overwriteContentOnBoot: true },
  { category: "agent-roles", schema: agentRoleSchema, load: loadAgentRoles, overwriteContentOnBoot: true },
  { category: "agent-providers", schema: agentProviderSchema, load: loadAgentProviders, overwriteContentOnBoot: true },
  { category: "engine-defaults", schema: engineDefaultsSchema, load: loadEngineDefaults, overwriteContentOnBoot: true },
  { category: "workflow-stages", schema: workflowStageSchema, load: loadWorkflowStages, overwriteContentOnBoot: true },
  { category: "work-item-kinds", schema: workItemKindSchema, load: loadWorkItemKinds, overwriteContentOnBoot: true },
  { category: "analyzers", schema: analyzerSchema, load: loadAnalyzers, overwriteContentOnBoot: true },
];

const RESEED_ALL = "all";

/**
 * Run both seed passes against `kv`. Idempotent — every invocation is a
 * no-op when KV is already populated except for categories listed in
 * `reseedCategories`. Returns per-category counts so the caller can log a
 * structured summary.
 *
 * See architecture-v5.md §4.2 for the seed contract.
 */
export async function seed(
  kv: KVStore,
  opts: SeedOptions,
  _ctx: OperationContext,
  log: Logger,
): Promise<SeedResult> {
  const reseed = opts.reseedCategories ?? new Set<string>();
  const reseedAll = reseed.has(RESEED_ALL);

  const seededOnce: Record<string, number> = {};
  for (const spec of SEED_ONCE_SPECS) {
    const forceOverwrite = reseedAll || reseed.has(spec.category);
    seededOnce[spec.category] = await seedOnceCategory(kv, spec, forceOverwrite, log);
  }

  const mirrored = await seedMirrorRepos(kv, opts.configDir, log);

  return { seededOnce, mirrored };
}

async function seedOnceCategory(
  kv: KVStore,
  spec: SeedOnceSpec,
  forceOverwrite: boolean,
  log: Logger,
): Promise<number> {
  const candidates = await spec.load();
  let written = 0;

  for (const candidate of candidates) {
    const parsed = parseOrThrow(spec.schema, candidate);

    const existing = await kv.get(spec.category, candidate.key);
    if (existing && !forceOverwrite) {
      // overwriteContentOnBoot: refresh only rows still marked as shipped
      // baseline. Rows edited through the UI (source = "ui") keep their
      // user values so the write path from Step 16 is not clobbered.
      const isShippedBaseline = existing.metadata?.source === "content";
      if (!spec.overwriteContentOnBoot || !isShippedBaseline) continue;
    }

    await kv.put(spec.category, candidate.key, parsed, {
      metadata: { source: "content", readonly: false },
    });
    written++;
  }

  if (written > 0) {
    log.info(`Seed: ${spec.category} ${written} row(s) written`);
  }
  return written;
}

async function seedMirrorRepos(
  kv: KVStore,
  configDir: string,
  log: Logger,
): Promise<{ upserted: number; deleted: number }> {
  const path = resolve(configDir, "repos.yaml");

  const raw = await readYamlOrNull(path);
  if (!raw) {
    log.warn(`Seed-mirror: ${path} missing; skipping repos category.`);
    return { upserted: 0, deleted: 0 };
  }

  const reposEnvelope = raw as { repos?: Array<Record<string, unknown>> };
  const yamlRepos = reposEnvelope.repos ?? [];
  if (yamlRepos.length === 0) {
    log.warn(`Seed-mirror: ${path} has no repos entries.`);
  }

  // 2026-05-20: relaxed yaml-mirror semantics. `config/repos.yaml` is now
  // a STARTING TEMPLATE rather than the ongoing source of truth — once a
  // row is edited via the UI, its `source` flips to `ui` and the seed
  // mirror leaves it alone. This unblocks the App's repo edit + add
  // flows (Phase 5 P-502 partial). Effects:
  //
  //   - `readonly: false` on the seeded yaml row (UI can override)
  //   - re-mirror skips rows where `source !== "yaml"` (UI takes ownership;
  //     subsequent yaml-file edits don't clobber UI edits)
  //   - yaml-driven deletion still happens for rows whose source is
  //     `yaml` AND id disappeared from the file (matches prior
  //     behaviour — yaml stays authoritative for as long as no UI edit
  //     has happened)
  const yamlIds = new Set<string>();
  const existing = await kv.list("repos");
  const uiOwnedIds = new Set(
    existing
      .filter((e) => e.metadata?.source && e.metadata.source !== "yaml")
      .map((e) => e.key),
  );
  let upserted = 0;

  for (const rawRepo of yamlRepos) {
    parseOrThrow(repoSchema, { key: String(rawRepo.id ?? "?"), entry: rawRepo, sourcePath: path });
    const id = String(rawRepo.id);
    yamlIds.add(id);
    if (uiOwnedIds.has(id)) {
      log.info(`Seed-mirror: repos/${id} skipped — owned by UI (source != yaml)`);
      continue;
    }
    await kv.put("repos", id, rawRepo, {
      metadata: { source: "yaml", readonly: false },
    });
    upserted++;
  }

  let deleted = 0;
  for (const entry of existing) {
    if (entry.metadata?.source === "yaml" && !yamlIds.has(entry.key)) {
      await kv.delete("repos", entry.key);
      deleted++;
    }
  }

  log.info(`Seed-mirror: repos ${upserted} upserted, ${deleted} deleted`);
  return { upserted, deleted };
}

async function readYamlOrNull(path: string): Promise<unknown | null> {
  let content: string;
  try {
    content = await readFile(path, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new ConfigError("SEED_FILE_READ", `Failed to read ${path}`, { cause: err as Error });
  }
  try {
    return yamlLoad(content);
  } catch (err) {
    throw new ConfigError("SEED_YAML_PARSE", `Failed to parse YAML in ${path}: ${(err as Error).message}`, {
      cause: err as Error,
    });
  }
}

function parseOrThrow(schema: ZodTypeAny, candidate: SeedCandidate): unknown {
  try {
    return schema.parse(candidate.entry);
  } catch (err) {
    if (err instanceof ZodError) {
      const issues = err.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
      throw new ConfigError(
        "SEED_VALIDATION",
        `Seed validation failed for ${candidate.sourcePath} (key=${candidate.key}):\n${issues}`,
        { cause: err },
      );
    }
    throw err;
  }
}
