import { describe, it, expect } from "vitest";
import { reconcileEffectiveStatus, computeDrift } from "./status-reconcile.js";
import type { StatusSources } from "./schemas/work-item.schema.js";

const ts = (n = 1): string => `2026-04-17T10:00:0${n}Z`;

describe("reconcileEffectiveStatus", () => {
  it("develop-file (non-terminal) overrides terminal-sticky — finding/task can cycle merged → pending after a fresh PR opens", () => {
    // Regression: F20260416-0001 / F20260416-0002 sat with `status:
    // merged` (set when an old PR for the same finding actually
    // merged) while develop reverted to `pending` (a new finding-plan
    // PR re-bumped frontmatter). The reconciler used to honor
    // sticky-merged forever, leaving hasDrift=true permanently. The
    // current rule lets develop win whenever it carries a real
    // non-terminal value.
    const sources: StatusSources = {
      developFile: { value: "pending", observedAt: ts(1), sha: "abc" },
      prLabel: { value: "ai:pending", observedAt: ts(2) },
    };
    const result = reconcileEffectiveStatus({
      sources,
      currentKV: { status: "completed" },
    });
    // pr-label dominates develop-file in the precedence chain, but
    // both agree on "pending" — the assertion that matters is that
    // `terminal-sticky` did NOT short-circuit to "completed".
    expect(result.effectiveStatus).toBe("pending");
    expect(result.effectiveStatusReason).not.toBe("terminal-sticky");
  });

  it("terminal-sticky still wins when develop-file flickers to missing (transient rebase race)", () => {
    // Original sticky rationale: protect against momentary
    // `developFile.value === "missing"` during a rebase / fetch.
    const result = reconcileEffectiveStatus({
      sources: { developFile: { value: "missing", observedAt: ts() } },
      currentKV: { status: "completed" },
    });
    expect(result).toEqual({
      effectiveStatus: "completed",
      effectiveStatusReason: "terminal-sticky",
    });
  });

  it("terminal-sticky still wins when no develop-file observation present at all", () => {
    const result = reconcileEffectiveStatus({
      sources: {},
      currentKV: { status: "completed" },
    });
    expect(result.effectiveStatus).toBe("completed");
    expect(result.effectiveStatusReason).toBe("terminal-sticky");
  });

  it("terminal-sticky still wins when develop carries another terminal value (e.g. file says rejected, KV says completed)", () => {
    // Both terminals — sticky preserves the historically-observed
    // one rather than swapping to a different terminal.
    const result = reconcileEffectiveStatus({
      sources: { developFile: { value: "rejected", observedAt: ts() } },
      currentKV: { status: "completed" },
    });
    expect(result.effectiveStatus).toBe("completed");
    expect(result.effectiveStatusReason).toBe("terminal-sticky");
  });

  it("terminal-sticky also applies on currentKV.developFileStatus when status is not set, develop missing", () => {
    const result = reconcileEffectiveStatus({
      sources: { developFile: { value: "missing", observedAt: ts() } },
      currentKV: { developFileStatus: "failed" },
    });
    expect(result.effectiveStatus).toBe("failed");
    expect(result.effectiveStatusReason).toBe("terminal-sticky");
  });

  it("execution-verdict dominates over PR label and develop file when non-terminal KV", () => {
    const sources: StatusSources = {
      developFile: { value: "pending", observedAt: ts() },
      prLabel: { value: "ai:processing", observedAt: ts() },
      executionVerdict: {
        value: "approved",
        observedAt: ts(),
        executionId: "e-1",
      },
    };
    const result = reconcileEffectiveStatus({ sources, currentKV: { status: "in-progress" } });
    expect(result).toEqual({
      effectiveStatus: "completed",
      effectiveStatusReason: "execution-verdict",
    });
  });

  it("execution-verdict=failed maps to failed", () => {
    const result = reconcileEffectiveStatus({
      sources: {
        executionVerdict: { value: "failed", observedAt: ts(), executionId: "e-2" },
      },
    });
    expect(result.effectiveStatus).toBe("failed");
    expect(result.effectiveStatusReason).toBe("execution-verdict");
  });

  it("pr-label is used when no execution-verdict observation exists", () => {
    const result = reconcileEffectiveStatus({
      sources: {
        developFile: { value: "pending", observedAt: ts() },
        prLabel: { value: "ai:in-progress", observedAt: ts() },
      },
    });
    expect(result).toEqual({
      effectiveStatus: "in-progress",
      effectiveStatusReason: "pr-label",
    });
  });

  it("ignores a stale pr-label and does not latch ready-to-merge when prState is none (orphan-latch regression)", () => {
    // Regression: 8 findings sat at `ready-to-merge` with no live PR
    // (codeReviewId=null) while their develop file said `in-progress`.
    // A prLabel slot (`ai:ready-to-merge`) carried forward from a prior
    // PR cycle kept winning at the pr-label step every cycle, pinning the
    // item in non-terminal limbo forever. With prState=none the label is
    // meaningless and must be skipped so develop-file wins.
    const result = reconcileEffectiveStatus({
      sources: {
        developFile: { value: "in-progress", observedAt: ts(1) },
        prLabel: { value: "ai:ready-to-merge", observedAt: ts(2) },
        prState: { value: "none", observedAt: ts(3) },
      },
      currentKV: { status: "ready-to-merge" },
    });
    expect(result.effectiveStatus).toBe("in-progress");
    expect(result.effectiveStatusReason).toBe("develop-file");
  });

  it("still honors pr-label when a PR exists (prState=open)", () => {
    // Guard: the orphan-latch fix must not break the normal case — when
    // the PR is live, its label remains the authoritative signal.
    const result = reconcileEffectiveStatus({
      sources: {
        developFile: { value: "in-progress", observedAt: ts(1) },
        prLabel: { value: "ai:ready-to-merge", observedAt: ts(2) },
        prState: { value: "open", observedAt: ts(3) },
      },
    });
    expect(result.effectiveStatus).toBe("ready-to-merge");
    expect(result.effectiveStatusReason).toBe("pr-label");
  });

  it("ignores a stale pr-label when the PR is closed, not just gone (closed-PR-latch regression)", () => {
    // The first orphan-latch fix only skipped the label for prState=none.
    // A PR closed WITHOUT merge (prState=closed) keeps its last label
    // (`ai:ready-to-merge`) too; trusting it still latched the item. The
    // label is live only for an OPEN PR — closed → develop-file decides.
    const result = reconcileEffectiveStatus({
      sources: {
        developFile: { value: "pending", observedAt: ts(1) },
        prLabel: { value: "ai:ready-to-merge", observedAt: ts(2) },
        prState: { value: "closed", observedAt: ts(3) },
      },
      currentKV: { status: "ready-to-merge" },
    });
    expect(result.effectiveStatus).toBe("pending");
    expect(result.effectiveStatusReason).toBe("develop-file");
  });

  it("pr-label that does not map to a known status falls through to develop file", () => {
    const result = reconcileEffectiveStatus({
      sources: {
        developFile: { value: "pending", observedAt: ts() },
        prLabel: { value: "ai:ready-for-review", observedAt: ts() },
      },
    });
    expect(result.effectiveStatusReason).toBe("develop-file");
    expect(result.effectiveStatus).toBe("pending");
  });

  it("develop-file is used when no other observations are available", () => {
    const result = reconcileEffectiveStatus({
      sources: {
        developFile: { value: "in-progress", observedAt: ts() },
      },
    });
    expect(result).toEqual({
      effectiveStatus: "in-progress",
      effectiveStatusReason: "develop-file",
    });
  });

  it("develop-file='missing' is skipped (treated as absent)", () => {
    const result = reconcileEffectiveStatus({
      sources: {
        developFile: { value: "missing", observedAt: ts() },
      },
      currentKV: { status: "pending" },
    });
    expect(result.effectiveStatusReason).toBe("initial");
    expect(result.effectiveStatus).toBe("pending");
  });

  it("falls back to currentKV.status when no observations are usable", () => {
    const result = reconcileEffectiveStatus({
      sources: {},
      currentKV: { status: "in-progress" },
    });
    expect(result).toEqual({
      effectiveStatus: "in-progress",
      effectiveStatusReason: "initial",
    });
  });

  it("defaults to pending when neither observations nor currentKV are available", () => {
    const result = reconcileEffectiveStatus({ sources: {} });
    expect(result).toEqual({
      effectiveStatus: "pending",
      effectiveStatusReason: "initial",
    });
  });

  it("unknown execution-verdict string falls through to next source", () => {
    const result = reconcileEffectiveStatus({
      sources: {
        // Passing an intentionally-unknown verdict via a cast — the runtime
        // strictness is enforced by the Zod schema at write time; reconcile
        // must still degrade gracefully.
        executionVerdict: { value: "weird" as "approved", observedAt: ts(), executionId: "e" },
        developFile: { value: "pending", observedAt: ts() },
      },
    });
    expect(result.effectiveStatusReason).toBe("develop-file");
  });
});

