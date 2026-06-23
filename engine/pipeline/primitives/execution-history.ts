import type {
  OperationContext,
  KVStore,
  ExecutionEntry,
  ExecutionEventEntry,
  ExecutionLogEntry,
} from "@operator/core";
import { stampWorkItem } from "../../work-items/work-items.js";

/**
 * Execution history primitive (Step 14).
 *
 * Thin wrapper around `KVStore` that encapsulates the three execution-history
 * categories. `runStage` instantiates one {@link ExecutionHistoryWriter} per
 * stage run and emits: one `executions/{id}` row at start, N
 * `execution-events/{id}/{seq}` rows as primitives progress, one
 * `execution-logs/{id}` row at end, and a final `executions/{id}` update
 * with `finishedAt` / `verdict` / `summary`.
 *
 * See architecture-v5.md §7 for the schema.
 */

/** Minimal KV surface. Keeps the primitive testable without dragging the full
 * `KVStore` interface into unit tests. */
export type ExecutionKV = Pick<KVStore, "get" | "put">;

/** Format the sequence key for an execution event (`0000`, `0001`, ...). */
function formatSeq(n: number): string {
  return n.toString().padStart(4, "0");
}

/** Detect a structured-event options object vs a legacy `payload`. */
function isEventOptions(v: unknown): v is ExecutionEventOptions {
  if (v == null || typeof v !== "object") return false;
  return "level" in (v as Record<string, unknown>)
    || "detail" in (v as Record<string, unknown>)
    || "payload" in (v as Record<string, unknown>);
}

/** Deterministic execution id: `{stage}-{traceId}-{Date.now}`. */
export function newExecutionId(stageName: string, ctx: OperationContext): string {
  return `${stageName}-${ctx.traceId}-${Date.now()}`;
}

/**
 * Null-object writer. Keeps `runStage` free of `history &&` guards when the
 * composition root does not supply a KV store (unit tests, --no-kv mode).
 * Every method is a silent no-op.
 */
export const noopExecutionHistory: ExecutionHistory = {
  executionId: "",
  appendLog: () => {},
  start: async () => {},
  event: async () => {},
  finalize: async () => {},
};

/** Contract both real + null writers implement. */
/**
 * Optional fields on a structured event. `level` drives UI severity
 * (info/warn/error). `detail` is multi-line human-readable text — full
 * agent stdout, prompt body, verify stderr, verifier feedback —
 * anything the operator must read inline without reaching for KV.
 */
export interface ExecutionEventOptions {
  readonly level?: "info" | "warn" | "error";
  readonly detail?: string;
  readonly payload?: unknown;
}

export interface ExecutionHistory {
  readonly executionId: string;
  appendLog(message: string): void;
  start(
    fields: ExecutionStartFields,
    ctx: OperationContext,
  ): Promise<void>;
  event(
    type: string,
    message: string,
    optionsOrPayload?: ExecutionEventOptions | unknown,
    ctx?: OperationContext,
  ): Promise<void>;
  finalize(
    fields: ExecutionFinalizeFields,
    ctx: OperationContext,
  ): Promise<void>;
}

export interface ExecutionStartFields {
  readonly traceId: string;
  readonly repoId: string;
  readonly stageName: string;
  readonly agent?: string;
  readonly workItemId?: string;
  readonly scopeKey?: string;
  readonly startedAt: string;
  readonly parentExecutionId?: string;
}

export interface ExecutionFinalizeFields {
  readonly finishedAt: string;
  readonly durationMs: number;
  readonly status: ExecutionEntry["status"];
  readonly verdict?: ExecutionEntry["verdict"];
  readonly summary?: string;
  readonly prNumber?: number;
  readonly attempts?: number;
  readonly error?: string;
  /**
   * Success-rate signal for this run.
   *   1 — terminal success (PR merged, non-PR success).
   *   0 — terminal failure (failed / cancelled / rejected / verdict not approved).
   *   null — explicit "pending / not graded" (skipped runs, approved runs
   *          waiting for a PR merge to know the final outcome).
   *   undefined — unknown / not yet set.
   * `null` and `undefined` look identical at read time, but the writer
   * uses `null` to mark "deliberately not scored" so the intent is
   * preserved when reviewing executions.
   */
  readonly successScore?: number | null;
}

/**
 * Writer scoped to one stage run. Not thread-safe — every stage run allocates
 * its own instance.
 */
export class ExecutionHistoryWriter implements ExecutionHistory {
  private seq = 0;
  private readonly logLines: string[] = [];

  constructor(
    readonly executionId: string,
    private readonly kv: ExecutionKV,
  ) {}

  /** Append one line to the in-memory log buffer; flushed at `finalize()`. */
  appendLog(message: string): void {
    this.logLines.push(message);
  }

  /** Write the initial `executions/{id}` row with `status: "running"`. */
  async start(
    fields: ExecutionStartFields,
    ctx: OperationContext,
  ): Promise<void> {
    const entry: ExecutionEntry = {
      id: this.executionId,
      traceId: fields.traceId,
      repoId: fields.repoId,
      stageName: fields.stageName,
      parentExecutionId: fields.parentExecutionId,
      agent: fields.agent,
      workItemId: fields.workItemId,
      scopeKey: fields.scopeKey,
      startedAt: fields.startedAt,
      status: "running",
      instanceId: ctx.instanceId,
    };
    this.appendLog(
      `[${fields.startedAt}] execution started: stage=${fields.stageName} agent=${fields.agent ?? "-"} scopeKey=${fields.scopeKey ?? "-"}`,
    );
    await this.kv.put("executions", this.executionId, entry);
    void ctx;
  }

