import type {
  OperationContext, StateManager, KindRegistry, KVStore, VCSPlatform,
  WorkItemSource, WorkItemStatus, WorkItemKind, WorkflowStageEntry,
} from "@operator/core";
import { errorMessage } from "@operator/core";
import type { PRManager } from "../../delivery/pr-manager.js";
import type { Logger } from "../../logging/logger.js";
import { observePRState } from "./observe-status.js";

/**
 * Orphan / lifetime reconciler — terminalizes stuck discovery items.
 *
 * A discovery item (e.g. a `finding`) can end up in limbo: a non-terminal,
 * non-pending status with no live PR backing it. This happens when the PR
 * that was driving it is closed/deleted and the develop file is left at
 * `in-progress` — the item is neither pending backlog nor terminal, so no
 * selector ever picks it up again and no stage ever closes it. Those items
 * also pollute the analyst dedup window (they read as "open findings, do not
 * report"), suppressing their whole problem domain forever.
 *
 * This primitive is the OWNER of that cleanup. It is hosted by the
 * retrospective stage — the only stage permitted terminalizing cross-kind
 * writes (see `intelligence/rules/context.md`). It is bounded self-healing
 * with a reason on every write (NOT silent auto-clear): each terminalization
 * gets an INFO line with the prior status, branch, and PR state.
 *
 * Config-driven — NOTHING here hardcodes a stage name, kind, or path. The set
 * of kinds to reap is resolved from `kv:workflow-stages/*` (every stage that
 * PRODUCES a work item declares its kind via `outputSink.kind` — findings from
 * research, tasks from finding-plan, retrospectives from retrospective; manual
 * kinds nobody produces, e.g. `request`, are excluded), and each item's branch
 * comes from `KindRegistry.branchPrefixFor(kind)`.
 *
 * Reaping rule (conservative — the human owns merging live PRs):
 *   - candidate = non-terminal AND in a "limbo" status (NOT `pending`, which
 *     is legitimate backlog awaiting its first PR);
 *   - reap iff it has NO live PR (prState `none`/`closed`) AND it is past its
 *     lifetime (`now - createdAt >= lifetimeDays`). The lifetime gate is a TTL
 *     that avoids cancelling an item whose PR was merely closed this very
 *     cycle (race) — an item with an OPEN PR is never reaped regardless of age.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** Default lifetime cap (days) for non-terminal discovery items with no live PR. */
const ORPHAN_LIFETIME_DAYS = 30;

/** Terminal status the reaper assigns. Must be in the kind's `terminalStatuses`. */
const REAPED_STATUS: WorkItemStatus = "cancelled";

/**
 * Non-terminal statuses the reaper considers "in limbo". `pending` is
 * deliberately excluded — it is real backlog awaiting its first PR and must
 * never be cancelled.
 */
const LIMBO_STATUSES: ReadonlySet<WorkItemStatus> = new Set([
  "in-progress", "in-review", "ready-to-merge", "reopened",
]);

export interface OrphanReconcilerDeps {
  readonly state: StateManager;
  readonly kv: KVStore;
  readonly registry: KindRegistry;
  readonly vcs: VCSPlatform;
  readonly prManager: PRManager;
  readonly workItemSource: WorkItemSource;
  readonly log?: Logger;
}

export interface OrphanReconcilerOptions {
  /** Injectable clock for deterministic tests. Defaults to `Date.now()`. */
  readonly now?: number;
  /** Lifetime cap override (days). Defaults to {@link ORPHAN_LIFETIME_DAYS}. */
  readonly lifetimeDays?: number;
}

export interface OrphanReconcilerResult {
  readonly scanned: number;
  readonly terminalized: number;
  readonly skipped: number;
}

/**
 * Resolve the work-item kinds the engine PRODUCES, from config. Any stage
 * that declares an `outputSink.kind` emits that kind (findings, tasks,
 * retrospectives, …). No hardcoded `"finding"`/`"task"` — a renamed or added
 * producing stage is covered automatically; manual kinds nobody produces are
 * left alone.
 */
