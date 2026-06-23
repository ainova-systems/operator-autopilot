import { randomBytes } from "node:crypto";
import type { KindRegistry, WorkItemKind, WorkItemStatus } from "@operator/core";
import type { WorkItemKindEntry } from "@operator/core";

/**
 * In-memory {@link KindRegistry} for tests. Defaults to the three shipped
 * kinds (finding, task, request) — callers override `entries` only when
 * they need a different set (e.g. proving that adding a new kind like
 * `"plan"` through the registry works end-to-end).
 */
export function makeTestKindRegistry(
  entries: readonly WorkItemKindEntry[] = DEFAULT_KIND_ENTRIES,
): KindRegistry {
  const byName = new Map(entries.map((e) => [e.name, e]));
  return {
    all: entries,
    get: (kind) => byName.get(kind),
    isTerminal: (kind, status) => byName.get(kind)?.terminalStatuses.includes(status) ?? false,
    labelFor: (kind) => requireEntry(byName, kind).label,
    branchPrefixFor: (kind) => requireEntry(byName, kind).branchPrefix,
    dataDirFor: (kind) => requireEntry(byName, kind).dataDir,
    parentKindsFor: (kind) => byName.get(kind)?.parentKinds ?? [],
    terminalStatusesFor: (kind) =>
      new Set((byName.get(kind)?.terminalStatuses ?? []) as WorkItemStatus[]),
    generateId: async (kind: WorkItemKind, date?: string) => {
      const def = requireEntry(byName, kind);
      const d = date ?? todayYyyymmdd();
      return `${def.idPrefix}${d}-${randomBytes(4).toString("hex").toUpperCase()}`;
    },
  };
}

const DEFAULT_KIND_ENTRIES: readonly WorkItemKindEntry[] = [
  {
    name: "finding", label: "Finding",
    idPrefix: "F", dataDir: "findings",
    branchPrefix: "ai/findings", prPrefix: "[AI:Finding]",
    terminalStatuses: ["merged", "failed", "rejected", "duplicate"],
    parentKinds: [],
  },
  {
    name: "task", label: "Task",
    idPrefix: "T", dataDir: "tasks",
    branchPrefix: "ai/tasks", prPrefix: "[AI:Task]",
    terminalStatuses: ["merged", "failed", "rejected", "duplicate", "cancelled"],
    parentKinds: ["finding"],
  },
  {
    name: "request", label: "Request",
    idPrefix: "R", dataDir: "requests",
    branchPrefix: "ai/requests", prPrefix: "[AI:Request]",
    terminalStatuses: ["completed", "merged", "rejected"],
    parentKinds: [],
  },
];

function requireEntry(map: Map<string, WorkItemKindEntry>, kind: WorkItemKind): WorkItemKindEntry {
  const e = map.get(kind);
  if (!e) throw new Error(`Unknown test kind: ${kind}`);
  return e;
}

function todayYyyymmdd(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`;
}
