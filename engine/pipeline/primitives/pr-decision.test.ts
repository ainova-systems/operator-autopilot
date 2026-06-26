import { describe, it, expect } from "vitest";
import type { Comment, ChecksObservation, CheckRun } from "@operator/core";
import {
  filterUnansweredComments,
  classifyPrFeedback,
  type PrSignals,
} from "./pr-decision.js";

const MARKER = "<!-- bot:operator -->";

function comment(over: Partial<Comment> = {}): Comment {
  return {
    id: over.id ?? "1",
    author: over.author ?? "alice",
    body: over.body ?? "please fix this",
    createdAt: over.createdAt ?? "2026-06-22T10:00:00Z",
    authorAssociation: over.authorAssociation,
    authorType: over.authorType,
    path: over.path,
  };
}

function check(over: Partial<CheckRun> = {}): CheckRun {
  return {
    name: over.name ?? "build",
    conclusion: over.conclusion ?? "success",
    completedAt: over.completedAt,
    headSha: over.headSha,
  };
}

function checks(value: ChecksObservation["value"], over: Partial<ChecksObservation> = {}): ChecksObservation {
  return {
    value,
    observedAt: "2026-06-22T10:00:00Z",
    headSha: over.headSha,
    checks: over.checks ?? [],
    failureMode: over.failureMode,
  };
}

function signals(over: Partial<PrSignals> = {}): PrSignals {
  return {
    comments: over.comments ?? [],
    reviewComments: over.reviewComments ?? [],
    checks: over.checks ?? checks("none"),
  };
}

const CFG = { marker: MARKER, ignoredBotLogins: ["github-actions[bot]"], maxCiRetryAttempts: 3 };

describe("filterUnansweredComments", () => {
  const empty = new Set<string>();

  it("excludes the operator's own marker comments", () => {
    const c = comment({ body: `done ${MARKER}` });
    expect(filterUnansweredComments([c], MARKER, empty)).toHaveLength(0);
  });

  it("excludes ids already in the responded set", () => {
    const c = comment({ id: "42", authorAssociation: "OWNER" });
    expect(filterUnansweredComments([c], MARKER, new Set(["42"]))).toHaveLength(0);
  });

  it("includes a non-ignored bot (Copilot)", () => {
    const c = comment({ author: "Copilot", authorType: "Bot", authorAssociation: "NONE" });
    expect(filterUnansweredComments([c], MARKER, empty, ["github-actions[bot]"])).toHaveLength(1);
  });

  it("excludes an explicitly ignored bot", () => {
    const c = comment({ author: "github-actions[bot]", authorType: "Bot" });
    expect(filterUnansweredComments([c], MARKER, empty, ["github-actions[bot]"])).toHaveLength(0);
  });

  it("includes a trusted-association human", () => {
    const c = comment({ authorAssociation: "MEMBER" });
    expect(filterUnansweredComments([c], MARKER, empty)).toHaveLength(1);
  });

  it("includes a human with no association field", () => {
    const c = comment({ authorAssociation: undefined });
    expect(filterUnansweredComments([c], MARKER, empty)).toHaveLength(1);
  });

  it("excludes an untrusted-association human (drive-by NONE)", () => {
    const c = comment({ authorAssociation: "NONE" });
    expect(filterUnansweredComments([c], MARKER, empty)).toHaveLength(0);
  });
});

