import type { DateRange, OperationContext } from "./context.js";
import type { WorkItem, WorkItemKind, WorkItemStatus } from "./domain.js";

export interface OutcomeRecord {
  readonly id: string;
  readonly workItemId: string;
  readonly deliveredAt: string;
  readonly observedAt?: string;
  readonly status: "healthy" | "degraded" | "broken" | "unknown";
  readonly signals: string[];
  readonly recommendation?: "keep" | "rollback" | "investigate" | "wait-more";
  readonly riskScore?: number;
}

export interface ExecutionRecord {
  readonly id: string;
  readonly traceId: string;
  readonly pipeline: string;
  readonly agent?: string;
  readonly status: "running" | "completed" | "failed" | "interrupted";
  readonly startedAt: string;
  readonly finishedAt?: string;
  readonly error?: string;
}

export interface StateManager {
  // Work items
  upsertWorkItem(ctx: OperationContext, item: WorkItem): Promise<void>;
  /**
   * Remove the work item row entirely (used by `syncFilesToState`
   * when a previously-tracked item has disappeared from the develop
   * file tree — typically a finding-plan task that never merged).
   * Idempotent: a delete on a missing id is a no-op.
   */
  deleteWorkItem(ctx: OperationContext, id: string): Promise<void>;
  getWorkItem(ctx: OperationContext, id: string): Promise<WorkItem | null>;
  listWorkItems(ctx: OperationContext, filters?: {
    kind?: WorkItemKind;
    status?: WorkItemStatus[];
    limit?: number;
  }): Promise<WorkItem[]>;
  updateWorkItemStatus(ctx: OperationContext, id: string, status: WorkItemStatus): Promise<void>;

  // Execution log
  appendExecution(ctx: OperationContext, record: ExecutionRecord): Promise<void>;
  listExecutions(ctx: OperationContext, range?: DateRange): Promise<ExecutionRecord[]>;

  // Outcomes
  saveOutcome(ctx: OperationContext, outcome: OutcomeRecord): Promise<void>;
  listOutcomes(ctx: OperationContext, range?: DateRange): Promise<OutcomeRecord[]>;

  // Schedule tracking (ports V1 state.sh schedule_due_minutes / schedule_mark_run)
  isScheduleDue(ctx: OperationContext, repoId: string, action: string, intervalMinutes: number): Promise<boolean>;
  markScheduleRun(ctx: OperationContext, repoId: string, action: string): Promise<void>;

  /**
   * Small per-repo integer counters. Used by the `queue-fill` schedule to
   * track consecutive empty (produced-nothing) runs for exponential backoff.
   * `getCounter` returns 0 for an unset key. Distinct from schedule tracking
   * (which stores timestamps) — this stores a plain integer.
   */
  getCounter(ctx: OperationContext, repoId: string, key: string): Promise<number>;
  setCounter(ctx: OperationContext, repoId: string, key: string, value: number): Promise<void>;

  // Deduplication (known_items table, backed by Shield in production)
  isKnownItem(ctx: OperationContext, repoId: string, sourceKey: string): Promise<boolean>;
  markKnownItem(ctx: OperationContext, repoId: string, sourceKey: string): Promise<void>;

  // Lifecycle
  close(): void;
}
