import type { InstanceEntry } from "@operator/core";

/**
 * Heartbeat-staleness threshold. After this many milliseconds without a
 * heartbeat tick, the App treats a runner as `offline` and hides it from
 * the default "active only" view. Picked to be ~2x the engine's default
 * heartbeat interval (5s) plus headroom — one missed beat is not enough
 * to declare a runner dead, two missed beats is.
 */
export const HEARTBEAT_STALE_AFTER_MS = 60_000;

export type InstanceStatus = "running" | "offline" | "stopped";

/**
 * Derive a presentational status from a stored row plus the current wall
 * clock. Pure — no I/O, no side effects.
 *
 *   - `stopped`  : `stoppedAt` is set (graceful shutdown, --once exit, etc.)
 *   - `offline`  : alive but `lastHeartbeatAt` is older than the threshold
 *                  (process killed / crashed / network-partitioned host)
 *   - `running`  : alive and beating
 */
export function classifyInstance(entry: InstanceEntry, nowMs: number): InstanceStatus {
  if (entry.stoppedAt) return "stopped";
  const last = Date.parse(entry.lastHeartbeatAt);
  if (!Number.isFinite(last)) return "offline";
  return nowMs - last > HEARTBEAT_STALE_AFTER_MS ? "offline" : "running";
}
