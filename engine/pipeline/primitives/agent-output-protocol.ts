import { load as yamlLoad } from "js-yaml";
import {
  agentEventSchema,
  AGENT_EVENT_TYPES,
  type AgentEvent,
  type AgentEventDiagnostic,
  type AgentEventParseResult,
  type AgentEventType,
} from "@operator/core";

/**
 * Agent-Orchestrator Protocol (AOP) — text-block transport.
 *
 * Agents emit fenced blocks in their stdout:
 *
 *   === EMIT child-item ===
 *   kind: task
 *   parent: F20260502-0001
 *   title: "Add unit tests for hospitals search"
 *   priority: 3
 *   body: |
 *     Multi-line body
 *     with acceptance criteria.
 *   === END EMIT ===
 *
 * The parser reconstructs typed {@link AgentEvent} records from these
 * blocks. It is the **fallback** transport for CLI agents without MCP
 * support and for fixture-based tests; the preferred transport (MCP
 * server, F3) produces the exact same `AgentEvent` shape, so engine
 * internals never branch on transport.
 *
 * Forward-compatibility: unknown EMIT type names produce a
 * `unknown-emit-type` diagnostic and are skipped — older orchestrators
 * never crash on payloads from a newer agent.
 *
 * No consumer wired in F1. F4 onward (per-stage migrations) and F3
 * (MCP transport) consume this primitive directly. ts-prune treats
 * the colocated test as a consumer for module-reachability purposes.
 */

const START_MARKER = /^===\s*EMIT\s+([a-zA-Z][a-zA-Z0-9-]*)\s*===\s*$/;
const END_MARKER = /^===\s*END EMIT\s*===\s*$/;
/**
 * Frontmatter ownership boundary: agents NEVER directly create / update /
 * delete YAML frontmatter on work-item files. Status flips, parent linkage,
 * timestamps, etc. are the orchestrator's exclusive responsibility — the
 * agent expresses intent through {@link AgentEvent} EMIT records and the
 * orchestrator applies them via primitives.
 *
 * This regex catches the most common leak: an agent dumping a raw `---`
 * fence followed by a work-item-shaped frontmatter field (`status:`,
 * `id:`, `kind:`, `parent_id:`, …) into stdout. Matching anywhere on the
 * non-EMIT lines triggers a `raw-frontmatter-leak` diagnostic; the
 * surrounding stage treats it as a hard failure so the agent's prompt
 * gets corrected (rather than the orchestrator silently absorbing what
 * looks like a legitimate file body).
 */
const FENCE_MARKER = /^---\s*$/;
const FRONTMATTER_FIELD_MARKER = /^(status|id|kind|priority|parent_id|created_at|started_at|completed_at|depends_on)\s*:/;
/** How many lines after a `---` fence we look for a frontmatter field
 *  before giving up — a real frontmatter block always declares its
 *  fields in the first few lines. */
const FRONTMATTER_LOOKAHEAD = 6;

const KNOWN_TYPES = new Set<string>(AGENT_EVENT_TYPES);

/**
 * Parse the agent's stdout into a stream of {@link AgentEvent} records.
 *
 * Free-form text outside EMIT blocks is ignored. Diagnostics are
 * accumulated in order; one malformed block does not abort parsing of
 * later blocks.
 */
