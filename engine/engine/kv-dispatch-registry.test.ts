import { describe, it, expect, vi } from "vitest";
import type { DefaultsConfig, KVStore, StageDispatchEntry } from "@operator/core";
import { buildStageDispatchRegistryFromKV } from "./kv-dispatch-registry.js";

function makeDefaults(): DefaultsConfig {
  return {
    schedules: {
      prReviewMinutes: 5, taskSelectMinutes: 15, findingSelectMinutes: 30,
      dailyResearchHour: 8, improverDayOfWeek: 1, prLifecycleMinutes: 30,
    },
    limits: { maxReviewAttempts: 5 },
    review: { ignoredBotLogins: [] },
    lifecycle: {},
  };
}

function makeKv(rows: { key: string; value: unknown }[]): KVStore {
  return {
    list: vi.fn().mockResolvedValue(rows),
    get: vi.fn(), put: vi.fn(), delete: vi.fn(), close: vi.fn(),
  } as unknown as KVStore;
}

const FINDING_PLAN_ROW = {
  key: "finding-plan",
  value: {
    name: "finding-plan",
    dispatch: {
      order: 50,
      featureFlags: ["findingExecute", "findingSelect"],
      schedule: { kind: "interval", intervalMinutes: 30, stateKey: "findingSelect" },
    },
  },
};

const INIT_ROW = {
  key: "init",
  value: {
    name: "init",
    dispatch: { order: 10, schedule: { kind: "always" } },
  },
};

const RESEARCH_ROW = {
  key: "research",
  value: {
    name: "research",
    dispatch: {
      order: 70,
      featureFlags: ["dailyResearch"],
      schedule: { kind: "daily", hourUtc: 8, guardMinutes: 1200, stateKey: "research" },
    },
  },
};

describe("buildStageDispatchRegistryFromKV", () => {
  it("returns one StageDispatchEntry per KV stage row carrying a dispatch block", async () => {
    const kv = makeKv([INIT_ROW, FINDING_PLAN_ROW, RESEARCH_ROW]);
    const registry = await buildStageDispatchRegistryFromKV(kv, makeDefaults());
    const actions = registry.normalOrder.map((e) => e.action);
    expect(actions).toEqual(["init", "finding-plan", "research"]); // sorted by order 10, 50, 70
  });

  it("skips KV rows that don't carry a `dispatch` block (workflow-stage row present but not dispatched)", async () => {
    const nonDispatchedRow = {
      key: "experimental",
      value: { name: "experimental" /* no dispatch */ },
    };
    const kv = makeKv([INIT_ROW, nonDispatchedRow]);
    const registry = await buildStageDispatchRegistryFromKV(kv, makeDefaults());
    expect(registry.normalOrder.map((e) => e.action)).toEqual(["init"]);
    expect(registry.get("experimental")).toBeUndefined();
  });

  it("merges composition-root extras with KV entries and sorts by order across both sources", async () => {
    const branchCleanup: StageDispatchEntry = {
      action: "branch-cleanup",
      order: 20,
      schedule: { kind: "interval", intervalMinutes: 5, stateKey: "cleanup" },
      isEnabled: () => true,
    };
    const kv = makeKv([INIT_ROW, RESEARCH_ROW]); // orders 10, 70
    const registry = await buildStageDispatchRegistryFromKV(kv, makeDefaults(), [branchCleanup]);
    expect(registry.normalOrder.map((e) => e.action)).toEqual(["init", "branch-cleanup", "research"]);
  });

  it("compound featureFlags AND every named flag — any `false` disables the stage", async () => {
    const kv = makeKv([FINDING_PLAN_ROW]);
    const registry = await buildStageDispatchRegistryFromKV(kv, makeDefaults());
    const entry = registry.get("finding-plan")!;
    expect(entry.isEnabled({ findingSelect: false })).toBe(false);
    expect(entry.isEnabled({ findingExecute: false })).toBe(false);
    expect(entry.isEnabled({ findingSelect: true, findingExecute: true })).toBe(true);
    expect(entry.isEnabled({} as never)).toBe(true); // missing keys = grant
    expect(entry.isEnabled(undefined)).toBe(true);
  });

  it("single featureFlag entry — only that key is checked", async () => {
    const kv = makeKv([RESEARCH_ROW]);
    const registry = await buildStageDispatchRegistryFromKV(kv, makeDefaults());
    const entry = registry.get("research")!;
    expect(entry.isEnabled({ dailyResearch: false })).toBe(false);
    expect(entry.isEnabled({ dailyResearch: true })).toBe(true);
    expect(entry.isEnabled({ taskExecute: false } as never)).toBe(true); // unrelated flag
  });

  it("returns isEnabled=true for stages with empty / missing featureFlags array (no gate)", async () => {
    const kv = makeKv([INIT_ROW]);
    const registry = await buildStageDispatchRegistryFromKV(kv, makeDefaults());
    expect(registry.get("init")!.isEnabled({ anything: false } as never)).toBe(true);
  });

  it("forceChain returns self-chain for known actions, undefined for unknown", async () => {
    const kv = makeKv([INIT_ROW, FINDING_PLAN_ROW]);
    const registry = await buildStageDispatchRegistryFromKV(kv, makeDefaults());
    expect(registry.forceChain("init")).toEqual(["init"]);
    expect(registry.forceChain("finding-plan")).toEqual(["finding-plan"]);
    expect(registry.forceChain("no-such-stage")).toBeUndefined();
  });

  it("throws when an extras action collides with a KV-defined action", async () => {
    const dup: StageDispatchEntry = {
      action: "init", order: 999,
      schedule: { kind: "always" }, isEnabled: () => true,
    };
    const kv = makeKv([INIT_ROW]);
    await expect(buildStageDispatchRegistryFromKV(kv, makeDefaults(), [dup]))
      .rejects.toThrow(/Duplicate dispatch entry/);
  });

  it("handles empty KV gracefully (only extras land in the registry)", async () => {
    const extra: StageDispatchEntry = {
      action: "branch-cleanup", order: 20,
      schedule: { kind: "interval", intervalMinutes: 5, stateKey: "cleanup" },
      isEnabled: () => true,
    };
    const kv = makeKv([]);
    const registry = await buildStageDispatchRegistryFromKV(kv, makeDefaults(), [extra]);
    expect(registry.normalOrder).toHaveLength(1);
    expect(registry.normalOrder[0].action).toBe("branch-cleanup");
  });

  it("preserves the schedule shape from the KV row verbatim (no transformation)", async () => {
    const kv = makeKv([RESEARCH_ROW]);
    const registry = await buildStageDispatchRegistryFromKV(kv, makeDefaults());
    expect(registry.get("research")!.schedule).toEqual({
      kind: "daily", hourUtc: 8, guardMinutes: 1200, stateKey: "research",
    });
  });
});
