import type { AgentEvent } from "../schemas/agent-event.schema.js";

/**
 * Severity of a parser diagnostic. Errors mean the surrounding block
 * was discarded; warnings are informational and the surrounding events
 * may still flow through.
 */
export type AgentEventDiagnosticSeverity = "error" | "warning";

/**
 * Stable diagnostic codes the parser can emit. Each code is documented
 * once at the call site that emits it; this union keeps tooling (logs,
 * UI badges, runStage routing) free of magic-string drift.
 */
export type AgentEventDiagnosticCode =
  | "block-unclosed"
  | "yaml-parse-error"
  | "payload-not-mapping"
  | "unknown-emit-type"
  | "validation-failed"
  | "raw-frontmatter-leak";

/**
 * Single diagnostic emitted while transforming an agent's raw output
 * into typed `AgentEvent` records. `line` is 1-based and points at the
 * offending start marker (or fence) so log output and UI surfaces can
 * link straight at the problem.
 */
export interface AgentEventDiagnostic {
  readonly severity: AgentEventDiagnosticSeverity;
  readonly code: AgentEventDiagnosticCode;
  readonly line: number;
  readonly emitType?: string;
  readonly message: string;
}

/**
 * Output of an `AgentEventStream.parse(rawOutput)` call: the typed
 * events that survived validation alongside any structured diagnostics
 * the orchestrator should surface. Both lists are read-only — callers
 * filter / partition them, never mutate.
 */
export interface AgentEventParseResult {
  readonly events: ReadonlyArray<AgentEvent>;
  readonly diagnostics: ReadonlyArray<AgentEventDiagnostic>;
}
