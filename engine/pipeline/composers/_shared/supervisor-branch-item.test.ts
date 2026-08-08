import { describe, it, expect } from "vitest";
import type { KindRegistry } from "@operator/core";
import { inferKindFromBranch } from "./supervisor-branch-item.js";

function makeRegistry(prefixes: Array<{ name: string; branchPrefix: string }>): KindRegistry {
  return {
    all: prefixes.map((p) => ({
      name: p.name,
      idPrefix: p.name[0]!.toUpperCase(),
      dataDir: `.operator/data/${p.name}s`,
      branchPrefix: p.branchPrefix,
      terminalStatuses: ["rejected"],
      parentKinds: [],
    })),
  } as unknown as KindRegistry;
}

describe("inferKindFromBranch", () => {
  it("normalises branchPrefix without trailing slash", () => {
    const registry = makeRegistry([
      { name: "task", branchPrefix: "ai/tasks" },
    ]);
    expect(inferKindFromBranch("ai/tasks/T20260511-0001", registry)).toEqual({
      kind: "task",
      id: "T20260511-0001",
    });
  });

  it("accepts branchPrefix that already ends with slash", () => {
    const registry = makeRegistry([
      { name: "finding", branchPrefix: "ai/findings/" },
    ]);
    expect(inferKindFromBranch("ai/findings/F20260511-0001", registry)).toEqual({
      kind: "finding",
      id: "F20260511-0001",
    });
  });

  it("returns null when branch matches no kind prefix", () => {
    const registry = makeRegistry([{ name: "task", branchPrefix: "ai/tasks" }]);
    expect(inferKindFromBranch("feature/unrelated", registry)).toBeNull();
  });

  it("returns null when id segment is empty after prefix", () => {
    const registry = makeRegistry([{ name: "task", branchPrefix: "ai/tasks" }]);
    expect(inferKindFromBranch("ai/tasks/", registry)).toBeNull();
  });
});
