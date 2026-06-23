import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import type { KVStore, InstanceEntry, InstanceMode, InstanceStopReason, OperationContext } from "@operator/core";
import { instanceEntrySchema } from "@operator/core";

/**
 * Engine-instance presence tracker.
 *
 * Boot writes one `kv:instances/{id}` row, then a scheduled heartbeat
 * tick refreshes `lastHeartbeatAt` so the App UI can derive freshness.
 * Graceful shutdown writes `stoppedAt` + `stopReason`. Crashes leave
 * the row stale — the UI applies an "offline" threshold against
 * `lastHeartbeatAt` to hide dead runners from the active list.
 *
 * One instance per engine process; constructed in `entry.ts` and wired
 * into the daemon's lifecycle hooks.
 */

/** Default tick — short enough that "offline" detection on the UI side
 * (60s threshold by default) catches a kill within ~1 missed beat. */
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 5_000;

export interface InstanceInitFields {
  readonly version: string;
  readonly mode: InstanceMode;
  readonly repoFilter?: string;
  readonly forceAction?: string;
  readonly operatorDir?: string;
  /** Override hostname/pid for tests. Production callers omit. */
  readonly hostname?: string;
  readonly pid?: number;
  readonly user?: string;
}

export interface InstanceHeartbeatOptions {
  readonly intervalMs?: number;
  readonly now?: () => Date;
  readonly setInterval?: typeof globalThis.setInterval;
  readonly clearInterval?: typeof globalThis.clearInterval;
}

/** Minimal KV surface — keeps unit tests off the full {@link KVStore}. */
export type HeartbeatKV = Pick<KVStore, "get" | "put">;

export class InstanceHeartbeat {
  readonly instanceId: string;
  private readonly intervalMs: number;
  private readonly now: () => Date;
  private readonly setIntervalFn: typeof globalThis.setInterval;
  private readonly clearIntervalFn: typeof globalThis.clearInterval;

  private timer: ReturnType<typeof setInterval> | null = null;
  private current: InstanceEntry | null = null;

  constructor(
    private readonly kv: HeartbeatKV,
    opts?: InstanceHeartbeatOptions,
  ) {
    this.instanceId = `inst-${randomUUID().slice(0, 8)}-${Date.now().toString(36)}`;
    this.intervalMs = opts?.intervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
    this.now = opts?.now ?? (() => new Date());
    this.setIntervalFn = opts?.setInterval ?? globalThis.setInterval;
    this.clearIntervalFn = opts?.clearInterval ?? globalThis.clearInterval;
  }

  /** Write the initial `instances/{id}` row and start ticking. Idempotent. */
  async start(fields: InstanceInitFields, ctx: OperationContext): Promise<void> {
    if (this.current) return;
    const startedAt = this.now().toISOString();
    const entry: InstanceEntry = {
      id: this.instanceId,
      hostname: fields.hostname ?? safeHostname(),
      pid: fields.pid ?? process.pid,
      version: fields.version,
      mode: fields.mode,
      repoFilter: fields.repoFilter,
      forceAction: fields.forceAction,
      operatorDir: fields.operatorDir,
      user: fields.user ?? safeUserName(),
      startedAt,
      lastHeartbeatAt: startedAt,
    };
    this.current = entry;
    await this.kv.put("instances", this.instanceId, instanceEntrySchema.parse(entry));
    this.scheduleTick();
    void ctx;
  }

  /** Perform one heartbeat write. Safe to call manually (used by tests). */
  async tick(): Promise<void> {
    if (!this.current) return;
    const next: InstanceEntry = {
      ...this.current,
      lastHeartbeatAt: this.now().toISOString(),
    };
    this.current = next;
    await this.kv.put("instances", this.instanceId, instanceEntrySchema.parse(next));
  }

  /**
   * Bump the cycle counter and record `lastCycleAt`. Wired from the
   * daemon's per-cycle hook so the UI can show "12 cycles run" without
   * walking the executions list.
   */
  async recordCycle(): Promise<void> {
    if (!this.current) return;
    const at = this.now().toISOString();
    const next: InstanceEntry = {
      ...this.current,
      cycleCount: (this.current.cycleCount ?? 0) + 1,
      lastCycleAt: at,
      lastHeartbeatAt: at,
    };
    this.current = next;
    await this.kv.put("instances", this.instanceId, instanceEntrySchema.parse(next));
  }

  /**
   * Stop ticking and finalize the row with `stoppedAt`+`stopReason`.
   * Idempotent — second calls are a no-op.
   */
  async stop(reason: InstanceStopReason): Promise<void> {
    this.cancelTick();
    if (!this.current) return;
    const stoppedAt = this.now().toISOString();
    const next: InstanceEntry = {
      ...this.current,
      lastHeartbeatAt: stoppedAt,
      stoppedAt,
      stopReason: reason,
    };
    this.current = null;
    await this.kv.put("instances", this.instanceId, instanceEntrySchema.parse(next));
  }

  private scheduleTick(): void {
    this.timer = this.setIntervalFn(() => {
      void this.tick();
    }, this.intervalMs);
    // Don't keep the Node loop alive for the heartbeat alone; the daemon
    // is the lifetime owner. Test-injected stubs may not expose `unref`.
    const t = this.timer as unknown as { unref?: () => void };
    if (typeof t.unref === "function") t.unref();
  }

  private cancelTick(): void {
    if (!this.timer) return;
    this.clearIntervalFn(this.timer);
    this.timer = null;
  }
}

function safeHostname(): string {
  return hostname();
}

function safeUserName(): string | undefined {
  return process.env["USER"] || process.env["USERNAME"] || undefined;
}
