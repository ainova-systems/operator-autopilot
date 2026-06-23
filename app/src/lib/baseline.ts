import { readFile, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { load as yamlLoad } from "js-yaml";

/**
 * Resolve the shipped engine content baseline directory.
 *
 * Baseline rows for `source: "content"` KV entries originate from
 * `engine/content/` in the monorepo. The app reads these files directly
 * (read-only) to implement the "Reset to baseline" write path — see
 * `/api/kv/:category/:key/reset`.
 *
 * Resolution order mirrors the engine's `resolveContentPath`:
 *   1. `OPERATOR_CONTENT_DIR` env var (absolute path) — tests/overrides.
 *   2. `app/src/lib/baseline.ts` → `../../../engine/content/` fallback.
 *
 * NOTE: this helper must never import from `@operator/engine`. The layer
 * rule "`@operator/app` never imports engine runtime" is enforced by
 * ESLint; the content files themselves are shared data, not code.
 */
function resolveContentRoot(): string {
  const override = process.env["OPERATOR_CONTENT_DIR"];
  if (override) return resolve(override);
  const here = dirname(fileURLToPath(import.meta.url));
  // app/src/lib/baseline.ts → ../../../engine/content
  return resolve(here, "..", "..", "..", "engine", "content");
}

/**
 * Load the baseline value for a seed-once KV row. Mirrors the logic in
 * `engine/storage/seed-sources.ts` per-category so the reset endpoint
 * produces the same value the engine would have seeded on a fresh DB.
 *
 * Throws when:
 *   - the category is not a baseline-backed seed-once category
 *   - the row key has no matching baseline file
 *
 * Callers should translate these to `404 Not Found` responses.
 */
export class BaselineNotFoundError extends Error {
  readonly code = "BASELINE_NOT_FOUND";
  constructor(category: string, key: string) {
    super(`No baseline available for ${category}/${key}`);
    this.name = "BaselineNotFoundError";
  }
}

export class BaselineUnsupportedError extends Error {
  readonly code = "BASELINE_UNSUPPORTED";
  constructor(category: string) {
    super(`Reset-to-baseline is not supported for category ${category}`);
    this.name = "BaselineUnsupportedError";
  }
}

async function readText(path: string): Promise<string> {
  return readFile(path, "utf-8");
}

async function readYaml(path: string): Promise<unknown> {
  return yamlLoad(await readText(path));
}

async function listFilesRecursive(root: string, ext: readonly string[]): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string, rel: string): Promise<void> {
    let entries: { name: string; isDirectory(): boolean }[];
    try {
      entries = await readdir(dir, { withFileTypes: true, encoding: "utf-8" });
    } catch {
      return;
    }
    for (const e of entries) {
      const name: string = e.name;
      const full = join(dir, name);
      const childRel = rel ? `${rel}/${name}` : name;
      if (e.isDirectory()) {
        await walk(full, childRel);
      } else if (ext.some((x) => name.endsWith(x))) {
        out.push(childRel);
      }
    }
  }
  await walk(root, "");
  return out;
}

export async function loadBaselineValue(category: string, key: string): Promise<unknown> {
  const root = resolveContentRoot();
  switch (category) {
    case "prompts": {
      if (key.startsWith("reviewer/")) throw new BaselineNotFoundError(category, key);
      const path = join(root, "prompts", "agents", `${key}.md`);
      const body = await readText(path);
      return { topic: key, body };
    }
    case "reviewer-criteria": {
      const path = join(root, "prompts", "agents", "reviewer", `${key}.md`);
      const body = await readText(path);
      return { stageName: key, body };
    }
    case "templates": {
      const path = join(root, "templates", key);
      const body = await readText(path);
      return { name: key, body };
    }
    case "agent-roles": {
      const path = join(root, "defaults", "agents.yaml");
      const raw = (await readYaml(path)) as { agents?: Record<string, Record<string, unknown>> };
      const entry = raw.agents?.[key];
      if (!entry) throw new BaselineNotFoundError(category, key);
      return { name: key, ...entry };
    }
    case "agent-providers": {
      const path = join(root, "defaults", "agents.yaml");
      const raw = (await readYaml(path)) as {
        providers?: Record<string, Record<string, unknown>>;
        defaultProvider?: string;
      };
      if (key === "_default") {
        if (!raw.defaultProvider) throw new BaselineNotFoundError(category, key);
        return { id: raw.defaultProvider, command: raw.defaultProvider };
      }
      const entry = raw.providers?.[key];
      if (!entry) throw new BaselineNotFoundError(category, key);
      return { id: key, ...entry };
    }
    case "engine-defaults": {
      if (key !== "global") throw new BaselineNotFoundError(category, key);
      const path = join(root, "defaults", "defaults.yaml");
      return (await readYaml(path)) as Record<string, unknown>;
    }
    case "workflow-stages": {
      const path = join(root, "prompts", "stages.yaml");
      const raw = (await readYaml(path)) as { stages?: Array<Record<string, unknown>> };
      const stage = (raw.stages ?? []).find((s) => String(s.name) === key);
      if (!stage) throw new BaselineNotFoundError(category, key);
      return stage;
    }
    case "work-item-kinds": {
      const path = join(root, "prompts", "kinds.yaml");
      const raw = (await readYaml(path)) as { kinds?: Record<string, Record<string, unknown>> };
      const entry = raw.kinds?.[key];
      if (!entry) throw new BaselineNotFoundError(category, key);
      return { name: key, ...entry };
    }
    case "analyzers": {
      const path = join(root, "prompts", "analyzers", `${key}.md`);
      const body = await readText(path);
      return { id: key, title: key, body };
    }
    default:
      throw new BaselineUnsupportedError(category);
  }
}

/**
 * Test-only helper: enumerate every baseline file available for a category,
 * yielding the KV key. Used by unit tests that want to assert baseline
 * completeness without touching the seed path.
 */
export async function listBaselineKeys(category: string): Promise<string[]> {
  const root = resolveContentRoot();
  switch (category) {
    case "prompts": {
      const rels = await listFilesRecursive(join(root, "prompts", "agents"), [".md"]);
      return rels
        .filter((r) => !r.startsWith("reviewer/"))
        .map((r) => r.replace(/\.md$/, ""));
    }
    case "reviewer-criteria":
      return (await listFilesRecursive(join(root, "prompts", "agents", "reviewer"), [".md"]))
        .map((r) => r.replace(/\.md$/, ""));
    case "templates":
      return listFilesRecursive(join(root, "templates"), [".md", ".txt"]);
    case "analyzers":
      return (await listFilesRecursive(join(root, "prompts", "analyzers"), [".md"]))
        .map((r) => r.replace(/\.md$/, ""));
    default:
      return [];
  }
}
