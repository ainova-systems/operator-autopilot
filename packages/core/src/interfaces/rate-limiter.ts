import type { OperationContext } from "../types/context.js";

export interface RateLimiterDecision {
  readonly allowed: boolean;
  readonly retryAfterMs?: number;
}

/**
 * Token-bucket style rate limiter. `allow` deducts `cost` tokens from the
 * bucket keyed by `key`; when the bucket is empty the call returns
 * `allowed: false` along with a hint how long before it refills enough to
 * cover the request. See architecture-v5.md §5.1.
 */
export interface RateLimiter {
  allow(key: string, cost: number, ctx: OperationContext): Promise<RateLimiterDecision>;
  reset(key: string): Promise<void>;
}
