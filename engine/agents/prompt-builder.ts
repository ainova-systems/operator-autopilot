import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseFrontmatter, getAgentBody, getAgentName } from "./frontmatter.js";
import type { PromptSource } from "@operator/core";

// ── Path matching (ports agents.sh pathsOverlap / agent_matches_path) ───

/**
 * Convert a glob pattern to a representative sample path.
 * Ports agents.sh path_to_sample().
 */
export function pathToSample(pattern: string): string {
  if (!pattern || pattern === "*") return "*";
  const base = pattern
    .replace(/\/?\*\*$/, "")
    .replace(/\/?\*$/, "")
    .replace(/\/$/, "");
  return `${base}/_sample_`;
}

/**
 * Check if a glob pattern matches a target path (simplified).
 * Ports agents.sh agent_matches_path().
 */
export function matchesPath(pattern: string, target: string): boolean {
  if (!pattern || pattern === "*") return true;
  if (target === "*") return true;
  const base = pattern.replace(/\/?\*+$/, "").replace(/\/$/, "");
  if (!base) return true;
  return target.startsWith(base);
}

/**
 * Check if two path patterns could match overlapping files.
 * Ports agents.sh paths_overlap().
 */
export function pathsOverlap(a: string, b: string): boolean {
  if (!a || a === "*" || !b || b === "*") return true;
  const sampleA = pathToSample(a);
  const sampleB = pathToSample(b);
  return matchesPath(a, sampleB) || matchesPath(b, sampleA);
}

// ── File discovery ──────────────────────────────────────────────────────

/**
 * List all .md files in a directory, sorted by name.
 * Returns empty array if directory doesn't exist.
 */
export async function listMdFiles(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries
      .filter((e) => e.isFile() && e.name.endsWith(".md"))
      .map((e) => join(dir, e.name))
      .sort();
  } catch {
    return [];
  }
}

// ── Rule discovery (ports agents.sh discover_matching_rules) ────────────

/**
 * Discover rule files matching a target path, filtering by enabled status.
 * Ports agents.sh discover_matching_rules().
 */
export async function discoverMatchingRules(
  automationDir: string,
  phase: string,
  targetPath?: string,
): Promise<string[]> {
  const files = await listMdFiles(join(automationDir, phase));
  const matched: string[] = [];
  for (const file of files) {
    const content = await readFile(file, "utf-8");
    const enabled = parseFrontmatter(content, "enabled");
    if (enabled === "false") continue;
    const rulePath = parseFrontmatter(content, "path") ?? "*";
    if (pathsOverlap(rulePath, targetPath ?? "*")) {
      matched.push(file);
    }
  }
  return matched;
}

/**
 * Merge multiple rule file bodies into one prompt section.
 * Each rule gets a `## Rules: {name}` heading.
 * Ports agents.sh merge_rule_bodies().
 */
export async function mergeRuleBodies(files: string[]): Promise<string> {
  const sections: string[] = [];
  for (const file of files) {
    const content = await readFile(file, "utf-8");
    const name = getAgentName(file);
    const body = getAgentBody(content);
    if (!body) continue;
    sections.push(`## Rules: ${name}\n\n${body}`);
  }
  return sections.join("\n\n---\n\n");
}

// ── Variable substitution (ports run-agent.sh substitute_vars) ──────────

/**
 * Replace `{KEY}` placeholders with values from vars map.
 * Ports run-agent.sh substitute_vars().
 */
export function substituteVars(content: string, vars: Record<string, string>): string {
  let result = content;
  for (const [key, value] of Object.entries(vars)) {
    result = result.replaceAll(`{${key}}`, value);
  }
  return result;
}

// ── Prompt building (ports run-agent.sh build_system_prompt / build_user_prompt) ─

export interface PromptContext {
  /**
   * Abstraction over where prompt layers come from. Used for fixed-topic
   * system prompts (bundled context files, agent instructions). Discovery
   * layers below still read the managed repo filesystem directly because
   * they are always per-repo content by nature.
   */
  readonly promptSource?: PromptSource;

  /**
   * Absolute path to a global context file (CLAUDE.md / AGENTS.md at the
   * managed repo root). Loaded verbatim as layer 1 when present.
   */
  readonly globalContextFile?: string;

  /**
   * Absolute path to the managed repo's `.operator/` directory. Used for
   * discovery layers (project context, role customizations, phase rules)
   * which are always file-backed per-repo content.
   */
  readonly automationDir: string;

  /**
   * Bundled context topic names to load via `promptSource`. Each name
   * resolves to topic `context/{name}` — e.g. `["base", "state"]` pulls
   * `agents/context/base.md` + `agents/context/state.md` (plus any
   * `.operator/agents/context/*.md` extensions).
   */
  readonly contextFiles: string[];

