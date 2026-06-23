import type { AgentEventParseResult } from "../types/agent-event-stream.js";

/**
 * Transport-agnostic adapter that turns an agent's raw output into a
 * typed stream of `AgentEvent` records.
 *
 * Two implementations are planned:
 *
 *   - `TextBlockEventStream` (Phase 5.0 F3a, `@operator/adapters`) —
 *     wraps the F1 fenced-block parser. Used today for any CLI agent
 *     that writes EMIT records to stdout.
 *   - `MCPEventStream` (Phase 5.0 F3b, future) — wraps the operator
 *     MCP server. Each EMIT type maps to one MCP tool the agent calls
 *     directly; the stream surfaces those tool calls as the same
 *     `AgentEvent` shape so engine internals never branch on transport.
 *
 * `runStage` (and per-stage AOP appliers from F4 onward) consume this
 * interface — they never import `parseAgentOutput` directly. That
 * keeps the parser swap-out for MCP a one-line change in `entry.ts`.
 */
export interface AgentEventStream {
  /**
   * Parse a raw agent output (typically the agent process's stdout)
   * into typed events plus diagnostics. Pure: no I/O, no mutation,
   * idempotent on identical input.
   */
  parse(rawOutput: string): AgentEventParseResult;
}
