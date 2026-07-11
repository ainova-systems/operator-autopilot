import { describe, it, expect, vi } from "vitest";
import type { OperationContext } from "@operator/core";
import { AgentError } from "@operator/core";
import type { AgentRunInput, AgentRunResult } from "../../agents/runtime.js";
import type { Logger } from "../../logging/logger.js";
import { FileAgentInvocation, extractSummary } from "./agent-invocation.js";
import type { StageDef, StageInput } from "../types.js";

function makeCtx(aborted = false): OperationContext {
  const controller = new AbortController();
  if (aborted) controller.abort();
  return {
    traceId: "t",
    repoId: "sample",
    action: "test",
    budget: { limitUsd: undefined, spentUsd: 0, add: () => {}, isExceeded: () => false },
    signal: controller.signal,
  };
}

function makeStageDef(): StageDef {
  return {
    name: "init",
    agent: "scout",
    selector: "bootstrap",
    merge: "gated",
    branchScope: "singleton",
    branchPrefix: "ai/init",
    schedule: "on-start",
    enabled: true,
    baseBranch: "develop",
  };
}

function makeRunInput(): AgentRunInput {
  return {
    agentName: "scout",
    providerId: "claude",
    promptContext: { automationDir: "/tmp/.operator", contextFiles: [], instructionsTopic: "scout", vars: {} },
    model: "sonnet",
    timeoutMs: 60_000,
    maxRetries: 2,
    reviewEnabled: false,
    cwd: "/tmp",
  };
}

function makeInput(): StageInput {
  return { scopeKey: "init", reason: "missing-scaffold" };
}

