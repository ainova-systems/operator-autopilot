import type {
  DefaultsConfig,
  KVStore,
  StageDispatchEntry,
  StageDispatchRegistry,
  ScheduleSpec,
} from "@operator/core";

/**
 * KV-driven dispatch registry — Phase B Part 2 (2026-05-20).
 *
 * Reads every row from `kv:workflow-stages/*`, picks rows that carry a
 * `dispatch` block, and translates each into a {@link StageDispatchEntry}
 * the project-runner can consume. Stages without `dispatch` are treated
 * as not auto-firing per cycle (they may still be invoked via explicit
 * force-action or by future stage-as-event flows).
 *
 * Composition-root contract:
 *
 *   const registry = await buildStageDispatchRegistryFromKV(kv, defaults, [
 *     // Housekeeping actions that are not stages — their dispatch lives
 *     // here at the root because there's no agent / selector / output
 *     // sink to put in a workflow-stage row.
 *     { action: "branch-cleanup", ... },
 *     { action: "pr-lifecycle", ... },
 *   ]);
 *
 * The runner then iterates `registry.normalOrder` (sorted by `order`)
 * exactly as before — same `StageDispatchRegistry` interface, just a
 * different production path.
 *
 * `defaults` is currently unused by the builder itself — `stages.yaml`
 * inlines the interval / hour / day numbers it would otherwise pull
 * from `defaults.schedules`. Kept on the signature so a future
 * `${defaults.schedules.X}` template substitution can land without
 * touching every caller. Same reason `void defaults` near the bottom.
 */
export async function buildStageDispatchRegistryFromKV(
  kv: KVStore,
  defaults: DefaultsConfig,
  extras: readonly StageDispatchEntry[] = [],
): Promise<StageDispatchRegistry> {
  const rows = await kv.list("workflow-stages");
  const entries: StageDispatchEntry[] = [...extras];

  for (const row of rows) {
    const value = row.value as
      | {
          readonly name?: string;
          readonly dispatch?: {
            readonly order: number;
            readonly featureFlags?: readonly string[];
            readonly schedule: ScheduleSpec;
          };
        }
      | undefined;
    if (!value || !value.name || !value.dispatch) continue;
    entries.push(buildEntryFromKVRow(value.name, value.dispatch));
  }

  const byAction = new Map(entries.map((e) => [e.action, e]));
  if (byAction.size !== entries.length) {
    // Duplicate `action` between KV stages + extras — surface eagerly so
    // the composition root sees the conflict at boot rather than after
    // one stage silently shadows another.
    const seen = new Set<string>();
    for (const e of entries) {
      if (seen.has(e.action)) {
        throw new Error(`Duplicate dispatch entry for action="${e.action}"`);
      }
      seen.add(e.action);
    }
  }
  const normalOrder = [...entries].sort((a, b) => a.order - b.order);

  void defaults; // see header — held for the future ${defaults.schedules.*} resolution path

  return {
    normalOrder,
    get: (action: string): StageDispatchEntry | undefined => byAction.get(action),
    forceChain: (action: string): readonly string[] | undefined => {
      // Self-chain only (matches the in-code defaults — Step 9 collapsed
      // the only pre-existing chains).
      return byAction.has(action) ? [action] : undefined;
    },
  };
}

function buildEntryFromKVRow(
  action: string,
  dispatch: {
    readonly order: number;
    readonly featureFlags?: readonly string[];
    readonly schedule: ScheduleSpec;
  },
): StageDispatchEntry {
  const flags = dispatch.featureFlags ?? [];
  return {
    action,
    order: dispatch.order,
    schedule: dispatch.schedule,
    isEnabled: (features) => {
      if (!features || flags.length === 0) return true;
      // Compound AND — every named flag must NOT be `false`. A `null` /
      // missing key counts as "not set" → grants. Matches the pre-
      // Phase-B compound `taskExecute !== false && taskSelect !== false`
      // semantics.
      return flags.every((key) => {
        const value = (features as Record<string, unknown>)[key];
        return value !== false;
      });
    },
  };
}