  /**
   * Append an `execution-events/{id}/{seq}` row.
   *
   * The legacy 2-arg call (`event(type, msg, payload)`) is detected by
   * absence of the structured `level`/`detail` keys on the third
   * argument; older call sites continue to work without changes.
   */
  async event(
    type: string,
    message: string,
    optionsOrPayload?: ExecutionEventOptions | unknown,
    ctx?: OperationContext,
  ): Promise<void> {
    const seq = this.seq++;
    const timestamp = new Date().toISOString();
    const opts = isEventOptions(optionsOrPayload)
      ? optionsOrPayload
      : { payload: optionsOrPayload };
    const entry: ExecutionEventEntry = {
      seq, timestamp, type, message,
      level: opts.level,
      detail: opts.detail,
      payload: opts.payload,
    };
    this.appendLog(`[${timestamp}] ${type}: ${message}`);
    if (opts.detail) {
      // Mirror the detail text into the log buffer so the in-UI log
      // blob carries the same content the events timeline shows.
      const indented = opts.detail.split("\n").map((l) => `    ${l}`).join("\n");
      this.appendLog(indented);
    }
    await this.kv.put(
      "execution-events",
      `${this.executionId}/${formatSeq(seq)}`,
      entry,
    );
    void ctx;
  }

  /**
   * Finalize: update `executions/{id}` with `finishedAt` / `status` / `verdict`
   * / `summary` / `durationMs` / `prNumber`, and flush the log blob to
   * `execution-logs/{id}`.
   */
  async finalize(
    fields: ExecutionFinalizeFields,
    ctx: OperationContext,
  ): Promise<void> {
    // Merge with whatever start wrote — keep scopeKey/stageName/traceId intact.
    const prior = await this.kv.get("executions", this.executionId);
    const priorEntry = (prior?.value ?? {}) as Partial<ExecutionEntry>;
    const merged: ExecutionEntry = {
      id: this.executionId,
      traceId: priorEntry.traceId ?? "",
      repoId: priorEntry.repoId ?? "",
      stageName: priorEntry.stageName ?? "",
      parentExecutionId: priorEntry.parentExecutionId,
      childExecutionIds: priorEntry.childExecutionIds,
      agent: priorEntry.agent,
      workItemId: priorEntry.workItemId,
      scopeKey: priorEntry.scopeKey,
      startedAt: priorEntry.startedAt ?? fields.finishedAt,
      finishedAt: fields.finishedAt,
      durationMs: fields.durationMs,
      attempts: fields.attempts,
      verdict: fields.verdict,
      summary: fields.summary,
      prNumber: fields.prNumber,
      status: fields.status,
      error: fields.error,
      successScore: fields.successScore,
      instanceId: priorEntry.instanceId ?? ctx.instanceId,
    };
    this.appendLog(
      `[${fields.finishedAt}] execution finalized: status=${fields.status} verdict=${fields.verdict ?? "-"} durationMs=${fields.durationMs}`,
    );
    await this.kv.put("executions", this.executionId, merged);

    const log: ExecutionLogEntry = {
      executionId: this.executionId,
      body: this.logLines.join("\n"),
      lineCount: this.logLines.length,
    };
    await this.kv.put("execution-logs", this.executionId, log);
    void ctx;
  }
}

/**
 * Append a newly-created executionId to a work item's `recentExecutionIds`
 * ring buffer. Keeps the last {@link RECENT_EXECUTION_LIMIT} ids. Called
 * after `start()` so the work-items detail page can link to in-flight runs.
 */
export const RECENT_EXECUTION_LIMIT = 10;

export async function appendRecentExecutionId(
  kv: ExecutionKV,
  workItemId: string,
  executionId: string,
): Promise<void> {
  const current = await kv.get("work-items", workItemId);
  if (!current) return;
  const value = current.value as { recentExecutionIds?: string[] } & Record<string, unknown>;
  const prev = Array.isArray(value.recentExecutionIds) ? value.recentExecutionIds : [];
  const next = [executionId, ...prev.filter((id) => id !== executionId)].slice(0, RECENT_EXECUTION_LIMIT);
  await kv.put("work-items", workItemId, stampWorkItem(value, { ...value, recentExecutionIds: next }));
}

/**
 * Append a child stage execution id to the parent cycle execution
 * row's `childExecutionIds` array. Used by `runCycle` so a single
 * cycle row links out to every stage it spawned, mirroring the
 * `recentExecutionIds` work-item index but at cycle granularity.
 */
export async function appendChildExecutionId(
  kv: ExecutionKV,
  parentExecutionId: string,
  childExecutionId: string,
): Promise<void> {
  const current = await kv.get("executions", parentExecutionId);
  if (!current) return;
  const value = current.value as { childExecutionIds?: string[] } & Record<string, unknown>;
  const prev = Array.isArray(value.childExecutionIds) ? value.childExecutionIds : [];
  if (prev.includes(childExecutionId)) return;
  await kv.put("executions", parentExecutionId, {
    ...value,
    childExecutionIds: [...prev, childExecutionId],
  });
}