  /**
   * Topic key for the agent-specific instructions (layer 6). Typically
   * the role name — e.g. `"creator"` loads `agents/creator.md` through
   * `promptSource`. Omit when no role-specific prompt is required.
   */
  readonly instructionsTopic?: string;

  /** Role name for layer 4 (`.operator/{role}/*.md`) customizations. */
  readonly role?: string;
  /** Phase rules directory for layer 5 (`.operator/{rulesFrom}/*.md`). */
  readonly rulesFrom?: string;
  /** Path filter for layers 3 and 5 — only rules matching this path apply. */
  readonly contextPath?: string;
  /** Variables substituted in `{KEY}` placeholders across all layers. */
  readonly vars: Record<string, string>;
}

/**
 * Build the system prompt by assembling all context sources.
 *
 * Assembly order (matches V1 run-agent.sh build_system_prompt):
 * 1. Global context file (CLAUDE.md / AGENTS.md) — direct file read
 * 2. Bundled context files — loaded via `promptSource` (topic `context/{name}`)
 * 3. Project context files (`.operator/context/*.md`, filtered by contextPath) — discovery
 * 4. Role customizations (`.operator/{role}/*.md`) — discovery
 * 5. Phase rules (`.operator/{rulesFrom}/*.md`, filtered by path overlap) — discovery
 * 6. Agent instructions — loaded via `promptSource` (topic = role name)
 *
 * Layers 2 and 6 go through {@link PromptSource}, which concatenates
 * system-shipped prompts with optional per-repo extensions. Layers 3-5
 * stay as direct filesystem reads because they are discovery patterns
 * over arbitrarily many per-repo files — not single-topic lookups.
 *
 * All sections have {VAR} placeholders substituted from vars map.
 */
export async function buildSystemPrompt(ctx: PromptContext): Promise<string> {
  const parts: string[] = [];

  // 1. Global context
  if (ctx.globalContextFile) {
    try {
      parts.push(await readFile(ctx.globalContextFile, "utf-8"));
    } catch { /* missing file is not an error */ }
  }

  // 2. Bundled context files (listed in agents.yaml) — via PromptSource
  if (ctx.promptSource) {
    for (const name of ctx.contextFiles) {
      const chain = await ctx.promptSource.loadChain(`context/${name}`);
      if (chain) parts.push(chain);
    }
  }

  // 3. Project context (.operator/context/*.md) — discovery
  const projectCtxFiles = await listMdFiles(join(ctx.automationDir, "context"));
  for (const file of projectCtxFiles) {
    const content = await readFile(file, "utf-8");
    if (ctx.contextPath) {
      const filePath = parseFrontmatter(content, "path");
      if (filePath && !pathsOverlap(filePath, ctx.contextPath)) continue;
    }
    const body = getAgentBody(content);
    if (body) parts.push(body);
  }

  // 4. Role customizations (.operator/{role}/*.md) — discovery
  if (ctx.role) {
    const roleFiles = await listMdFiles(join(ctx.automationDir, ctx.role));
    for (const file of roleFiles) {
      const content = await readFile(file, "utf-8");
      const body = getAgentBody(content);
      if (body) parts.push(body);
    }
  }

  // 5. Phase rules (.operator/{rulesFrom}/*.md) — discovery with path overlap
  if (ctx.rulesFrom) {
    const matchedRules = await discoverMatchingRules(
      ctx.automationDir, ctx.rulesFrom, ctx.contextPath,
    );
    if (matchedRules.length > 0) {
      const merged = await mergeRuleBodies(matchedRules);
      if (merged) parts.push(merged);
    }
  }

  // 6. Agent instructions — via PromptSource, topic = instructionsTopic
  if (ctx.instructionsTopic && ctx.promptSource) {
    const chain = await ctx.promptSource.loadChain(ctx.instructionsTopic);
    if (chain) parts.push(chain);
  }

  return substituteVars(parts.join("\n\n"), ctx.vars);
}

export interface UserPromptContext {
  readonly taskContent?: string;
  readonly attempt: number;
  readonly maxRetries: number;
  readonly previousError?: string;
  readonly vars: Record<string, string>;
}

/**
 * Build the user prompt with task input and optional error context.
 * Ports run-agent.sh build_user_prompt().
 */
export function buildUserPrompt(ctx: UserPromptContext): string {
  const parts: string[] = [];

  if (ctx.taskContent) {
    parts.push(`## Task Input\n\n${ctx.taskContent}`);
  }

  if (ctx.attempt > 1 && ctx.previousError) {
    parts.push(
      `---\n\n## Previous Attempt Failed (Attempt ${ctx.attempt - 1}/${ctx.maxRetries})\n\n` +
      `**Error:**\n\`\`\`\n${ctx.previousError}\n\`\`\`\n\n` +
      `Please fix the issues above and try again.`,
    );
  }

  return substituteVars(parts.join("\n\n"), ctx.vars);
}