async function reapableKinds(kv: KVStore, log?: Logger): Promise<WorkItemKind[]> {
  const rows = await kv.list("workflow-stages");
  const kinds = new Set<WorkItemKind>();
  for (const row of rows) {
    const stage = row.value as WorkflowStageEntry;
    if (stage?.outputSink?.kind) kinds.add(stage.outputSink.kind);
  }
  if (kinds.size === 0) {
    log?.info("orphan-reconciler: no stage produces a work-item kind, nothing to reconcile", {
      scope: "orphan-reconciler", reason: "no-produced-kinds",
    });
  }
  return [...kinds];
}

/**
 * Scan discovery-output kinds for orphaned / over-lifetime limbo items and
 * terminalize them to `cancelled`. Returns a tally for the caller to log /
 * surface in the retrospective brief.
 */
export async function reconcileOrphanedItems(
  deps: OrphanReconcilerDeps,
  opts: OrphanReconcilerOptions,
  ctx: OperationContext,
): Promise<OrphanReconcilerResult> {
  const now = opts.now ?? Date.now();
  const lifetimeDays = opts.lifetimeDays ?? ORPHAN_LIFETIME_DAYS;
  const lifetimeMs = lifetimeDays * DAY_MS;
  const kinds = await reapableKinds(deps.kv, deps.log);

  let scanned = 0;
  let terminalized = 0;
  let skipped = 0;

  for (const kind of kinds) {
    if (!deps.registry.get(kind)) continue; // unknown kind in config — skip safely
    const items = await deps.state.listWorkItems(ctx, { kind });
    const prefix = deps.registry.branchPrefixFor(kind);

    for (const item of items) {
      if (deps.registry.isTerminal(kind, item.status)) continue;
      if (!LIMBO_STATUSES.has(item.status)) continue; // skips pending backlog
      scanned++;

      const branch = prefix ? `${prefix}/${item.id}` : null;
      const prState = branch
        ? await observePRState(branch, { prManager: deps.prManager, vcs: deps.vcs })
        : { value: "none" as const };
      const noLivePR = prState.value === "none" || prState.value === "closed";

      const createdMs = item.createdAt ? Date.parse(item.createdAt) : now;
      const overLifetime = !Number.isNaN(createdMs) && now - createdMs >= lifetimeMs;

      if (!noLivePR || !overLifetime) {
        deps.log?.debug(
          `orphan-reconciler: skip ${kind} ${item.id} (status=${item.status}, prState=${prState.value}, overLifetime=${overLifetime})`,
          { scope: "orphan-reconciler", kind, itemId: item.id, prState: prState.value, overLifetime },
        );
        skipped++;
        continue;
      }

      const reason = `orphan-reconciler: no live PR (prState=${prState.value}), past ${lifetimeDays}d lifetime, was ${item.status}`;
      try {
        await deps.workItemSource.updateStatus({ id: item.id, kind }, REAPED_STATUS, reason, ctx);
        terminalized++;
        deps.log?.info(
          `orphan-reconciler: cancelled ${kind} ${item.id} (was ${item.status}, prState=${prState.value}, branch=${branch ?? "-"})`,
          {
            scope: "orphan-reconciler", kind, itemId: item.id,
            prevStatus: item.status, prState: prState.value, branch, reason,
          },
        );
      } catch (err) {
        skipped++;
        deps.log?.warn(
          `orphan-reconciler: failed to cancel ${kind} ${item.id} (left as ${item.status})`,
          { scope: "orphan-reconciler", kind, itemId: item.id, error: errorMessage(err) },
        );
      }
    }
  }

  deps.log?.info(
    `orphan-reconciler: scanned ${scanned}, terminalized ${terminalized}, skipped ${skipped}`,
    { scope: "orphan-reconciler", scanned, terminalized, skipped },
  );
  return { scanned, terminalized, skipped };
}