describe("computeDrift", () => {
  it("returns no drift when fewer than two observations are usable", () => {
    expect(computeDrift({})).toEqual({ hasDrift: false, isActive: false, driftDetails: [] });
    expect(
      computeDrift({ developFile: { value: "pending", observedAt: ts() } }),
    ).toEqual({ hasDrift: false, isActive: false, driftDetails: [] });
  });

  it("returns no drift when every usable observation agrees", () => {
    const result = computeDrift({
      developFile: { value: "completed", observedAt: ts() },
      featureBranchFile: { value: "completed", observedAt: ts() },
      executionVerdict: { value: "approved", observedAt: ts(), executionId: "e" },
    });
    expect(result.hasDrift).toBe(false);
    expect(result.driftDetails).toEqual([]);
  });

  it("flags drift when develop file disagrees with PR label (no PR state)", () => {
    // Without prState observation, the selector falls back to the
    // label-only codepath which cannot distinguish in-flight from drift —
    // so the legacy "any mismatch is drift" behavior applies.
    const result = computeDrift({
      developFile: { value: "pending", observedAt: ts() },
      prLabel: { value: "ai:in-progress", observedAt: ts() },
    });
    expect(result.hasDrift).toBe(true);
    expect(result.driftDetails).toEqual([
      "develop-file=pending",
      "pr-label=in-progress",
    ]);
  });

  it("flags drift across all four sources when mixed", () => {
    const result = computeDrift({
      developFile: { value: "pending", observedAt: ts() },
      featureBranchFile: { value: "in-progress", observedAt: ts() },
      prLabel: { value: "ai:in-review", observedAt: ts() },
      executionVerdict: { value: "failed", observedAt: ts(), executionId: "e" },
    });
    expect(result.hasDrift).toBe(true);
    expect(result.driftDetails.length).toBe(4);
  });

  // ── prState-aware in-flight detection ───────

  it("open PR + branch completed + label in-review + develop pending = ACTIVE, not drift", async () => {
    const result = computeDrift({
      developFile: { value: "pending", observedAt: ts() },
      featureBranchFile: { value: "completed", observedAt: ts() },
      prLabel: { value: "ai:in-review", observedAt: ts() },
      executionVerdict: { value: "approved", observedAt: ts(), executionId: "e" },
      prState: { value: "open", observedAt: ts() },
    });
    expect(result.hasDrift).toBe(false);
    expect(result.isActive).toBe(true);
  });

  it("merged PR + develop still pending IS drift (human merged but sync lagged)", () => {
    const result = computeDrift({
      developFile: { value: "pending", observedAt: ts() },
      featureBranchFile: { value: "completed", observedAt: ts() },
      prLabel: { value: "ai:in-review", observedAt: ts() },
      executionVerdict: { value: "approved", observedAt: ts(), executionId: "e" },
      prState: { value: "merged", observedAt: ts() },
    });
    expect(result.hasDrift).toBe(true);
    expect(result.isActive).toBe(false);
  });

  it("develop completed but engine side still pending IS drift (human fixed manually)", () => {
    const result = computeDrift({
      developFile: { value: "completed", observedAt: ts() },
      prLabel: { value: "ai:pending", observedAt: ts() },
      prState: { value: "open", observedAt: ts() },
    });
    expect(result.hasDrift).toBe(true);
    expect(result.isActive).toBe(false);
  });

  it("closed (not merged) PR with mismatched sources IS drift (task was cancelled)", () => {
    const result = computeDrift({
      developFile: { value: "pending", observedAt: ts() },
      featureBranchFile: { value: "completed", observedAt: ts() },
      prLabel: { value: "ai:failed", observedAt: ts() },
      prState: { value: "closed", observedAt: ts() },
    });
    expect(result.hasDrift).toBe(true);
    expect(result.isActive).toBe(false);
  });

  it("ignores 'missing' develop observations", () => {
    const result = computeDrift({
      developFile: { value: "missing", observedAt: ts() },
      prLabel: { value: "ai:in-review", observedAt: ts() },
    });
    expect(result.hasDrift).toBe(false);
  });

  it("unmappable PR label is ignored for drift purposes", () => {
    const result = computeDrift({
      developFile: { value: "pending", observedAt: ts() },
      prLabel: { value: "ai:random", observedAt: ts() },
    });
    expect(result.hasDrift).toBe(false);
  });

  it("unmappable execution verdict is ignored for drift purposes", () => {
    const result = computeDrift({
      developFile: { value: "pending", observedAt: ts() },
      executionVerdict: { value: "nope" as "approved", observedAt: ts(), executionId: "e" },
    });
    expect(result.hasDrift).toBe(false);
  });
});
