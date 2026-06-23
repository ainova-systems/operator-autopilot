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
      diagnostics.push({
        severity: "error",
        code: "yaml-parse-error",
        line: startLine,
        emitType,
        message: `YAML parse error in EMIT ${emitType}: ${err instanceof Error ? err.message : String(err)}`,
      });
      continue;
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
