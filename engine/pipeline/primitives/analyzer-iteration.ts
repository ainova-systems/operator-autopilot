/**
 * Outcome of an {@link iterateBestEffort} run.
 *
 * `successCount` counts items whose `perItem` closure resolved without
 * throwing (regardless of whether they returned a result). `failureCount`
 * counts items whose closure threw — those throws are caught and routed
 * through `onItemError` so the caller can log without terminating the
 * iteration. `results` carries non-null / non-undefined return values
 * in iteration order so the caller can build summary state (e.g. a list
 * of newly-created child-item ids).
 */
export interface IterationResult<TResult> {
  readonly successCount: number;
  readonly failureCount: number;
  readonly results: TResult[];
}

export interface IterateBestEffortOptions<TItem> {
  /**
   * Called once per item whose `perItem` closure threw. Caller decides
   * whether to log, attach observability metadata, surface the cause,
   * etc. The iteration itself never short-circuits on a thrown error —
   * the next item still runs.
   */
  readonly onItemError?: (item: TItem, err: unknown) => void;
}

/**
 * Iterate `items` running `perItem` for each one with best-effort
 * error containment.
 *
 * Used by stages that run a heterogeneous batch of independent sub-tasks
 * where one sub-task failing should not abort the cycle (a research
 * stage that iterates a list of analyzers is the canonical consumer;
 * future repos can adopt the same pattern for any "fan-out one cycle
 * into N sub-cycles" workflow).
 *
 * The primitive is fully kind-agnostic, role-agnostic, and stage-name-
 * agnostic — `perItem` is a caller-supplied closure that owns all
 * domain-specific dispatch (agent invocation, applier routing, KV sync,
 * etc.). The closure may return `null` or `undefined` to indicate "ran
 * successfully but produced no collectable result" (counted as success,
 * no entry pushed to `results`), or `throw` to indicate failure
 * (counted as failure, swallowed for iteration continuity).
 *
 * The primitive itself performs no logging — the caller's `onItemError`
 * hook owns observability so the message format matches the surrounding
 * stage convention (`stage: "research"`, `analyzerId: ...`, etc.).
 */
export async function iterateBestEffort<TItem, TResult>(
  items: readonly TItem[],
  perItem: (item: TItem) => Promise<TResult | null | undefined>,
  options: IterateBestEffortOptions<TItem> = {},
): Promise<IterationResult<TResult>> {
  let successCount = 0;
  let failureCount = 0;
  const results: TResult[] = [];
  for (const item of items) {
    try {
      const result = await perItem(item);
      if (result !== null && result !== undefined) results.push(result);
      successCount++;
    } catch (err) {
      failureCount++;
      options.onItemError?.(item, err);
    }
  }
  return { successCount, failureCount, results };
}
