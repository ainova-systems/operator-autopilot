import { describe, it, expect } from "vitest";
import {
  formatAppliedReviewFeedbackMessage,
  formatNoCodeChangesMessage,
  formatReviewLimitReachedMessage,
  formatStaleCiFixMessage,
  formatSupervisorTerminalMessage,
} from "./supervisor-bot-messages.js";

describe("supervisor bot message formatters", () => {
  it("formats review limit reached message", () => {
    const msg = formatReviewLimitReachedMessage(5, 20, " [debug]");
    expect(msg).toContain("Review cycle limit reached");
    expect(msg).toContain("5 review-fix cycles");
    expect(msg).toContain("limit: 20");
    expect(msg).toContain("[debug]");
  });

  it("formats stale CI fix message with truncated head SHA", () => {
    const msg = formatStaleCiFixMessage("abc123def456789", "");
    expect(msg).toContain("abc123def456");
    expect(msg).toContain("pushed fix supersedes");
  });

  it("formats stale CI fix message with unknown SHA fallback", () => {
    const msg = formatStaleCiFixMessage(undefined, "");
    expect(msg).toContain("unknown");
  });

  it("formats terminal supervisor decision message", () => {
    const msg = formatSupervisorTerminalMessage("cancelled by user", "", " [link]");
    expect(msg).toBe("Supervisor decision: cancelled by user. [link]");
  });

  it("formats terminal message with apply error detail", () => {
    const msg = formatSupervisorTerminalMessage("bad emit", "\n\nApply errors: PARSE: invalid", "");
    expect(msg).toContain("Apply errors: PARSE: invalid");
  });

  it("formats applied review feedback message", () => {
    expect(formatAppliedReviewFeedbackMessage(" [dbg]")).toBe("Applied review feedback. [dbg]");
  });

  it("formats no-code-changes message with reasoning block", () => {
    const msg = formatNoCodeChangesMessage("Escalating to owner.", "");
    expect(msg).toContain("No code changes in this cycle.");
    expect(msg).toContain("Escalating to owner.");
    expect(msg).toContain("Reply on this PR if you disagree");
  });

  it("truncates long reasoning in no-code-changes message", () => {
    const long = "x".repeat(2000);
    const msg = formatNoCodeChangesMessage(long, "");
    expect(msg.length).toBeLessThan(long.length + 100);
  });
});
