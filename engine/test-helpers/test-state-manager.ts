import type { OperationContext, DateRange } from "@operator/core";
import type { WorkItem, WorkItemKind, WorkItemStatus } from "@operator/core";
import type { StateManager, ExecutionRecord, OutcomeRecord } from "@operator/core";

/**
 * In-memory StateManager for testing.
 *
 * All operations work against local Maps — no SQLite, no I/O.
 */
export class TestStateManager implements StateManager {
  readonly workItems = new Map<string, WorkItem>();
  readonly executions: ExecutionRecord[] = [];
  readonly outcomes: OutcomeRecord[] = [];
  readonly schedules = new Map<string, string>(); // "repoId:action" → ISO timestamp
  readonly knownItems = new Set<string>(); // "repoId:sourceKey"

  // ── Work items ──

  async upsertWorkItem(ctx: OperationContext, item: WorkItem): Promise<void> {
    this.workItems.set(item.id, item);
  }

  async getWorkItem(ctx: OperationContext, id: string): Promise<WorkItem | null> {
    return this.workItems.get(id) ?? null;
  }

  async deleteWorkItem(ctx: OperationContext, id: string): Promise<void> {
    this.workItems.delete(id);
  }

  async listWorkItems(ctx: OperationContext, filters?: {
    kind?: WorkItemKind;
    status?: WorkItemStatus[];
    limit?: number;
  }): Promise<WorkItem[]> {
    let items = [...this.workItems.values()];
    if (filters?.kind) items = items.filter((i) => i.kind === filters.kind);
    if (filters?.status) items = items.filter((i) => filters.status!.includes(i.status));
    items.sort((a, b) => a.priority - b.priority || a.createdAt.localeCompare(b.createdAt));
    if (filters?.limit) items = items.slice(0, filters.limit);
    return items;
  }

  async updateWorkItemStatus(ctx: OperationContext, id: string, status: WorkItemStatus): Promise<void> {
    const item = this.workItems.get(id);
    if (item) {
      this.workItems.set(id, { ...item, status, updatedAt: new Date().toISOString() });
    }
  }

  // ── Execution log ──

  async appendExecution(ctx: OperationContext, record: ExecutionRecord): Promise<void> {
    this.executions.push(record);
  }

  async listExecutions(ctx: OperationContext, range?: DateRange): Promise<ExecutionRecord[]> {
    let result = [...this.executions];
    if (range) {
      result = result.filter((e) => e.startedAt >= range.from && e.startedAt <= range.to);
    }
    return result.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  // ── Outcomes ──

  async saveOutcome(ctx: OperationContext, outcome: OutcomeRecord): Promise<void> {
    const idx = this.outcomes.findIndex((o) => o.id === outcome.id);
    if (idx >= 0) {
      this.outcomes[idx] = outcome;
    } else {
      this.outcomes.push(outcome);
    }
  }

  async listOutcomes(ctx: OperationContext, range?: DateRange): Promise<OutcomeRecord[]> {
    let result = [...this.outcomes];
    if (range) {
      result = result.filter((o) => o.deliveredAt >= range.from && o.deliveredAt <= range.to);
    }
    return result.sort((a, b) => b.deliveredAt.localeCompare(a.deliveredAt));
  }

  // ── Schedule tracking ──

  async isScheduleDue(ctx: OperationContext, repoId: string, action: string, intervalMinutes: number): Promise<boolean> {
    const key = `${repoId}:${action}`;
    const lastRun = this.schedules.get(key);
    if (!lastRun) return true;
    const diffMs = Date.now() - new Date(lastRun).getTime();
    return diffMs / 60_000 >= intervalMinutes;
  }

  async markScheduleRun(ctx: OperationContext, repoId: string, action: string): Promise<void> {
    this.schedules.set(`${repoId}:${action}`, new Date().toISOString());
  }

  // ── Counters (queue-fill backoff state) ──

  readonly counters = new Map<string, number>(); // "repoId:key" → value

  async getCounter(ctx: OperationContext, repoId: string, key: string): Promise<number> {
    return this.counters.get(`${repoId}:${key}`) ?? 0;
  }

  async setCounter(ctx: OperationContext, repoId: string, key: string, value: number): Promise<void> {
    this.counters.set(`${repoId}:${key}`, value);
  }

  // ── Deduplication ──

  async isKnownItem(ctx: OperationContext, repoId: string, sourceKey: string): Promise<boolean> {
    return this.knownItems.has(`${repoId}:${sourceKey}`);
  }

  async markKnownItem(ctx: OperationContext, repoId: string, sourceKey: string): Promise<void> {
    this.knownItems.add(`${repoId}:${sourceKey}`);
  }

  // ── Lifecycle ──

  close(): void {
    // No-op for in-memory
  }
}
