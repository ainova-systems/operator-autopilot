import { load as yamlLoad } from "js-yaml";
import { AgentError } from "@operator/core";

/**
 * One YAML-frontmatter document extracted from an agent stdout.
 *
 * `frontmatter` is the parsed object between the two `---` fences;
 * `body` is everything after the closing fence, trimmed of trailing
 * whitespace. Both are raw — callers run their own kind-specific
 * validation (required fields, id format, etc.).
 */
export interface FrontmatterDoc {
  readonly frontmatter: Record<string, unknown>;
  readonly body: string;
}

export interface ParsedAgentOutput {
  readonly documents: FrontmatterDoc[];
}

export type OutputParserMode =
  | "single-document"
  | "multi-document"
  | "code-changes"
  | "structured-report";

/**
 * Normalise an agent stdout into structured output per parser mode.
 *
 * - `single-document` / `structured-report` — expect exactly one
 *   frontmatter document; anything else throws `AgentError`.
 * - `multi-document` — expects one or more `---\n<yaml>\n---\n<body>`
 *   blocks separated by `---`. Zero documents is valid for a no-op run
 *   (e.g. discovery stage that finds nothing).
 * - `code-changes` — agent used Edit/Write tools; stdout is narration
 *   and the runner inspects the workspace diff separately. Always
 *   returns `{ documents: [] }`.
 *
 * Throws on malformed YAML frontmatter or wrong document count for
 * single-shot modes.
 */
export function parseAgentOutput(
  rawOutput: string,
  parser: OutputParserMode,
): ParsedAgentOutput {
  switch (parser) {
    case "code-changes":
      return { documents: [] };

    case "single-document":
    case "structured-report": {
      const docs = extractFrontmatterDocs(rawOutput);
      if (docs.length !== 1) {
        throw new AgentError(
          "OUTPUT_PARSE_FAILED",
          `${parser}: expected exactly 1 frontmatter document, got ${docs.length}`,
        );
      }
      return { documents: docs };
    }

    case "multi-document":
      return { documents: extractFrontmatterDocs(rawOutput) };
  }
}

/**
 * Walk the raw agent output and lift every `---\n<yaml>\n---\n<body>`
 * block into a {@link FrontmatterDoc}. Text outside a block (preamble,
 * inter-document narration) is ignored — agents often emit chatter
 * around the structured blocks.
 *
 * The function is lenient about leading whitespace and supports both
 * LF and CRLF line endings; YAML parse errors are surfaced as
 * {@link AgentError} with the offending block excerpt.
 */
function extractFrontmatterDocs(raw: string): FrontmatterDoc[] {
  const text = raw.replace(/\r\n/g, "\n");
  const lines = text.split("\n");
  const docs: FrontmatterDoc[] = [];

  let i = 0;
  while (i < lines.length) {
    if (!isFenceLine(lines[i])) {
      i++;
      continue;
    }

    const frontmatterStart = i + 1;
    let frontmatterEnd = -1;
    for (let j = frontmatterStart; j < lines.length; j++) {
      if (isFenceLine(lines[j])) {
        frontmatterEnd = j;
        break;
      }
    }
    if (frontmatterEnd === -1) {
      throw new AgentError(
        "OUTPUT_PARSE_FAILED",
        `frontmatter block opened at line ${i + 1} but never closed`,
      );
    }

    const yamlText = lines.slice(frontmatterStart, frontmatterEnd).join("\n");
    let frontmatter: Record<string, unknown>;
    try {
      const parsed = yamlLoad(yamlText);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("frontmatter must be a YAML mapping");
      }
      frontmatter = parsed as Record<string, unknown>;
    } catch (err) {
      throw new AgentError(
        "OUTPUT_PARSE_FAILED",
        `invalid YAML frontmatter at line ${frontmatterStart + 1}: ${(err as Error).message}`,
        { cause: err as Error },
      );
    }

    const bodyStart = frontmatterEnd + 1;
    const nextFence = findNextFence(lines, bodyStart);
    const bodyEnd = nextFence === -1 ? lines.length : nextFence;
    const body = lines.slice(bodyStart, bodyEnd).join("\n").trim();

    docs.push({ frontmatter, body });
    i = bodyEnd;
  }

  return docs;
}

function isFenceLine(line: string): boolean {
  return line.trim() === "---";
}

function findNextFence(lines: string[], from: number): number {
  for (let i = from; i < lines.length; i++) {
    if (isFenceLine(lines[i])) return i;
  }
  return -1;
}
