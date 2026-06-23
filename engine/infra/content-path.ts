import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";

/**
 * Content categories bundled with the engine. These live under `engine/content/`
 * in the source tree and get seeded into KV by `seed.ts` on first boot
 * (architecture-v5.md §4.2). After seeding the engine reads from KV, not from
 * these files — the files are the bootstrap baseline.
 */
export type ContentCategory = "prompts" | "templates" | "defaults";

/**
 * Resolve the absolute path to a bundled content directory or file.
 *
 * Single helper so engine code never hard-codes `engine/content/...` strings.
 * When the engine ships bundled (production build), this helper reads from
 * `{bundleDir}/content/{category}/...`. In dev mode it reads from the source
 * tree at `{repoRoot}/engine/content/{category}/...`.
 *
 * Override via `OPERATOR_CONTENT_DIR` env var for tests or custom deployments.
 *
 * @param category - Top-level content category
 * @param subpath  - Optional file or subdirectory under the category
 * @returns Absolute filesystem path
 *
 * @example
 * resolveContentPath("prompts") // → /abs/path/to/engine/content/prompts
 * resolveContentPath("defaults", "agents.yaml") // → /abs/.../engine/content/defaults/agents.yaml
 * resolveContentPath("templates", "formats/finding.txt")
 */
export function resolveContentPath(category: ContentCategory, subpath?: string): string {
  const root = resolveContentRoot();
  return subpath ? join(root, category, subpath) : join(root, category);
}

/**
 * Resolve the root of the bundled content directory.
 *
 * Resolution order:
 *   1. `OPERATOR_CONTENT_DIR` env var (absolute path) — for tests / overrides
 *   2. Dev mode (source tree): `{repoRoot}/engine/content/` located relative
 *      to this source file's compiled location
 *
 * The helper is runtime-agnostic — it works for both `tsx` dev runs and
 * compiled `node dist/...` executions because `import.meta.url` always
 * resolves to the currently-executing module's location.
 */
function resolveContentRoot(): string {
  const override = process.env["OPERATOR_CONTENT_DIR"];
  if (override) return resolve(override);

  // __dirname equivalent for ES modules
  const here = dirname(fileURLToPath(import.meta.url));
  // engine/infra/content-path.ts → ../content/
  return resolve(here, "..", "content");
}
