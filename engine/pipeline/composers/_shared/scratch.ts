import type { OperationContext } from "@operator/core";

/**
 * Per-invocation scratch store shared between stage hooks.
 *
 * Every stage-logic file has two or three hooks (beforeAgent, buildRunInput,
 * buildPR, afterAgent) that need to exchange per-invocation state — notably
 * pre-agent HEAD snapshots, codeReview IDs, and aggregated metrics. A process-
 * lifetime `Map<string, T>` keyed by `{traceId}:{scopeKey}` satisfies the
 * contract, but leaks forever if the stage throws between `beforeAgent` and
 * the final hook that clears the entry.
 *
 * `createScratchStore` returns a typed handle that owns the map + key format
 * and exposes a minimal three-method API. Stages MUST call `clear(ctx, key)`
 * in a `finally` block so long-running daemons do not accumulate unreleased
 * scratch entries when an agent invocation throws.
 */
export interface ScratchStore<T> {
  /** Read the entry set by `set` for this cycle. Returns `undefined` when absent. */
  get(ctx: OperationContext, key: string): T | undefined;
  /** Write (or overwrite) an entry for this cycle. Scopes by `ctx.traceId`. */
  set(ctx: OperationContext, key: string, value: T): void;
  /**
   * Delete the entry for this cycle. Idempotent — safe to call in a `finally`
   * block even when `set` never ran.
   */
  clear(ctx: OperationContext, key: string): void;
  /** Test-only inspection hook: current number of live entries. */
  readonly size: number;
}

/**
 * Create a new {@link ScratchStore}. The returned store is process-local to
 * the caller (not shared across modules) so each stage-logic file owns its
 * own cache. Keys are composed as `{traceId}:{scopeKey}` — uniqueness across
 * concurrent cycles is guaranteed by `ctx.traceId`.
 */
export function createScratchStore<T>(): ScratchStore<T> {
  const map = new Map<string, T>();

  const keyOf = (ctx: OperationContext, scopeKey: string): string =>
    `${ctx.traceId}:${scopeKey}`;

  return {
    get(ctx, scopeKey) {
      return map.get(keyOf(ctx, scopeKey));
    },
    set(ctx, scopeKey, value) {
      map.set(keyOf(ctx, scopeKey), value);
    },
    clear(ctx, scopeKey) {
      map.delete(keyOf(ctx, scopeKey));
    },
    get size() {
      return map.size;
    },
  };
}
