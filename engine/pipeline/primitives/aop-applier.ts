import type {
  AgentEvent, AgentEventStream, AgentEventDiagnostic,
  EmitNote, EmitCommentReply, EmitError, EmitRecovery,
  KindRegistry, OperationContext, Priority,
  WorkItemKind, WorkItemRecord, WorkItemRef, WorkItemSource, WorkItemStatus,
} from "@operator/core";
import { errorMessage } from "@operator/core";
import type { Logger } from "../../logging/logger.js";
import type { Verdict } from "../types.js";
import { partitionDiagnostics } from "./agent-output-protocol.js";

/**
 * Generic Agent-Orchestrator Protocol applier — Phase 5.0 F4.
 *
 * Consumed by every stage that runs an LLM agent: takes the agent's raw
 * stdout, parses it into typed `AgentEvent` records via the injected
 * {@link AgentEventStream}, applies each record against the active
 * {@link WorkItemSource}, and returns a final {@link AopApplyResult} the
 * caller can fold into a `runStage` `AgentResult`.
 *
 * The applier is **kind-agnostic** — it never branches on the active
 * item's `kind`, dispatching every storage decision through `WorkItemSource`
 * (file-backed today, virtual under F9, future modes drop in without
 * touching this primitive). Stage code's only contribution is the
 * `outputContract` declared on the {@link StageDef} — the allowed EMIT
 * types and a verdict map — both consumed by the caller, not by the
 * applier itself. This keeps the boundary clean: agents express intent
 * via EMIT, the orchestrator owns every storage write.
 *
 * What this primitive does NOT do:
 *
 *   - Post PR comments (the caller forwards `notes` with
 *     `visibility: "pr-comment"` to the stage's `PRManager`).
 *   - Write `execution-events/{id}/{seq}` rows (the caller forwards
 *     `notes`, `errors`, and `recoveries` to the stage's
 *     `ExecutionHistory` writer).
 *   - Decide on label transitions (those flow from the verdict and
 *     `StagePersistInput.onSuccess`, set by `buildPR`).
 *
 * Keeping side-effects out of the applier means tests can drive it with
 * a fake `WorkItemSource` and assert on the structured result without
 * mocking PR or KV layers.
 */

/** Inputs the applier needs to resolve `parent: "self"` and generate ids. */
export interface AopActiveContext {
  /**
   * Work item driving the stage (for `target: "self"` resolution and
   * for parenting child items emitted with `parent: "self"`). Optional —
   * stages with `branchScope: "singleton"` (init, research) have no
   * active item; the applier rejects `self` references in that case.
   */
  readonly workItem?: WorkItemRef;
  /**
   * Default date string (YYYYMMDD) used when an `EMIT child-item` omits
   * an explicit `id` — the kind registry mints `{idPrefix}{date}-{hex}`
   * via `KindRegistry.generateId(kind, date)`. Defaults to today.
   */
  readonly date?: string;
}

/** Dependencies for a single applier invocation. */
export interface AopApplierDeps {
  /** Transport adapter (TextBlock today, MCP under F3b). */
  readonly stream: AgentEventStream;
  /**
   * `WorkItemSource` for the kind owning the active stage. Phase 5.0
   * routes through `WorkItemSourceRouter.forKind` once F9 lands wiring;
   * for F4 the composition root constructs a single file-backed source
   * because every stage migrating in F4–F8 owns a file-backed kind
   * (finding/task/finding-via-research). Virtual kinds (retrospective-
   * cycle, agent-improvement) become applier consumers in F7+.
   */
  readonly source: WorkItemSource;
  /**
   * Kind registry — used to mint ids for `child-item` records that omit an
   * explicit `id`. Same registry instance `entry.ts` uses; injection is for
   * testability.
   */
  readonly registry: KindRegistry;
  readonly log?: Logger;
}

/** Detail of a single failed event-application — surfaced to the caller. */
export interface AopApplyError {
  readonly event: AgentEvent;
  readonly code: string;
  readonly message: string;
}

