import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { load as yamlLoad } from "js-yaml";
import { resolveContentPath } from "../infra/content-path.js";

/**
 * One entry produced by a category loader. `key` is the KV row key (category
 * is fixed per loader), `entry` is the parsed value before Zod validation.
 */
export interface SeedCandidate {
  readonly key: string;
  readonly entry: unknown;
  readonly sourcePath: string;
}

/**
 * Walk a directory tree, yielding every file that matches one of the
 * allowed extensions. Paths are returned relative to `root`, using
 * forward-slash separators regardless of platform.
 */
async function* walkFiles(root: string, extensions: readonly string[]): AsyncGenerator<string> {
  const entries = await readdirSafe(root);
  for (const entry of entries) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) {
      for await (const rel of walkFiles(full, extensions)) {
        yield join(entry.name, rel).replace(/\\/g, "/");
      }
      continue;
    }
    if (extensions.some((ext) => entry.name.endsWith(ext))) {
      yield entry.name;
    }
  }
}

async function readdirSafe(path: string): Promise<{ name: string; isDirectory(): boolean }[]> {
  try {
    return await readdir(path, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

async function readText(path: string): Promise<string> {
  return readFile(path, "utf-8");
}

async function readYaml(path: string): Promise<unknown> {
  return yamlLoad(await readText(path));
}

function stripExtension(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
}

/**
 * Load `engine/content/prompts/agents/**\/*.md` excluding the `verifier/`
 * subtree (which becomes a separate `verifier-criteria` category). The
 * topic key mirrors {@link KVPromptSource}'s convention: path relative
 * to `agents/`, without the `.md` extension.
 */
export async function loadPrompts(): Promise<SeedCandidate[]> {
  const root = resolveContentPath("prompts", "agents");
  const out: SeedCandidate[] = [];
  for await (const rel of walkFiles(root, [".md"])) {
    if (rel.startsWith("verifier/")) continue;
    const topic = stripExtension(rel);
    const body = await readText(join(root, rel));
    out.push({
      key: topic,
      entry: { topic, body },
      sourcePath: join(root, rel),
    });
  }
  return out;
}

/**
 * Load `engine/content/prompts/agents/verifier/*.md` as verifier criteria
 * entries keyed by stage name (filename without extension).
 */
export async function loadVerifierCriteria(): Promise<SeedCandidate[]> {
  const root = resolveContentPath("prompts", join("agents", "verifier"));
  const out: SeedCandidate[] = [];
  for await (const rel of walkFiles(root, [".md"])) {
    const stageName = stripExtension(rel);
    const body = await readText(join(root, rel));
    out.push({
      key: stageName,
      entry: { stageName, body },
      sourcePath: join(root, rel),
    });
  }
  return out;
}

/**
 * Load `engine/content/templates/**\/*.{md,txt}` as template entries keyed
 * by relative path (with extension) so that `finding-pr-body.md` and
 * `formats/task.txt` do not collide.
 */
export async function loadTemplates(): Promise<SeedCandidate[]> {
  const root = resolveContentPath("templates");
  const out: SeedCandidate[] = [];
  for await (const rel of walkFiles(root, [".md", ".txt"])) {
    const body = await readText(join(root, rel));
    out.push({
      key: rel,
      entry: { name: rel, body },
      sourcePath: join(root, rel),
    });
  }
  return out;
}

/**
 * Load the shipped `engine/content/defaults/agents.yaml`, emitting one
 * candidate per role under `agent-roles/{name}`.
 */
export async function loadAgentRoles(): Promise<SeedCandidate[]> {
  const path = resolveContentPath("defaults", "agents.yaml");
  const raw = (await readYaml(path)) as { agents?: Record<string, Record<string, unknown>> };
  const out: SeedCandidate[] = [];
  for (const [name, body] of Object.entries(raw.agents ?? {})) {
    out.push({ key: name, entry: { name, ...body }, sourcePath: path });
  }
  return out;
}

/**
 * Load the `providers:` block of `engine/content/defaults/agents.yaml`,
 * emitting one candidate per provider under `agent-providers/{id}`.
 *
 * The yaml stores a `defaultProvider` scalar alongside the `providers:`
 * map; that scalar is surfaced as the reserved key `_default` whose value
 * carries `{ id, command: defaultProvider }` so the runtime `resolveRole`
 * path can resolve a role's provider without parsing the yaml again.
 */
export async function loadAgentProviders(): Promise<SeedCandidate[]> {
  const path = resolveContentPath("defaults", "agents.yaml");
  const raw = (await readYaml(path)) as {
    providers?: Record<string, Record<string, unknown>>;
    defaultProvider?: string;
  };
  const out: SeedCandidate[] = [];
  for (const [id, body] of Object.entries(raw.providers ?? {})) {
    out.push({ key: id, entry: { id, ...body }, sourcePath: path });
  }
  if (raw.defaultProvider) {
    // `_default` is a synthetic pointer row. Schema accepts `command` minimally;
    // consumers read `id` to learn which provider entry to look up next.
    out.push({
      key: "_default",
      entry: { id: raw.defaultProvider, command: raw.defaultProvider },
      sourcePath: path,
    });
  }
  return out;
}

/**
 * Load the shipped `engine/content/defaults/defaults.yaml` as a single
 * `engine-defaults/global` entry. Singleton category — only one key.
 */
export async function loadEngineDefaults(): Promise<SeedCandidate[]> {
  const path = resolveContentPath("defaults", "defaults.yaml");
  const raw = (await readYaml(path)) as Record<string, unknown>;
  return [{ key: "global", entry: raw, sourcePath: path }];
}

/**
 * Load `engine/content/prompts/stages.yaml`, emitting one candidate per
 * stage keyed by `stage.name`.
 */
export async function loadWorkflowStages(): Promise<SeedCandidate[]> {
  const path = resolveContentPath("prompts", "stages.yaml");
  const raw = (await readYaml(path)) as { stages?: Array<Record<string, unknown>> };
  const out: SeedCandidate[] = [];
  for (const stage of raw.stages ?? []) {
    const name = String(stage.name);
    out.push({ key: name, entry: stage, sourcePath: path });
  }
  return out;
}

/**
 * Load `engine/content/prompts/kinds.yaml`, emitting one candidate per
 * kind keyed by the map key.
 */
export async function loadWorkItemKinds(): Promise<SeedCandidate[]> {
  const path = resolveContentPath("prompts", "kinds.yaml");
  const raw = (await readYaml(path)) as { kinds?: Record<string, Record<string, unknown>> };
  const out: SeedCandidate[] = [];
  for (const [name, body] of Object.entries(raw.kinds ?? {})) {
    out.push({ key: name, entry: { name, ...body }, sourcePath: path });
  }
  return out;
}

/**
 * Load `engine/content/prompts/analyzers/*.md` if present. MVP ships no
 * analyzer content so this returns `[]` in the default checkout — the
 * category stays empty until the user populates it.
 */
export async function loadAnalyzers(): Promise<SeedCandidate[]> {
  const root = resolveContentPath("prompts", "analyzers");
  const out: SeedCandidate[] = [];
  for await (const rel of walkFiles(root, [".md"])) {
    const id = stripExtension(rel);
    const body = await readText(join(root, rel));
    out.push({
      key: id,
      entry: { id, title: id, body },
      sourcePath: join(root, rel),
    });
  }
  return out;
}

