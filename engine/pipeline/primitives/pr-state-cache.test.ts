import { describe, it, expect } from "vitest";
import type { CodeReview, KVStore, OperationContext } from "@operator/core";
import { recordTerminalPRStates, readCachedPRState } from "./pr-state-cache.js";

// ── In-memory KVStore stub ───────────────────────────────────────────

function makeKV(): KVStore {
  const store = new Map<string, { key: string; value: unknown; updatedAt: string }>();
  return {
    async get(category, key) {
      const entry = store.get(`${category}/${key}`);
      return entry ? { key: entry.key, value: entry.value, updatedAt: entry.updatedAt } : null;
    },
    async put(category, key, value) {
      store.set(`${category}/${key}`, {
        key,
        value,
        updatedAt: new Date().toISOString(),
      });
    },
    async delete(category, key) {
      store.delete(`${category}/${key}`);
    },
    async list(category) {
      const out: Array<{ key: string; value: unknown; updatedAt: string }> = [];
      for (const [k, v] of store) {
        if (k.startsWith(`${category}/`)) out.push(v);
      }
      return out;
    },
  } as unknown as KVStore;
}

function makeCtx(): OperationContext {
  return {
    traceId: "trace",
    repoId: "sample",
    action: "test",
    budget: { limitUsd: undefined, spentUsd: 0, add: () => {}, isExceeded: () => false },
    signal: AbortSignal.timeout(10_000),
  };
}

function makePR(overrides: Partial<CodeReview>): CodeReview {
  return {
    id: 1, title: "PR", url: "", branch: "ai/findings/F1", baseBranch: "develop",
    draft: false, labels: [], comments: [],
    merged: false, closed: true,
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────────

describe("recordTerminalPRStates", () => {
  it("upserts a row per terminal PR (closed/merged) and skips open ones", async () => {
    const kv = makeKV();
    const prs: CodeReview[] = [
      makePR({ id: 780, merged: true, closed: true, branch: "ai/findings/F1", title: "p1", updatedAt: "2026-04-29T10:00:00Z" }),
      makePR({ id: 808, merged: true, closed: true, branch: "ai/findings/F1", title: "p2", updatedAt: "2026-05-01T10:00:00Z" }),
      makePR({ id: 820, merged: false, closed: true, branch: "ai/findings/F1", title: "p3", updatedAt: "2026-05-01T11:00:00Z" }),
      makePR({ id: 900, merged: false, closed: false, branch: "ai/tasks/T1", title: "open" }),
    ];
    await recordTerminalPRStates(prs, kv, makeCtx());

    const rows = await kv.list("pr-states");
    expect(rows.map((r) => r.key).sort()).toEqual(["780", "808", "820"]);
    const merged780 = rows.find((r) => r.key === "780")!.value as { state: string; mergedAt?: string };
    expect(merged780.state).toBe("merged");
    expect(merged780.mergedAt).toBe("2026-04-29T10:00:00Z");
    const closed820 = rows.find((r) => r.key === "820")!.value as { state: string; closedAt?: string };
    expect(closed820.state).toBe("closed");
    expect(closed820.closedAt).toBe("2026-05-01T11:00:00Z");
  });

  it("does NOT overwrite a merged row (merged is final on GitHub)", async () => {
    const kv = makeKV();
    // First observation: PR #780 merged.
    await recordTerminalPRStates(
      [makePR({ id: 780, merged: true, closed: true, branch: "ai/x" })],
      kv, makeCtx(),
    );
    // Second observation: same PR somehow returns closed=true, merged=false (impossible
    // in real GitHub, but tests the "merged is final" guarantee).
    await recordTerminalPRStates(
      [makePR({ id: 780, merged: false, closed: true, branch: "ai/x" })],
      kv, makeCtx(),
    );
    const cached = await readCachedPRState(kv, 780);
    expect(cached?.state).toBe("merged");
  });

  it("readCachedPRState returns null when the PR was never observed", async () => {
    const kv = makeKV();
    expect(await readCachedPRState(kv, 999)).toBeNull();
  });

  it("idempotent: re-recording same merged PR is a no-op", async () => {
    const kv = makeKV();
    const pr = makePR({ id: 808, merged: true, closed: true, branch: "ai/findings/F1" });
    await recordTerminalPRStates([pr], kv, makeCtx());
    const first = await readCachedPRState(kv, 808);
    await recordTerminalPRStates([pr], kv, makeCtx());
    const second = await readCachedPRState(kv, 808);
    expect(second?.observedAt).toBe(first?.observedAt);
  });
});
