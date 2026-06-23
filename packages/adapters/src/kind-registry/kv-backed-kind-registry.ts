import { randomBytes } from "node:crypto";
import type { KindRegistry, KVStore, OperationContext, WorkItemKind, WorkItemStatus } from "@operator/core";
import { ConfigError, workItemKindSchema, type WorkItemKindEntry } from "@operator/core";

/**
 * KV-backed {@link KindRegistry} implementation.
 *
 * Loads every `kv:work-item-kinds/*` row at construction time, validates
 * each entry through {@link workItemKindSchema}, and caches the snapshot
 * in memory. Throws at boot when the category is empty — the registry is
 * load-bearing; the engine cannot serve work items without it
 * (architecture-v5.md §8.1).
 *
 * The registry is immutable after construction. Reseeding through
 * `engine/storage/seed.ts --reseed work-item-kinds` requires restarting
 * the engine for the snapshot to pick up changes — matches the contract
 * for every other seed-once category.
 */
export class KVBackedKindRegistry implements KindRegistry {
  private readonly byName: Map<string, WorkItemKindEntry>;
  readonly all: readonly WorkItemKindEntry[];

  private constructor(entries: readonly WorkItemKindEntry[]) {
    this.all = entries;
    this.byName = new Map(entries.map((e) => [e.name, e]));
  }

  /**
   * Construct a registry by reading every row under `kv:work-item-kinds/*`.
   * Each row is validated through the Zod schema; any validation error
   * surfaces as a `ConfigError` with the offending key in the message.
   */
  static async fromKV(kv: KVStore, _ctx: OperationContext): Promise<KVBackedKindRegistry> {
    const rows = await kv.list("work-item-kinds");
    if (rows.length === 0) {
      throw new ConfigError(
        "KIND_REGISTRY_EMPTY",
        "kv:work-item-kinds/* is empty — seed at least one kind definition before starting the engine",
      );
    }
    const entries: WorkItemKindEntry[] = [];
    for (const row of rows) {
      try {
        entries.push(workItemKindSchema.parse(row.value));
      } catch (err) {
        throw new ConfigError(
          "KIND_REGISTRY_INVALID",
          `Invalid kind definition at kv:work-item-kinds/${row.key}: ${(err as Error).message}`,
          { cause: err as Error },
        );
      }
    }
    return new KVBackedKindRegistry(entries);
  }

  get(kind: WorkItemKind): WorkItemKindEntry | undefined {
    return this.byName.get(kind);
  }

  isTerminal(kind: WorkItemKind, status: WorkItemStatus): boolean {
    const def = this.byName.get(kind);
    if (!def) return false;
    return def.terminalStatuses.includes(status);
  }

  labelFor(kind: WorkItemKind): string {
    return this.requireKind(kind).label;
  }

  branchPrefixFor(kind: WorkItemKind): string {
    return this.requireKind(kind).branchPrefix;
  }

  dataDirFor(kind: WorkItemKind): string {
    return this.requireKind(kind).dataDir;
  }

  parentKindsFor(kind: WorkItemKind): readonly WorkItemKind[] {
    const def = this.byName.get(kind);
    return def?.parentKinds ?? [];
  }

  terminalStatusesFor(kind: WorkItemKind): ReadonlySet<WorkItemStatus> {
    const def = this.byName.get(kind);
    return new Set((def?.terminalStatuses ?? []) as WorkItemStatus[]);
  }

  /**
   * Mint `{idPrefix}{date}-{8 uppercase hex chars}`. The 4-byte random
   * suffix makes the id collision-resistant by construction — no filesystem
   * or counter scan — so two planners on sibling feature branches can never
   * mint the same id. Replaces the v4 `nextFindingSeq` / `nextTaskSeq`
   * sequence scan, which read only the current branch's tree and so issued
   * duplicate ids across unmerged branches (the 2026-05-21 add/add conflict
   * on a shared work-item file).
   */
  async generateId(kind: WorkItemKind, date?: string): Promise<string> {
    const def = this.requireKind(kind);
    const d = date ?? todayYyyymmdd();
    const suffix = randomBytes(4).toString("hex").toUpperCase();
    return `${def.idPrefix}${d}-${suffix}`;
  }

  private requireKind(kind: WorkItemKind): WorkItemKindEntry {
    const def = this.byName.get(kind);
    if (!def) {
      throw new ConfigError(
        "KIND_UNKNOWN",
        `Unknown work-item kind: ${kind} (known: ${[...this.byName.keys()].join(", ") || "<empty>"})`,
      );
    }
    return def;
  }
}

function todayYyyymmdd(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`;
}
