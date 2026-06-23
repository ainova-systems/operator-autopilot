import { describe, it, expect } from "vitest";
import {
  executionScore,
  workItemScore,
  SCORE_FLOOR,
  type ExecutionDataPoint,
} from "./success-score.js";

describe("executionScore", () => {
  it("returns 1 for a clean one-shot approved verdict", () => {
    expect(executionScore({ verdict: "approved", attempts: 1 })).toBe(1);
  });

  it("treats rejected as terminal success (caught false positive) — same as approved", () => {
    expect(executionScore({ verdict: "rejected", attempts: 1 })).toBe(1);
  });

  it("returns 0 for failed verdict regardless of attempts", () => {
    expect(executionScore({ verdict: "failed", attempts: 1 })).toBe(0);
    expect(executionScore({ verdict: "failed", attempts: 3 })).toBe(0);
  });

  it("returns 0 for cancelled verdict", () => {
    expect(executionScore({ verdict: "cancelled", attempts: 1 })).toBe(0);
  });

  it("returns undefined for unknown / pending verdict", () => {
    expect(executionScore({ verdict: undefined, attempts: 1 })).toBeUndefined();
    expect(executionScore({ verdict: "retry", attempts: 1 })).toBeUndefined();
    expect(executionScore({ verdict: "", attempts: 1 })).toBeUndefined();
  });

  it("penalises one internal retry by 0.7", () => {
    expect(executionScore({ verdict: "approved", attempts: 2 })).toBe(0.7);
  });

  it("penalises two internal retries by 0.49", () => {
    expect(executionScore({ verdict: "approved", attempts: 3 })).toBe(0.49);
  });

  it("clamps to SCORE_FLOOR for chains that would go below the floor", () => {
    // attempts=20 → 0.7^19 ≈ 0.0011, well under SCORE_FLOOR
    const score = executionScore({ verdict: "approved", attempts: 20 });
    expect(score).toBe(SCORE_FLOOR);
  });

  it("never returns NaN for attempts=0 (defensive — treated as no retry)", () => {
    expect(executionScore({ verdict: "approved", attempts: 0 })).toBe(1);
  });
});

describe("workItemScore — base by status", () => {
  it("returns 1 for merged status", () => {
    expect(workItemScore({ status: "merged", executions: [] })).toBe(1);
  });

  it("returns 1 for completed status", () => {
    expect(workItemScore({ status: "completed", executions: [] })).toBe(1);
  });

  it("returns 1 for rejected status (caught false positive)", () => {
    expect(workItemScore({ status: "rejected", executions: [] })).toBe(1);
  });

  // T-601 Phase A (2026-05-20): `accepted` is the non-VCS terminal-
  // success synonym for `merged`. Once Phase B flips the reconciler
  // write path, new merges will land as `accepted` — scoring must
  // already treat it as success or KV-side success-rate stats break
  // overnight.
  it("returns 1 for accepted status (T-601 Phase A — same as merged)", () => {
    expect(workItemScore({ status: "accepted", executions: [] })).toBe(1);
  });

  it("returns 0 for failed / cancelled / duplicate", () => {
    expect(workItemScore({ status: "failed", executions: [] })).toBe(0);
    expect(workItemScore({ status: "cancelled", executions: [] })).toBe(0);
    expect(workItemScore({ status: "duplicate", executions: [] })).toBe(0);
  });

  it("returns undefined for any in-flight status", () => {
    expect(workItemScore({ status: "pending", executions: [] })).toBeUndefined();
    expect(workItemScore({ status: "in-progress", executions: [] })).toBeUndefined();
    expect(workItemScore({ status: "in-review", executions: [] })).toBeUndefined();
    expect(workItemScore({ status: "ready-to-merge", executions: [] })).toBeUndefined();
  });
});

