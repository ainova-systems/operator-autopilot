import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ZodError } from "zod";
import type { KVStore, PromptSource } from "@operator/core";
import { ConfigError, promptSchema, verifierCriteriaSchema } from "@operator/core";
import type { Logger } from "../logging/logger.js";

/**
 * KV-backed {@link PromptSource}. Reads the system layer from
 * `kv:prompts/{topic}` or `kv:verifier-criteria/{stage}` (architecture-v5.md
 * §12) and appends the filesystem user layer from
 * `{automationDir}/agents/{topic}.md` when present.
 *
 * Topic routing:
 *
 * - `"verifier/{stage}"` — system layer comes from `kv:verifier-criteria/{stage}`.
 *   Seed wrote one row per `engine/content/prompts/agents/verifier/*.md` with
 *   the stage name as the key; this class peels the `verifier/` prefix and
 *   queries the category directly.
 * - Everything else — system layer comes from `kv:prompts/{topic}`. The topic
 *   mirrors the file path relative to `engine/content/prompts/agents/` without
 *   the `.md` extension (e.g. `"creator"`, `"context/base"`).
 *
 * User extension layer stays file-backed under
 * `{automationDir}/agents/{topic}.md` so repo owners keep the same override
 * mechanism `FilePromptSource` offered. When neither layer resolves, returns
 * the empty string — callers provide their own fallback if the topic is
 * required.
 */
export class KVPromptSource implements PromptSource {
  constructor(
    private readonly kv: KVStore,
    /** Absolute path to the managed repo's `.operator/` directory. */
    private readonly automationDir: string,
    private readonly log?: Logger,
  ) {}

  async loadChain(topic: string): Promise<string> {
    const parts: string[] = [];

    // System layer — KV lookup routed by topic prefix.
    const systemBody = await this.loadSystemLayer(topic);
    if (systemBody) parts.push(stripFrontmatter(systemBody));

    // User extension layer — filesystem fallback. Mirrors the shipped topic
    // tree under `.operator/agents/{topic}.md`.
    const userPath = join(this.automationDir, "agents", `${topic}.md`);
    const user = await readIfExists(userPath);
    if (user) {
      parts.push("## Repository Extensions");
      parts.push(stripFrontmatter(user));
    }

    return parts.join("\n\n").trim();
  }

  /**
   * Look up the system layer for `topic` in KV. Returns the raw markdown
   * body (pre-frontmatter-strip) or `null` when the row is absent.
   */
  private async loadSystemLayer(topic: string): Promise<string | null> {
    if (topic.startsWith("verifier/")) {
      const stage = topic.slice("verifier/".length);
      const entry = await this.kv.get("verifier-criteria", stage);
      if (!entry) {
        this.log?.warn(`KVPromptSource: verifier-criteria/${stage} not in KV`, {
          topic, category: "verifier-criteria", key: stage,
        });
        return null;
      }
      return parseAtReadBoundary(verifierCriteriaSchema, "verifier-criteria", stage, entry.value).body;
    }

    const entry = await this.kv.get("prompts", topic);
    if (!entry) {
      this.log?.warn(`KVPromptSource: prompts/${topic} not in KV`, {
        topic, category: "prompts", key: topic,
      });
      return null;
    }
    return parseAtReadBoundary(promptSchema, "prompts", topic, entry.value).body;
  }
}

/**
 * Re-validate `value` at the read boundary. User edits through `/api/kv/*`
 * are schema-checked at write time, but a malformed row can still land via
 * CLI `sqlite3` surgery or a future schema bump. Re-parsing here turns
 * corruption into a clean `ConfigError` with category/key and Zod issues
 * instead of a runtime panic deep inside the agent loop.
 */
function parseAtReadBoundary<T>(
  schema: { parse(v: unknown): T },
  category: string,
  key: string,
  value: unknown,
): T {
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

async function readIfExists(path: string): Promise<string | null> {
  try {
    const content = await readFile(path, "utf-8");
    return content.trim() || null;
  } catch {
    return null;
  }
}

function stripFrontmatter(content: string): string {
  const match = content.match(/^---\n[\s\S]*?\n---\n?/);
  return match ? content.slice(match[0].length).trim() : content.trim();
}
