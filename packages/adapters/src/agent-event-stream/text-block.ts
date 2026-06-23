import type {
  AgentEventStream,
  AgentEventParseResult,
} from "@operator/core";

/**
 * Function shape that turns an agent's raw stdout into a typed
 * `AgentEventParseResult`. Today's only implementation lives at
 * `engine/pipeline/primitives/agent-output-protocol.ts:parseAgentOutput`
 * (Phase 5.0 F1, hardened with the F3.5 raw-frontmatter guard). The
 * adapter receives it through dependency injection so this package
 * never imports from the `@operator/engine` workspace — keeping the
 * upward boundary clean per `intelligence/rules/typescript.md`.
 */
export type TextBlockParser = (rawOutput: string) => AgentEventParseResult;

/**
 * `AgentEventStream` adapter for CLI agents that emit fenced EMIT
 * blocks in their stdout (the F1 transport).
 *
 * Wraps a {@link TextBlockParser} function — typically the F1 parser
 * but the seam lets tests inject a fake without touching real parsing
 * logic. The adapter is stateless: callers can construct one per cycle
 * or share a singleton across cycles, both are equivalent.
 *
 * Phase 5.0 F3a — gated until F4 onward wires it into `runStage`.
 * `MCPEventStream` (F3b) will implement the same interface against
 * the operator MCP server so engine internals never branch on
 * transport.
 */
export class TextBlockEventStream implements AgentEventStream {
  constructor(private readonly parser: TextBlockParser) {}

  parse(rawOutput: string): AgentEventParseResult {
    return this.parser(rawOutput);
  }
}