describe("workItemScore — penalty multipliers", () => {
  // Helper for readability.
  const exec = (verdict?: string, agent?: string): ExecutionDataPoint => ({ verdict, agent });

  it("merged with one supervisor (pr-review) cycle pays no penalty (first is free)", () => {
    const score = workItemScore({
      status: "merged",
      executions: [exec("approved", "creator"), exec("approved", "supervisor")],
    });
    expect(score).toBe(1);
  });

  it("merged with two supervisor cycles penalises ×0.85 once", () => {
    const score = workItemScore({
      status: "merged",
      executions: [
        exec("approved", "creator"),
        exec("approved", "supervisor"),
        exec("approved", "supervisor"),
      ],
    });
    expect(score).toBe(0.85);
  });

  it("merged with three supervisor cycles penalises ×0.85^2", () => {
    const score = workItemScore({
      status: "merged",
      executions: [
        exec("approved", "creator"),
        exec("approved", "supervisor"),
        exec("approved", "supervisor"),
        exec("approved", "supervisor"),
      ],
    });
    expect(score).toBe(0.7225);
  });

  it("merged with one failed creator execution penalises ×0.7", () => {
    const score = workItemScore({
      status: "merged",
      executions: [exec("failed", "creator"), exec("approved", "creator")],
    });
    expect(score).toBe(0.7);
  });

  it("merged with two failed executions penalises ×0.7^2 ≈ 0.49", () => {
    const score = workItemScore({
      status: "merged",
      executions: [
        exec("failed", "creator"),
        exec("failed", "creator"),
        exec("approved", "creator"),
      ],
    });
    expect(score).toBe(0.49);
  });

  it("combines pr-review cycles and failed executions multiplicatively", () => {
    // 2 supervisor cycles = ×0.85, 1 failed exec = ×0.7 → 0.595
    const score = workItemScore({
      status: "merged",
      executions: [
        exec("failed", "creator"),
        exec("approved", "creator"),
        exec("approved", "supervisor"),
        exec("approved", "supervisor"),
      ],
    });
    expect(score).toBe(0.595);
  });

  it("clamps deep multiplier chains to SCORE_FLOOR", () => {
    // 6 supervisor cycles × 5 failed execs → 0.85^5 × 0.7^5 ≈ 0.075. Add one more failed → 0.052
    // We arrange to land below 0.05.
    const score = workItemScore({
      status: "merged",
      executions: [
        ...Array(7).fill(exec("approved", "supervisor")), // 6 past first
        ...Array(8).fill(exec("failed", "creator")),
      ],
    });
    expect(score).toBe(SCORE_FLOOR);
  });

  it("failed work-item status returns 0 regardless of execution detail", () => {
    const score = workItemScore({
      status: "failed",
      executions: [exec("approved", "creator")],
    });
    expect(score).toBe(0);
  });

  it("duplicate work-item status returns 0 (terminal failure per policy)", () => {
    const score = workItemScore({
      status: "duplicate",
      executions: [exec("approved", "creator")],
    });
    expect(score).toBe(0);
  });
});

describe("workItemScore — regression scenarios", () => {
  // Real-world shape from PR #886 — T20260411-000106: clean one-shot
  // execution of creator + verifier, no pr-review cycle yet. After merge,
  // work-item score should land at exactly 1.0.
  it("one-shot task: 1 creator execution approved → merged → score=1", () => {
    const score = workItemScore({
      status: "merged",
      executions: [{ verdict: "approved", agent: "creator" }],
    });
    expect(score).toBe(1);
  });

  // Real-world shape from a noisy CI flow: creator approved, then a
  // reviewer left a comment, supervisor responded twice (one cycle
  // bounced back), eventually merged. Score should reflect "needed extra
  // cycle" without crushing to zero.
  it("PR with two supervisor cycles after creator → score=0.85", () => {
    const score = workItemScore({
      status: "merged",
      executions: [
        { verdict: "approved", agent: "creator" },
        { verdict: "approved", agent: "supervisor" },
        { verdict: "approved", agent: "supervisor" },
      ],
    });
    expect(score).toBe(0.85);
  });
});
