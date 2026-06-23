import { z } from "zod";

/**
 * Engine-instance presence row — one row in `kv:instances/{id}`.
 *
 * Every engine process registers itself on boot and emits a heartbeat
 * tick (default ~5s) so the App UI can list "currently active" runners.
 * On graceful shutdown the row is finalized with `stoppedAt`+`stopReason`;
 * crashed processes leave the row dangling until the UI considers it
 * `offline` (heartbeat staler than the configured threshold).
 *
 * The row is the audit-trail anchor — execution rows reference it via
 * `executions.instanceId` so a per-instance executions filter is just
 * a list query against the same store.
 */
export const instanceModeSchema = z.enum(["once", "daemon"]);

export const instanceStopReasonSchema = z.enum([
  "once-complete",
  "graceful",
  "signal",
  "error",
]);

export const instanceEntrySchema = z.object({
  id: z.string().min(1),
  hostname: z.string().min(1),
  pid: z.number().int().nonnegative(),
  version: z.string().min(1),
  mode: instanceModeSchema,
  /** CLI `--repo` filter, when present. */
  repoFilter: z.string().optional(),
  /** CLI `--force` action, when present. */
  forceAction: z.string().optional(),
  /** Engine working dir (resolved). Useful when several runners share a host. */
  operatorDir: z.string().optional(),
  /** Process owner login, when discoverable from env (`USER` / `USERNAME`). */
  user: z.string().optional(),
  startedAt: z.string().min(1),
  /** Last heartbeat tick. Used by the UI to derive freshness/`offline` state. */
  lastHeartbeatAt: z.string().min(1),
  /** Set on graceful shutdown only. Crashed runners leave this undefined. */
  stoppedAt: z.string().optional(),
  stopReason: instanceStopReasonSchema.optional(),
  /** Engine cycles completed by this instance so far (best-effort counter). */
  cycleCount: z.number().int().nonnegative().optional(),
  lastCycleAt: z.string().optional(),
});

export type InstanceEntry = z.infer<typeof instanceEntrySchema>;
export type InstanceMode = z.infer<typeof instanceModeSchema>;
export type InstanceStopReason = z.infer<typeof instanceStopReasonSchema>;