/** Pure result of applying parsed events. */
export interface AopApplyResult {
  /**
   * Verdict resolved from the events:
   *
   *   - `failed` if the parser surfaced any error diagnostic, OR any
   *     `EMIT error` event was non-recoverable, OR an EMIT-applied write
   *     to the WorkItemSource threw.
   *   - The `value` from a single `EMIT verdict` event when the agent
   *     declared one and no failures intervened.
   *   - `approved` otherwise (events applied cleanly, agent did not
   *     declare a verdict — caller may override via stage-specific
   *     post-processing).
   *
   * Callers that need stage-specific verdict logic (finding-plan: VALID
   * + at-least-one-task → approved; VALID + zero-tasks → failed) are
   * free to override after inspecting `applied.childItems`.
   */
  readonly verdict: Verdict;
  /** One-line summary derived from the events; caller may override. */
  readonly summary: string;
  /** Typed events the parser emitted, in order. */
  readonly events: ReadonlyArray<AgentEvent>;
  /** Diagnostics the parser emitted (errors + warnings). */
  readonly diagnostics: ReadonlyArray<AgentEventDiagnostic>;
  /** Records the applier successfully wrote to the WorkItemSource. */
  readonly applied: {
    readonly childItems: ReadonlyArray<WorkItemRecord>;
    readonly statusUpdates: ReadonlyArray<WorkItemRef>;
    readonly bodyUpdates: ReadonlyArray<WorkItemRef>;
  };
  /** Pass-through events the caller surfaces to PR / execution-history. */
  readonly notes: ReadonlyArray<EmitNote>;
  /**
   * Per-inline-review-thread dispositions the agent produced. The applier
   * only collects them (like {@link notes}); the caller posts the note as a
   * threaded reply and resolves bot-authored threads. Empty for stages that
   * do not answer review threads.
   */
  readonly commentReplies: ReadonlyArray<EmitCommentReply>;
  readonly errors: ReadonlyArray<EmitError>;
  readonly recoveries: ReadonlyArray<EmitRecovery>;
  /** Per-event application failures — included in the `failed` verdict path. */
  readonly applyErrors: ReadonlyArray<AopApplyError>;
}

/**
 * Apply the agent's output as a sequence of AOP records.
 *
 * Pure-ish (the WorkItemSource calls are I/O the caller injects) and
 * deterministic for a given (rawOutput + deps) pair.
 */