describe("FileAgentInvocation.invoke", () => {
  it("returns approved + parsed summary on successful runtime result", async () => {
    const runtimeResult: AgentRunResult = {
      output: "## Execution Summary\nCreated .operator scaffold.\n\n## Notes\nirrelevant",
      attempts: 1,
      durationMs: 500,
    };
    const agentRuntime = { run: vi.fn().mockResolvedValue(runtimeResult) };
    const invocation = new FileAgentInvocation();

    const result = await invocation.invoke(
      makeStageDef(), makeInput(), makeRunInput(), { agentRuntime }, makeCtx(),
    );

    expect(result.verdict).toBe("approved");
    expect(result.attempts).toBe(1);
    expect(result.summary).toBe("Created .operator scaffold.");
    expect(result.output).toBe(runtimeResult.output);
  });

  it("returns approved with a synthesized summary when output has no Execution Summary block (Step 14)", async () => {
    const agentRuntime = {
      run: vi.fn().mockResolvedValue({
        output: "plain text no sections",
        attempts: 1,
        durationMs: 100,
      }),
    };
    const log = {
      info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(),
      child: vi.fn().mockReturnThis(),
    } as unknown as Logger;
    const invocation = new FileAgentInvocation();

    const result = await invocation.invoke(
      makeStageDef(), makeInput(), makeRunInput(), { agentRuntime, log }, makeCtx(),
    );

    expect(result.verdict).toBe("approved");
    // Fallback synthesizes a summary from the agent output so downstream
    // KV execution history always has a non-empty narrative to display.
    expect(result.summary).toContain("[synthesized]");
    expect(result.summary).toContain("plain text no sections");
    // Missing block is optional (AOP agents use EMIT verdict summary) — DEBUG only, no WARN.
    expect(log.warn).not.toHaveBeenCalled();
    expect(log.debug).toHaveBeenCalledWith(
      "agent output missing ## Execution Summary block — using synthesized fallback",
      expect.objectContaining({ stage: "init", verdict: "approved" }),
    );
  });

  it("maps terminal-failed verifier error to verdict = failed", async () => {
    const agentRuntime = {
      run: vi.fn().mockRejectedValue(
        new AgentError("REVIEW_TERMINAL", "verifier rejected the scope", {
          phase: "terminal-failed",
          reason: "missing tests",
        }),
      ),
    };
    const invocation = new FileAgentInvocation();

    const result = await invocation.invoke(
      makeStageDef(), makeInput(), makeRunInput(), { agentRuntime }, makeCtx(),
    );

    expect(result.verdict).toBe("failed");
    expect(result.summary).toContain("verifier rejected");
  });

  it("maps terminal-cancelled to verdict = cancelled", async () => {
    const agentRuntime = {
      run: vi.fn().mockRejectedValue(
        new AgentError("REVIEW_TERMINAL", "no longer needed", {
          phase: "terminal-cancelled",
          reason: "superseded",
        }),
      ),
    };
    const invocation = new FileAgentInvocation();

    const result = await invocation.invoke(
      makeStageDef(), makeInput(), makeRunInput(), { agentRuntime }, makeCtx(),
    );

    expect(result.verdict).toBe("cancelled");
  });

  it("maps terminal-rejected to verdict = rejected", async () => {
    const agentRuntime = {
      run: vi.fn().mockRejectedValue(
        new AgentError("REVIEW_TERMINAL", "scope wrong", {
          phase: "terminal-rejected",
          reason: "out of scope",
        }),
      ),
    };
    const invocation = new FileAgentInvocation();

    const result = await invocation.invoke(
      makeStageDef(), makeInput(), makeRunInput(), { agentRuntime }, makeCtx(),
    );

    expect(result.verdict).toBe("rejected");
  });

  it("maps MAX_RETRIES_EXCEEDED review-phase to verdict = failed", async () => {
    const agentRuntime = {
      run: vi.fn().mockRejectedValue(
        new AgentError("MAX_RETRIES_EXCEEDED", "retries exhausted", { phase: "review" }),
      ),
    };
    const invocation = new FileAgentInvocation();

    const result = await invocation.invoke(
      makeStageDef(), makeInput(), makeRunInput(), { agentRuntime }, makeCtx(),
    );

    expect(result.verdict).toBe("failed");
  });

  it("rethrows non-AgentError (infrastructure crash is NOT a verdict)", async () => {
    const agentRuntime = {
      run: vi.fn().mockRejectedValue(new TypeError("crash")),
    };
    const invocation = new FileAgentInvocation();

    await expect(
      invocation.invoke(makeStageDef(), makeInput(), makeRunInput(), { agentRuntime }, makeCtx()),
    ).rejects.toBeInstanceOf(TypeError);
  });

  it("rethrows AgentError without a known phase (preserves unmapped errors)", async () => {
    const agentRuntime = {
      run: vi.fn().mockRejectedValue(
        new AgentError("PROVIDER_NOT_FOUND", "unknown provider"),
      ),
    };
    const invocation = new FileAgentInvocation();

    await expect(
      invocation.invoke(makeStageDef(), makeInput(), makeRunInput(), { agentRuntime }, makeCtx()),
    ).rejects.toBeInstanceOf(AgentError);
  });

  it("rejects aborted context without invoking the runtime", async () => {
    const agentRuntime = { run: vi.fn() };
    const invocation = new FileAgentInvocation();

    await expect(
      invocation.invoke(
        makeStageDef(), makeInput(), makeRunInput(), { agentRuntime }, makeCtx(true),
      ),
    ).rejects.toThrow();

    expect(agentRuntime.run).not.toHaveBeenCalled();
  });
});

describe("extractSummary", () => {
  it("returns the Execution Summary body trimmed", () => {
    const out = [
      "preamble",
      "",
      "## Execution Summary",
      "Created scaffold.",
      "Wrote project.yaml.",
      "",
      "## Follow-ups",
      "(ignored)",
    ].join("\n");
    expect(extractSummary(out)).toBe("Created scaffold.\nWrote project.yaml.");
  });

  it("returns empty string when no summary section is present", () => {
    expect(extractSummary("no sections here")).toBe("");
  });

  it("matches only the first Execution Summary block", () => {
    const out = [
      "## Execution Summary",
      "first",
      "## Execution Summary",
      "second",
    ].join("\n");
    expect(extractSummary(out)).toBe("first");
  });
});
