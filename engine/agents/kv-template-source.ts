import { ZodError } from "zod";
import type { KVStore } from "@operator/core";
import { ConfigError, templateSchema } from "@operator/core";

/**
 * KV-backed template loader. The single runtime reader for PR body templates
 * and format snippets; replaces the filesystem reads in
 * `delivery/pr-manager.ts` + `agents/output-formatter.ts` + the init handler
 * so `engine/content/templates/` is consumed exclusively through the
 * seed → KV boundary (architecture-v5.md §5.4, §6).
 *
 * Templates are keyed by the path they occupied under `engine/content/templates/`
 * — e.g. `"init-pr-body.md"` or `"formats/task.txt"`. The `{KEY}` placeholder
 * substitution mirrors the previous file-based implementations.
 */
export interface TemplateSource {
  /**
   * Fetch a template body with `{KEY}` placeholders substituted from `vars`.
   * Throws {@link TemplateNotFoundError} when the KV row is absent so callers
   * can `.catch(() => defaultBody)` for optional templates (e.g. README).
   */
  load(name: string, vars?: Record<string, string>): Promise<string>;
}

export class TemplateNotFoundError extends Error {
  readonly code = "TEMPLATE_NOT_FOUND";
  constructor(readonly name: string) {
    super(`Template not found in KV: ${name}`);
  }
}

export class KVTemplateSource implements TemplateSource {
  constructor(private readonly kv: KVStore) {}

  async load(name: string, vars: Record<string, string> = {}): Promise<string> {
    const entry = await this.kv.get("templates", name);
    if (!entry) throw new TemplateNotFoundError(name);
    // Re-parse at the read boundary so a corrupted row (e.g. from sqlite3
    // surgery or a future schema bump) throws a typed ConfigError with
    // category/key context instead of a runtime panic inside rendering.
    let parsed;
    try {
      parsed = templateSchema.parse(entry.value);
    } catch (err) {
      if (err instanceof ZodError) {
        const issues = err.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
        throw new ConfigError(
          "KV_ROW_INVALID",
          `KV row templates/${name} failed schema validation at read boundary:\n${issues}`,
          { cause: err },
        );
      }
      throw err;
    }
    return substituteVars(parsed.body, vars);
  }
}

function substituteVars(body: string, vars: Record<string, string>): string {
  let out = body;
  for (const [key, value] of Object.entries(vars)) {
    out = out.replaceAll(`{${key}}`, value);
  }
  return out;
}
