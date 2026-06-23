import { z } from "zod";

/**
 * Agent-Orchestrator Protocol (AOP) — typed records the agent emits and the
 * orchestrator applies. The wire format is pluggable (text-block parser,
 * MCP server, future transports); engine internals consume this uniform
 * `AgentEvent` discriminated union regardless of how it was produced.
 *
 * Adding a new EMIT type:
 *   1. Add a `z.object({ type: z.literal("…") , … })` schema below.
 *   2. Add it to {@link agentEventSchema}'s discriminated union list.
 *   3. Add a Zod-validated branch in the applier (lands in F2 with
 *      `WorkItemSource`). Until the applier handles it, the parser
 *      surfaces the event but the orchestrator ignores it as
 *      `unsupported-event-type` for forward compatibility.
 */

/**
 * Spawn a new work item with the declared kind, parented to the active
 * item (`parent: "self"`) or any explicit work-item id. The orchestrator
 * routes through `WorkItemSource.fromKind(kind)` so file-backed and
 * virtual kinds are handled identically by stage code.
 */
export const emitChildItemSchema = z.object({
  type: z.literal("child-item"),
  kind: z.string().min(1),
  parent: z.string().min(1),
  title: z.string().min(1),
  body: z.string().default(""),
  priority: z.number().int().min(1).max(8).optional(),
  source: z.string().optional(),
  /**
   * Optional explicit id. When omitted the kind registry generates one
   * via the configured `idPrefix + dateSeq` scheme.
   */
  id: z.string().min(1).optional(),
});

/**
 * Transition a work item's lifecycle status. `target` is a work-item id
 * or `"self"` for the active item driving the stage.
 */
export const emitStatusUpdateSchema = z.object({
  type: z.literal("status-update"),
  target: z.string().min(1),
  status: z.string().min(1),
  reason: z.string().optional(),
});

/**
 * Replace or append-section the markdown body of a work item.
 */
export const emitBodyUpdateSchema = z.object({
  type: z.literal("body-update"),
  target: z.string().min(1),
  body: z.string(),
  mergeStrategy: z.enum(["replace", "append-section"]).default("replace"),
  sectionHeader: z.string().optional(),
});

/**
 * Attach a note to a work item — either internal-only (execution-events
 * row) or surfaced as a PR comment with bot-footer attribution.
 */
export const emitNoteSchema = z.object({
  type: z.literal("note"),
  target: z.string().min(1),
  visibility: z.enum(["internal", "pr-comment"]).default("internal"),
  body: z.string().min(1),
});

/**
 * Structured error with a stable `code` for programmatic handling.
 * `recoverable: false` forces the execution verdict to `failed`
 * regardless of any later `verdict` event.
 */
export const emitErrorSchema = z.object({
  type: z.literal("error"),
  code: z.string().min(1),
  message: z.string().min(1),
  recoverable: z.boolean().default(true),
});

/**
 * Enqueue retrospective recovery for a target. Phase 6 P-505 consumes
 * this to plan corrective work-items; emitted by stages and primitives
 * that detect a non-trivial failure mode (CI exhaustion, closed-without-
 * merge, agent-declined).
 */
export const emitRecoverySchema = z.object({
  type: z.literal("recovery"),
  target: z.string().min(1),
  action: z.string().min(1),
  context: z.string().optional(),
});

/**
 * Finalise the execution verdict. Also accepted as a free-text
 * `## Verdict: …` block by the legacy parser; both routes produce the
 * same {@link AgentEvent}.
 */
export const emitVerdictSchema = z.object({
  type: z.literal("verdict"),
  value: z.enum(["approved", "failed", "cancelled", "rejected"]),
  summary: z.string().optional(),
});

/**
 * The discriminated union the orchestrator consumes. Every transport
 * (text-block parser, MCP, future) produces exactly this shape.
 */
export const agentEventSchema = z.discriminatedUnion("type", [
  emitChildItemSchema,
  emitStatusUpdateSchema,
  emitBodyUpdateSchema,
  emitNoteSchema,
  emitErrorSchema,
  emitRecoverySchema,
  emitVerdictSchema,
]);

export type EmitChildItem = z.infer<typeof emitChildItemSchema>;
export type EmitStatusUpdate = z.infer<typeof emitStatusUpdateSchema>;
export type EmitBodyUpdate = z.infer<typeof emitBodyUpdateSchema>;
export type EmitNote = z.infer<typeof emitNoteSchema>;
export type EmitError = z.infer<typeof emitErrorSchema>;
export type EmitRecovery = z.infer<typeof emitRecoverySchema>;
export type EmitVerdict = z.infer<typeof emitVerdictSchema>;
export type AgentEvent = z.infer<typeof agentEventSchema>;

/**
 * EMIT type names — useful for diagnostics, logging, and stage YAML
 * `outputContract.allowedEmits` validation in F4 onward.
 */
export const AGENT_EVENT_TYPES = [
  "child-item",
  "status-update",
  "body-update",
  "note",
  "error",
  "recovery",
  "verdict",
] as const;

export type AgentEventType = (typeof AGENT_EVENT_TYPES)[number];
