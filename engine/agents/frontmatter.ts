import { basename } from "node:path";

/**
 * Parse a YAML frontmatter property from markdown content.
 *
 * Ports agents.sh parse_frontmatter().
 */
export function parseFrontmatter(content: string, key: string): string | undefined {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return undefined;
  const fm = match[1];
  for (const line of fm.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith(`${key}:`)) {
      return trimmed.slice(key.length + 1).trim().replace(/^["']|["']$/g, "");
    }
  }
  return undefined;
}

/**
 * Get the body of a markdown file (everything after the second `---`).
 *
 * Ports agents.sh get_agent_body().
 */
export function getAgentBody(content: string): string {
  const parts = content.split(/^---$/m);
  if (parts.length < 3) return "";
  return parts.slice(2).join("---").trim();
}

/**
 * Get agent name from file path (basename without .md extension).
 *
 * Ports agents.sh get_agent_name().
 */
export function getAgentName(filePath: string): string {
  return basename(filePath, ".md");
}