export async function applyAgentEvents(
  rawOutput: string,
  deps: AopApplierDeps,
  active: AopActiveContext,
  ctx: OperationContext,
): Promise<AopApplyResult> {
  const parseResult = deps.stream.parse(rawOutput);
  const { errors: parseErrors } = partitionDiagnostics(parseResult.diagnostics);

  const childItems: WorkItemRecord[] = [];
  const statusUpdates: WorkItemRef[] = [];
  const bodyUpdates: WorkItemRef[] = [];
  const notes: EmitNote[] = [];
  const commentReplies: EmitCommentReply[] = [];
  const errorEvents: EmitError[] = [];
  const recoveries: EmitRecovery[] = [];
  const applyErrors: AopApplyError[] = [];
  let verdictFromEvent: Verdict | null = null;
  let verdictSummary: string | null = null;
  let nonRecoverableErrorMessage: string | null = null;

  // Application loop — each branch is independent so one failure does
  // not abort later events. Caller decides how to surface partial
  // failures via `applyErrors` + the resolved `verdict`.
  for (const event of parseResult.events) {
    try {
      switch (event.type) {
        case "child-item": {
          const kind = event.kind as WorkItemKind;
          const id = event.id ?? (await deps.registry.generateId(kind, active.date));
          // `parent` is optional: discovery findings are top-level (no parent).
          // Resolve it only when the agent supplied one.
          const parentId = event.parent ? resolveTarget(event.parent, active.workItem) : undefined;
          const record: WorkItemRecord = {
            id,
            kind,
            title: event.title,
            body: event.body,
            status: "pending" as WorkItemStatus,
            priority: (event.priority ?? 5) as Priority,
            createdAt: nowIso(),
            parentId,
            ...(event.source ? { source: event.source } : {}),
          };
          const created = await deps.source.create(record, ctx);
          childItems.push(created);
          deps.log?.info(`aop-applier: created child-item ${created.id} (kind=${kind}, parent=${parentId ?? "(root)"})`, {
            scope: "aop-applier", emitType: "child-item",
            childId: created.id, kind, parentId,
          });
          break;
        }
        case "status-update": {
          const ref: WorkItemRef = {
            id: resolveTarget(event.target, active.workItem),
            kind: kindForTarget(event.target, active.workItem, deps.registry),
          };
          await deps.source.updateStatus(ref, event.status as WorkItemStatus, event.reason, ctx);
          statusUpdates.push(ref);
          deps.log?.info(`aop-applier: status-update ${ref.id} → ${event.status}${event.reason ? ` (${event.reason})` : ""}`, {
            scope: "aop-applier", emitType: "status-update",
            target: ref.id, status: event.status, reason: event.reason,
          });
          break;
        }
        case "body-update": {
          const ref: WorkItemRef = {
            id: resolveTarget(event.target, active.workItem),
            kind: kindForTarget(event.target, active.workItem, deps.registry),
          };
          await deps.source.updateBody(ref, event.body, event.mergeStrategy, event.sectionHeader, ctx);
          bodyUpdates.push(ref);
          deps.log?.info(`aop-applier: body-update ${ref.id} (${event.mergeStrategy})`, {
            scope: "aop-applier", emitType: "body-update",
            target: ref.id, mergeStrategy: event.mergeStrategy,
          });
          break;
        }
        case "note": {
          notes.push(event);
          deps.log?.debug(`aop-applier: note (${event.visibility}) for ${event.target}`, {
            scope: "aop-applier", emitType: "note",
            target: event.target, visibility: event.visibility,
          });
          break;
        }
        case "comment-reply": {
          commentReplies.push(event);
          deps.log?.debug(`aop-applier: comment-reply (${event.disposition}) for thread ${event.thread}`, {
            scope: "aop-applier", emitType: "comment-reply",
            thread: event.thread, disposition: event.disposition,
          });
          break;
        }
        case "error": {
          errorEvents.push(event);
          deps.log?.warn(`aop-applier: error event ${event.code}: ${event.message} (recoverable=${event.recoverable})`, {
            scope: "aop-applier", emitType: "error",
            code: event.code, recoverable: event.recoverable,
          });
          if (!event.recoverable) {
            nonRecoverableErrorMessage = `${event.code}: ${event.message}`;
          }
          break;
        }
        case "recovery": {
          recoveries.push(event);
          deps.log?.info(`aop-applier: recovery enqueued for ${event.target} (${event.action})`, {
            scope: "aop-applier", emitType: "recovery",
            target: event.target, action: event.action,
          });
          break;
        }
        case "verdict": {
          verdictFromEvent = event.value;
          verdictSummary = event.summary ?? null;
          deps.log?.info(`aop-applier: verdict ${event.value}${event.summary ? ` — ${event.summary}` : ""}`, {
            scope: "aop-applier", emitType: "verdict",
            verdict: event.value, summary: event.summary,
          });
          break;
        }
      }
    } catch (err) {
      const detail: AopApplyError = {
        event,
        code: err instanceof Error && "code" in err && typeof (err as { code: unknown }).code === "string"
          ? String((err as { code: string }).code)
          : "APPLY_FAILED",
        message: errorMessage(err),
      };
      applyErrors.push(detail);
      deps.log?.error(`aop-applier: failed to apply ${event.type}: ${detail.message}`, {
        scope: "aop-applier", emitType: event.type, code: detail.code,
      });
    }
  }

  // Verdict resolution — see {@link AopApplyResult.verdict} contract.
  let verdict: Verdict;
  let summaryParts: string[];
  if (parseErrors.length > 0) {
    verdict = "failed";
    summaryParts = [`AOP parse: ${parseErrors.length} error diagnostic(s)`];
  } else if (applyErrors.length > 0) {
    verdict = "failed";
    summaryParts = [`AOP apply: ${applyErrors.length} event(s) failed (${applyErrors[0].code})`];
  } else if (nonRecoverableErrorMessage) {
    verdict = "failed";
    summaryParts = [`agent emitted non-recoverable error — ${nonRecoverableErrorMessage}`];
  } else if (verdictFromEvent) {
    verdict = verdictFromEvent;
    summaryParts = [verdictSummary ?? `verdict: ${verdictFromEvent}`];
  } else {
    verdict = "approved";
    summaryParts = [verdictSummary ?? "no verdict event — defaulting to approved"];
  }

  // Append a compact application summary so the operator log line is
  // self-contained ("verdict + 3 children + 1 status-update" beats
  // "verdict only" for triage).
  const tally: string[] = [];
  if (childItems.length > 0) tally.push(`${childItems.length} child-item(s)`);
  if (statusUpdates.length > 0) tally.push(`${statusUpdates.length} status-update(s)`);
  if (bodyUpdates.length > 0) tally.push(`${bodyUpdates.length} body-update(s)`);
  if (notes.length > 0) tally.push(`${notes.length} note(s)`);
  if (commentReplies.length > 0) tally.push(`${commentReplies.length} comment-reply(ies)`);
  if (errorEvents.length > 0) tally.push(`${errorEvents.length} error event(s)`);
  if (recoveries.length > 0) tally.push(`${recoveries.length} recovery event(s)`);
  if (tally.length > 0) summaryParts.push(`applied: ${tally.join(", ")}`);

  return {
    verdict,
    summary: summaryParts.join(" — "),
    events: parseResult.events,
    diagnostics: parseResult.diagnostics,
    applied: { childItems, statusUpdates, bodyUpdates },
    notes,
    commentReplies,
    errors: errorEvents,
    recoveries,
    applyErrors,
  };
}