export function parseAgentOutput(text: string): AgentEventParseResult {
  const events: AgentEvent[] = [];
  const diagnostics: AgentEventDiagnostic[] = [];
  const lines = text.split(/\r?\n/);

  let i = 0;
  while (i < lines.length) {
    const startMatch = lines[i].match(START_MARKER);
    if (!startMatch) {
      // Free text outside an EMIT block. Before skipping, check the
      // frontmatter-leak boundary: a `---` fence followed shortly by a
      // work-item frontmatter field is the agent leaking authorship of
      // status/lifecycle data into stdout — surface a hard error so
      // the prompt gets corrected. False-positive risk is low: the
      // regex requires both the fence and a known field name within
      // FRONTMATTER_LOOKAHEAD lines.
      if (FENCE_MARKER.test(lines[i])) {
        for (let j = i + 1; j < Math.min(i + 1 + FRONTMATTER_LOOKAHEAD, lines.length); j++) {
          if (FRONTMATTER_FIELD_MARKER.test(lines[j])) {
            const fieldName = lines[j].split(":")[0].trim();
            diagnostics.push({
              severity: "error",
              code: "raw-frontmatter-leak",
              line: i + 1,
              message: `Raw frontmatter detected at line ${i + 1} (field "${fieldName}" at line ${j + 1}). Agents must not write work-item frontmatter; emit a typed AOP record instead (e.g. EMIT child-item / EMIT status-update).`,
            });
            break;
          }
        }
      }
      i++;
      continue;
    }
    const emitType = startMatch[1];
    const startLine = i + 1;
    const buffer: string[] = [];
    i++;
    let closed = false;
    while (i < lines.length) {
      if (END_MARKER.test(lines[i])) {
        closed = true;
        i++;
        break;
      }
      buffer.push(lines[i]);
      i++;
    }
    if (!closed) {
      diagnostics.push({
        severity: "error",
        code: "block-unclosed",
        line: startLine,
        emitType,
        message: `EMIT ${emitType} block opened at line ${startLine} but never closed`,
      });
      continue;
    }
    if (!KNOWN_TYPES.has(emitType)) {
      diagnostics.push({
        severity: "warning",
        code: "unknown-emit-type",
        line: startLine,
        emitType,
        message: `Unknown EMIT type "${emitType}" — skipped (forward-compat)`,
      });
      continue;
    }

    let payload: unknown;
    try {
      payload = yamlLoad(buffer.join("\n"));
      if (payload === null || payload === undefined) payload = {};
    } catch (err) {
      // Strict YAML rejected the block. The dominant cause is a free-text
      // field carrying an unquoted colon-space — a `comment-reply` `note:`
      // that quotes code ("named argument: …") or a method signature —
      // which js-yaml reads as a nested mapping key and throws on. That
      // discarded the whole record and forced the stage verdict to `failed`
      // even when the underlying fix was fine (PRs #1240/#1241, 2026-07-08).
      // Fall back to a lenient key/value re-parse before giving up so the
      // record survives as a non-fatal warning instead of a hard error.
      const recovered = lenientParseBlock(buffer);
      if (!recovered) {
        diagnostics.push({
          severity: "error",
          code: "yaml-parse-error",
          line: startLine,
          emitType,
          message: `YAML parse error in EMIT ${emitType}: ${err instanceof Error ? err.message : String(err)}`,
        });
        continue;
      }
      payload = recovered;
      diagnostics.push({
        severity: "warning",
        code: "lenient-recovery",
        line: startLine,
        emitType,
        message: `EMIT ${emitType} was not valid YAML (${err instanceof Error ? err.message : String(err)}); recovered via lenient key/value parse — quote or block-scalar (\`note: |\`) free-text fields to avoid this`,
      });
    }
    if (typeof payload !== "object" || Array.isArray(payload)) {
      diagnostics.push({
        severity: "error",
        code: "payload-not-mapping",
        line: startLine,
        emitType,
        message: `EMIT ${emitType} payload must be a YAML mapping (got ${Array.isArray(payload) ? "array" : typeof payload})`,
      });
      continue;
    }

    const candidate = { type: emitType as AgentEventType, ...(payload as object) };
    const validation = agentEventSchema.safeParse(candidate);
    if (!validation.success) {
      const issues = validation.error.issues
        .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
        .join("; ");
      diagnostics.push({
        severity: "error",
        code: "validation-failed",
        line: startLine,
        emitType,
        message: `EMIT ${emitType} validation failed — ${issues}`,
      });
      continue;
    }
    events.push(validation.data);
  }

  return { events, diagnostics };
}

