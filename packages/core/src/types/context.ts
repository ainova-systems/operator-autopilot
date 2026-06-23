export interface BudgetTracker {
  readonly limitUsd?: number;
  readonly spentUsd: number;
  add(amountUsd: number): void;
  isExceeded(): boolean;
}

export interface OperationContext {
  readonly traceId: string;
  readonly repoId: string;
  readonly action: string;
  readonly budget: BudgetTracker;
  readonly signal: AbortSignal;
  /**
   * Parent execution id (`executions/cycle-…`). When set, every stage
   * run that materialises an execution row records it under this
   * parent so the App UI can render the cycle ▸ stage tree. Set by
   * `Engine.runOnce` for every project; absent in standalone unit
   * tests that bypass the cycle wrapper.
   */
  readonly parentExecutionId?: string;
  /**
   * Engine-instance id (`kv:instances/{id}`). Stamped on every
   * execution row that originates from this run so the App can show a
   * per-instance run history. Optional — unit tests and one-shot
   * scripts that bypass the heartbeat layer leave it undefined.
   */
  readonly instanceId?: string;
}

export interface DateRange {
  readonly from: string;
  readonly to: string;
}
