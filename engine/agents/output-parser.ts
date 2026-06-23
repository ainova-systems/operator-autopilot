import { parseFrontmatter, getAgentBody } from "./frontmatter.js";

/**
 * Supported output format types.
 * Ports format-content.sh format types.
 */
export type FormatType = "finding" | "task" | "comment" | "failure" | "improver";

/**
 * Required frontmatter fields per format type.
 * Ports format-content.sh verify_output().
 */
export const FORMAT_REQUIRED_FIELDS: Record<FormatType, readonly string[]> = {
  finding: ["id", "title", "type", "priority", "source", "status", "created_at"],
  task: ["id", "title", "priority", "status"],
  improver: ["week", "date", "analyzer"],
  comment: [],
  failure: [],
};

export interface ParsedOutput {
  readonly frontmatter: Record<string, string>;
  readonly body: string;
  readonly raw: string;
}

export interface ValidationError {
  readonly field: string;
  readonly message: string;
}

/**
 * Strip chain-of-thought preamble before YAML frontmatter.
 *
 * LLM agents sometimes dump reasoning text before the `---` frontmatter
 * delimiter. This function removes everything before the first `---` line.
 * Returns the content unchanged if it already starts with `---` or has no
 * frontmatter at all (to avoid destroying non-frontmatter output).
 */
export function stripPreamble(content: string): string {
  const lines = content.split("\n");
  if (lines[0].trim() === "---") return content;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") {
      return lines.slice(i).join("\n");
    }
  }
  return content;
}

/**
 * Strip wrapping markdown code fences from agent output.
 *
 * Agents sometimes wrap their response in ```markdown or ```yaml fences.
 * Ports format-content.sh code fence stripping.
 */
export function stripCodeFences(content: string): string {
  const lines = content.split("\n");
  if (lines.length < 2) return content;
  if (/^```\w*$/.test(lines[0].trim())) {
    const lastIdx = lines.length - 1;
    if (lines[lastIdx].trim() === "```") {
      return lines.slice(1, lastIdx).join("\n");
    }
    return lines.slice(1).join("\n");
  }
  return content;
}

/**
 * Parse all YAML frontmatter fields into a key-value map.
 */
export function parseFrontmatterMap(content: string): Record<string, string> {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return {};
  const result: Record<string, string> = {};
  for (const line of match[1].split("\n")) {
    const trimmed = line.trim();
    const colonIdx = trimmed.indexOf(":");
    if (colonIdx <= 0) continue;
    const key = trimmed.slice(0, colonIdx).trim();
    const value = trimmed.slice(colonIdx + 1).trim().replace(/^["']|["']$/g, "");
    result[key] = value;
  }
  return result;
}

/**
 * Verify that content has valid YAML frontmatter structure.
 *
 * Ports format-content.sh verify_frontmatter().
 */
export function hasFrontmatter(content: string): boolean {
  const lines = content.split("\n");
  if (lines[0].trim() !== "---") return false;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") return true;
  }
  return false;
}

/**
 * Validate output against format-specific required fields.
 *
 * Returns list of missing fields. Empty list = valid.
 * Ports format-content.sh verify_fields() + verify_output().
 */
export function validateRequiredFields(
  frontmatter: Record<string, string>,
  format: FormatType,
): ValidationError[] {
  const required = FORMAT_REQUIRED_FIELDS[format];
  const errors: ValidationError[] = [];
  for (const field of required) {
    if (!(field in frontmatter) || !frontmatter[field]) {
      errors.push({ field, message: `Missing required field: ${field}` });
    }
  }
  return errors;
}

/**
 * Extract markdown sections (## headings) from body.
 */
export function extractSections(body: string): Record<string, string> {
  const sections: Record<string, string> = {};
  const parts = body.split(/^## /m);
  for (const part of parts.slice(1)) {
    const newline = part.indexOf("\n");
    if (newline === -1) continue;
    const heading = part.slice(0, newline).trim();
    const content = part.slice(newline + 1).trim();
    sections[heading] = content;
  }
  return sections;
}

/**
 * Parse raw agent output into structured form.
 *
 * Combines: code fence stripping → frontmatter extraction → validation.
 * Returns parsed output with frontmatter map and body.
 *
 * Throws AgentError if format requires frontmatter and it's missing or invalid.
 */
export function parseAgentOutput(raw: string, format: FormatType): ParsedOutput {
  const stripped = stripPreamble(stripCodeFences(raw.trim()));
  const frontmatter = parseFrontmatterMap(stripped);
  const body = getAgentBody(stripped);

  const requiresFrontmatter = FORMAT_REQUIRED_FIELDS[format].length > 0;
  if (requiresFrontmatter && !hasFrontmatter(stripped)) {
    throw new Error(`${format} output requires YAML frontmatter but none found`);
  }

  const errors = validateRequiredFields(frontmatter, format);
  if (errors.length > 0) {
    const missing = errors.map((e) => e.field).join(", ");
    throw new Error(`${format} output missing required fields: ${missing}`);
  }

  return { frontmatter, body, raw: stripped };
}

/**
 * Extract a specific frontmatter value from raw content, with code fence stripping.
 * Convenience wrapper for pipeline stages that need a single field.
 */
export function extractField(raw: string, key: string): string | undefined {
  const stripped = stripPreamble(stripCodeFences(raw.trim()));
  return parseFrontmatter(stripped, key);
}
