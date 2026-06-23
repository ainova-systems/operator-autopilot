import { describe, it, expect, vi } from "vitest";
import type { FeedbackSource, FeedbackSignal } from "@operator/core";
import { DefaultFeedbackCollector, GitHubCIFeedbackSource } from "./collector.js";

function makeCtx() {
  return {
    traceId: "t", repoId: "r", action: "a",
    budget: { spentUsd: 0, add: vi.fn(), isExceeded: () => false },
    signal: AbortSignal.timeout(30_000),
  };
}

function makeSource(id: string, signals: FeedbackSignal[]): FeedbackSource {
  return {
    id,
    collect: vi.fn().mockResolvedValue(signals),
  };
}

// ── DefaultFeedbackCollector ─────────────────────────────────────────

describe("DefaultFeedbackCollector", () => {
  it("collects signals from all sources", async () => {
    const s1 = makeSource("ci", [{ source: "ci", type: "ci", status: "ok", message: "build ok", capturedAt: "" }]);
    const s2 = makeSource("monitor", [{ source: "monitor", type: "runtime", status: "warning", message: "slow", capturedAt: "" }]);

    const collector = new DefaultFeedbackCollector([s1, s2]);
    const signals = await collector.collectAll({
      projectId: "p1",
      operation: makeCtx(),
    });

    expect(signals).toHaveLength(2);
    expect(s1.collect).toHaveBeenCalled();
    expect(s2.collect).toHaveBeenCalled();
  });

  it("handles source failure gracefully", async () => {
    const good = makeSource("ci", [{ source: "ci", type: "ci", status: "ok", message: "ok", capturedAt: "" }]);
    const bad: FeedbackSource = {
      id: "broken",
      collect: vi.fn().mockRejectedValue(new Error("network error")),
    };

    const collector = new DefaultFeedbackCollector([bad, good]);
    const signals = await collector.collectAll({ projectId: "p1", operation: makeCtx() });

    expect(signals).toHaveLength(1);
    expect(signals[0].source).toBe("ci");
  });

  // ── Assessment ──────────────────────────────────────────────────

  it("assesses healthy when all ok", () => {
    const collector = new DefaultFeedbackCollector([]);
    const assessment = collector.assess([
      { source: "ci", type: "ci", status: "ok", message: "pass", capturedAt: "" },
    ]);

    expect(assessment.status).toBe("healthy");
    expect(assessment.recommendation).toBe("keep");
    expect(assessment.riskScore).toBe(0);
  });

  it("assesses broken when errors present", () => {
    const collector = new DefaultFeedbackCollector([]);
    const assessment = collector.assess([
      { source: "ci", type: "ci", status: "error", message: "fail", capturedAt: "" },
    ]);

    expect(assessment.status).toBe("broken");
    expect(assessment.recommendation).toBe("rollback");
    expect(assessment.riskScore).toBeGreaterThan(0.4);
  });

  it("assesses degraded when only warnings", () => {
    const collector = new DefaultFeedbackCollector([]);
    const assessment = collector.assess([
      { source: "ci", type: "ci", status: "warning", message: "flaky", capturedAt: "" },
    ]);

    expect(assessment.status).toBe("degraded");
    expect(assessment.recommendation).toBe("investigate");
  });

  it("assesses unknown when no signals", () => {
    const collector = new DefaultFeedbackCollector([]);
    const assessment = collector.assess([]);

    expect(assessment.status).toBe("unknown");
    expect(assessment.recommendation).toBe("wait-more");
  });

  it("errors take priority over warnings", () => {
    const collector = new DefaultFeedbackCollector([]);
    const assessment = collector.assess([
      { source: "ci", type: "ci", status: "warning", message: "warn", capturedAt: "" },
      { source: "ci", type: "ci", status: "error", message: "fail", capturedAt: "" },
    ]);

    expect(assessment.status).toBe("broken");
  });

  it("scales risk score with error count", () => {
    const collector = new DefaultFeedbackCollector([]);

    const one = collector.assess([
      { source: "ci", type: "ci", status: "error", message: "f1", capturedAt: "" },
    ]);
    const three = collector.assess([
      { source: "ci", type: "ci", status: "error", message: "f1", capturedAt: "" },
      { source: "ci", type: "ci", status: "error", message: "f2", capturedAt: "" },
      { source: "ci", type: "ci", status: "error", message: "f3", capturedAt: "" },
    ]);

    expect(three.riskScore).toBeGreaterThan(one.riskScore);
    expect(three.riskScore).toBeLessThanOrEqual(1);
  });
});

// ── GitHubCIFeedbackSource ───────────────────────────────────────────

describe("GitHubCIFeedbackSource", () => {
  it("converts check runs to signals", async () => {
    const getChecks = vi.fn().mockResolvedValue([
      { name: "build", conclusion: "success" },
      { name: "test", conclusion: "failure" },
      { name: "lint", conclusion: "neutral" },
    ]);

    const source = new GitHubCIFeedbackSource(getChecks);
    const signals = await source.collect({
      projectId: "p1",
      codeReviewId: 42,
      operation: makeCtx(),
    });

    expect(signals).toHaveLength(3);
    expect(signals[0].status).toBe("ok");
    expect(signals[0].message).toContain("build");
    expect(signals[1].status).toBe("error");
    expect(signals[1].message).toContain("test");
    expect(signals[2].status).toBe("warning");
  });

  it("returns empty when no code review id", async () => {
    const source = new GitHubCIFeedbackSource(vi.fn());
    const signals = await source.collect({ projectId: "p1", operation: makeCtx() });

    expect(signals).toHaveLength(0);
  });
});