/** Matches a top-level `key:` line (key at column 0, value optional). */
const LENIENT_KEY_LINE = /^([A-Za-z_][A-Za-z0-9_-]*):(?:[ \t]+(.*))?$/;
/** Matches a YAML block-scalar indicator (`|`, `|-`, `>`, `>+`, …). */
const BLOCK_SCALAR_INDICATOR = /^[|>][+-]?$/;

/**
 * Lenient fallback for a block whose body strict YAML rejected. AOP block
 * bodies are flat `key: value` mappings, so the one structural shape that
 * trips a well-formed block is an unquoted scalar value that itself contains
 * a colon-space. This re-parser keeps YAML as the primary path and only runs
 * on a YAML throw: it reads each top-level `key:` line and takes the whole
 * remainder of the line as the value (so an embedded colon is preserved),
 * while still honouring `key: |` / `key: >` block scalars so multi-line
 * bodies in a mixed block survive too. Values that look like a YAML integer
 * or boolean are coerced so numeric fields (e.g. child-item `priority`)
 * validate exactly as they would on the strict path.
 *
 * Returns `null` when no `key:` line was found — genuinely malformed output
 * (unclosed flow collections, ASCII garbage) then falls through to the
 * original `yaml-parse-error` rather than being masked.
 */
function lenientParseBlock(lines: ReadonlyArray<string>): Record<string, unknown> | null {
  const out: Record<string, unknown> = {};
  let matched = false;
  let i = 0;
  while (i < lines.length) {
    const keyMatch = lines[i].match(LENIENT_KEY_LINE);
    if (!keyMatch) {
      i++;
      continue;
    }
    matched = true;
    const key = keyMatch[1];
    const inline = (keyMatch[2] ?? "").trim();
    if (BLOCK_SCALAR_INDICATOR.test(inline)) {
      i++;
      const collected: string[] = [];
      let indent: number | null = null;
      while (i < lines.length) {
        const line = lines[i];
        if (line.trim() === "") {
          collected.push("");
          i++;
          continue;
        }
        const lead = line.length - line.trimStart().length;
        if (lead === 0) break;
        if (indent === null) indent = lead;
        collected.push(line.slice(Math.min(indent, lead)));
        i++;
      }
      // Clip trailing blank lines but keep one newline, matching js-yaml's
      // `|` block-scalar semantics the strict path would have produced.
      out[key] = `${collected.join("\n").replace(/\n+$/, "")}\n`;
    } else {
      out[key] = coerceScalar(stripSurroundingQuotes(inline));
      i++;
    }
  }
  return matched ? out : null;
}

/** Strip a single pair of matching surrounding quotes, if present. */
function stripSurroundingQuotes(value: string): string {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1);
    }
  }
  return value;
}

/**
 * Coerce a bare scalar to the type strict YAML would have inferred, so the
 * lenient path feeds Zod the same shapes: integers → number, `true`/`false`
 * → boolean, everything else stays a string.
 */
function coerceScalar(value: string): unknown {
  if (value === "true") return true;
  if (value === "false") return false;
  if (/^-?\d+$/.test(value)) return Number(value);
  return value;
}

/**
 * Split parse diagnostics by severity — convenience for callers that
 * want to fail fast on errors and surface warnings separately.
 */
export function partitionDiagnostics(
  diagnostics: ReadonlyArray<AgentEventDiagnostic>,
): {
  readonly errors: ReadonlyArray<AgentEventDiagnostic>;
  readonly warnings: ReadonlyArray<AgentEventDiagnostic>;
} {
  const errors: AgentEventDiagnostic[] = [];
  const warnings: AgentEventDiagnostic[] = [];
  for (const d of diagnostics) {
    (d.severity === "error" ? errors : warnings).push(d);
  }
  return { errors, warnings };
}