describe("classifyPrFeedback", () => {
  it("defers when CI is pending", () => {
    const state = classifyPrFeedback(signals({ checks: checks("pending") }), CFG);
    expect(state.verdict).toBe("ci-pending");
    expect(state.freshComments).toHaveLength(0);
  });

  it("classifies an unanswered Copilot review comment as needs-review (the #1132 case)", () => {
    const review = comment({
      id: "c1", author: "Copilot", authorType: "Bot", authorAssociation: "NONE",
      path: "src/x.ts", createdAt: "2026-06-22T23:56:25Z",
    });
    const state = classifyPrFeedback(
      signals({ reviewComments: [review], checks: checks("passing", { checks: [check({ conclusion: "success" })] }) }),
      CFG,
    );
    expect(state.verdict).toBe("needs-review");
    expect(state.freshReviewComments).toHaveLength(1);
    expect(state.oldestFreshAt).toBe("2026-06-22T23:56:25Z");
  });

  it("classifies a clean in-review PR (no unanswered feedback, CI passing) as clean", () => {
    const state = classifyPrFeedback(
      signals({ checks: checks("passing", { checks: [check({ conclusion: "success" })] }) }),
      CFG,
    );
    expect(state.verdict).toBe("clean");
  });

  it("treats a PR with no comments and no checks as clean", () => {
    expect(classifyPrFeedback(signals(), CFG).verdict).toBe("clean");
  });

  it("treats comments already marked responded as clean (no re-review)", () => {
    const review = comment({ id: "c1", author: "Copilot", authorType: "Bot" });
    const botReply = comment({
      id: "b1", author: "operator", body: `Applied review feedback.\n${MARKER}\n<!-- bot:operator/attribution\nresponded: c1\n-->`,
      createdAt: "2026-06-23T00:10:00Z",
    });
    const state = classifyPrFeedback(signals({ comments: [botReply], reviewComments: [review] }), CFG);
    expect(state.verdict).toBe("clean");
  });

  it("treats a fresh failing check as needs-review with the CI completedAt as oldestFreshAt", () => {
    const failing = check({ name: "tests", conclusion: "failure", completedAt: "2026-06-22T12:00:00Z", headSha: "abc" });
    const state = classifyPrFeedback(
      signals({ checks: checks("failing", { headSha: "abc", checks: [failing] }) }),
      CFG,
    );
    expect(state.verdict).toBe("needs-review");
    expect(state.ci.failingChecks).toHaveLength(1);
    expect(state.oldestFreshAt).toBe("2026-06-22T12:00:00Z");
  });

  it("escalates when the CI retry budget is spent on the same head SHA", () => {
    const failing = check({ name: "tests", conclusion: "failure", headSha: "abc" });
    const botReply = comment({
      author: "operator",
      body: `retrying ${MARKER}\n<!-- bot:operator/attribution\nci-head: abc\nci-attempt: 3/3\n-->`,
    });
    const state = classifyPrFeedback(
      signals({ comments: [botReply], checks: checks("failing", { headSha: "abc", checks: [failing] }) }),
      CFG,
    );
    expect(state.verdict).toBe("ci-exhausted");
    expect(state.ci.exhausted).toBe(true);
    expect(state.ci.attempts).toBe(3);
  });

  it("does NOT escalate when the head SHA changed (budget resets)", () => {
    const failing = check({ name: "tests", conclusion: "failure", headSha: "def" });
    const botReply = comment({
      author: "operator",
      body: `retrying ${MARKER}\n<!-- bot:operator/attribution\nci-head: abc\nci-attempt: 3/3\n-->`,
    });
    const state = classifyPrFeedback(
      signals({ comments: [botReply], checks: checks("failing", { headSha: "def", checks: [failing] }) }),
      CFG,
    );
    expect(state.verdict).toBe("needs-review");
    expect(state.ci.attempts).toBe(0);
  });

  it("classifies a transient failure with re-run budget left as ci-transient (not needs-review)", () => {
    const failing = check({ name: "Deploy", conclusion: "failure", headSha: "abc" });
    const state = classifyPrFeedback(
      signals({ checks: checks("failing", { headSha: "abc", checks: [failing], failureMode: "transient" }) }),
      { ...CFG, maxCiReRunAttempts: 2 },
    );
    expect(state.verdict).toBe("ci-transient");
    expect(state.ci.transient).toBe(true);
    expect(state.ci.reRunRemaining).toBe(true);
    expect(state.ci.reRunAttempts).toBe(0);
  });

  it("stops re-running and falls through to needs-review once the re-run budget is spent on the same head", () => {
    const failing = check({ name: "Deploy", conclusion: "failure", headSha: "abc" });
    const botReply = comment({
      author: "operator",
      body: `re-ran ${MARKER}\n<!-- bot:operator/attribution\nci-head: abc\nci-rerun: 2/2\n-->`,
    });
    const state = classifyPrFeedback(
      signals({ comments: [botReply], checks: checks("failing", { headSha: "abc", checks: [failing], failureMode: "transient" }) }),
      { ...CFG, maxCiReRunAttempts: 2 },
    );
    expect(state.verdict).toBe("needs-review");
    expect(state.ci.reRunRemaining).toBe(false);
    expect(state.ci.reRunAttempts).toBe(2);
  });

  it("does not re-run a code failure even with re-run budget configured", () => {
    const failing = check({ name: "Unit", conclusion: "failure", headSha: "abc" });
    const state = classifyPrFeedback(
      signals({ checks: checks("failing", { headSha: "abc", checks: [failing], failureMode: "code" }) }),
      { ...CFG, maxCiReRunAttempts: 2 },
    );
    expect(state.verdict).toBe("needs-review");
    expect(state.ci.transient).toBe(false);
  });

  it("re-run budget resets when the head SHA changes", () => {
    const failing = check({ name: "Deploy", conclusion: "failure", headSha: "def" });
    const botReply = comment({
      author: "operator",
      body: `re-ran ${MARKER}\n<!-- bot:operator/attribution\nci-head: abc\nci-rerun: 2/2\n-->`,
    });
    const state = classifyPrFeedback(
      signals({ comments: [botReply], checks: checks("failing", { headSha: "def", checks: [failing], failureMode: "transient" }) }),
      { ...CFG, maxCiReRunAttempts: 2 },
    );
    expect(state.verdict).toBe("ci-transient");
    expect(state.ci.reRunAttempts).toBe(0);
  });

  it("ranks the oldest unanswered comment timestamp across both streams", () => {
    const older = comment({ id: "a", authorAssociation: "OWNER", createdAt: "2026-06-22T08:00:00Z" });
    const newer = comment({ id: "b", author: "Copilot", authorType: "Bot", createdAt: "2026-06-22T20:00:00Z", path: "x" });
    const state = classifyPrFeedback(signals({ comments: [older], reviewComments: [newer] }), CFG);
    expect(state.verdict).toBe("needs-review");
    expect(state.oldestFreshAt).toBe("2026-06-22T08:00:00Z");
  });
});