/**
 * Resolve a `target` string from an EMIT record into a concrete
 * work-item id. The literal `"self"` resolves to the active stage's
 * driving work-item id; any other value is treated as an explicit id.
 *
 * Throws when `target === "self"` but no active item is in scope —
 * stages with `branchScope: "singleton"` (init, research) have no
 * active item and an agent should never emit `self` from one of them.
 */
function resolveTarget(target: string, activeItem: WorkItemRef | undefined): string {
  if (target === "self") {
    if (!activeItem) {
      throw new Error(
        `EMIT target "self" rejected — applier has no active work-item in scope (singleton-scope stage?)`,
      );
    }
    return activeItem.id;
  }
  return target;
}

/**
 * Resolve the `kind` of an EMIT target. For `"self"` we trust the active
 * item's kind. For an explicit id we cannot tell from the id alone, so
 * we fall back to the active item's kind when present (every stage
 * migrating in F4–F8 emits cross-kind status / body updates only via
 * `child-item` creation, never via direct `target: "T..."` writes from
 * sibling kinds — the planner emits child tasks but never status-updates
 * those tasks). Stages that legitimately need cross-kind writes (the
 * Phase 6 retrospective recovery flow) supply an explicit kind in the
 * EMIT payload schema; until then this fallback is conservative.
 */
function kindForTarget(
  target: string,
  activeItem: WorkItemRef | undefined,
  _registry: KindRegistry,
): WorkItemKind {
  if (target === "self") {
    if (!activeItem) {
      throw new Error(
        `EMIT target "self" rejected — applier has no active work-item in scope`,
      );
    }
    return activeItem.kind;
  }
  // For explicit ids we conservatively trust the active item's kind. The
  // EMIT schema will gain an explicit `kind` field in the recovery flow
  // (Phase 6 P-505) — at that point this branch becomes a real lookup.
  if (!activeItem) {
    throw new Error(
      `EMIT target "${target}" — cannot infer kind without an active work-item; emit a recovery record instead`,
    );
  }
  return activeItem.kind;
}

function nowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}
