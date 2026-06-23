import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AgentProvider } from "@operator/core";
import type { OperationContext } from "@operator/core";
import type { IdempotencyGuard, LockHandle } from "@operator/core";
import { AgentRuntime, parseReviewVerdict, buildReviewPrompt, truncateErrorContext, errorFingerprint } from "./runtime.js";
import type { AgentRunInput } from "./runtime.js";

// Mock child_process for verify and git diff
vi.mock("node:child_process", () => ({
  execFile: vi.fn((_cmd: string, _args: string[], _opts: unknown, cb: (err: Error | null, stdout: string, stderr: string) => void) => {
    cb(null, "", "");
    return {};
  }),
}));

// Mock fs for system prompt temp file
vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  return {
    ...actual,
    writeFile: vi.fn().mockResolvedValue(undefined),
    unlink: vi.fn().mockResolvedValue(undefined),
  };
});

// Mock prompt-builder to avoid filesystem access
vi.mock("./prompt-builder.js", () => ({
  buildSystemPrompt: vi.fn().mockResolvedValue("system prompt content"),
  buildUserPrompt: vi.fn().mockReturnValue("user prompt content"),
}));

function makeCtx(overrides?: Partial<OperationContext>): OperationContext {
  return {
    traceId: "test-trace",
    repoId: "test-repo",
    action: "test",
    budget: { spentUsd: 0, add: vi.fn(), isExceeded: () => false },
    signal: AbortSignal.timeout(30_000),
    ...overrides,
  };
}

function makeProvider(responses: Array<{ stdout: string; exitCode: number }>): AgentProvider {
  let callIdx = 0;
  return {
    id: "test-provider",
    execute: vi.fn().mockImplementation(async () => {
      const resp = responses[callIdx] ?? responses[responses.length - 1];
      callIdx++;
      return { ...resp, durationMs: 100 };
    }),
  };
}

function makeInput(overrides?: Partial<AgentRunInput>): AgentRunInput {
  return {
    agentName: "creator",
    providerId: "test-provider",
    promptContext: {
      automationDir: "/nonexistent/.operator",
      contextFiles: [],
      vars: {},
    },
    model: "opus",
    timeoutMs: 60_000,
    maxRetries: 3,
    reviewEnabled: false,
    cwd: "/workspace",
    ...overrides,
  };
}

describe("AgentRuntime", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("runs agent and returns output on success", async () => {
    const provider = makeProvider([{ stdout: "Agent output", exitCode: 0 }]);
    const runtime = new AgentRuntime(new Map([["test-provider", provider]]));

    const result = await runtime.run(makeInput(), makeCtx());

    expect(result.output).toBe("Agent output");
    expect(result.attempts).toBe(1);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("throws for unknown provider", async () => {
    const runtime = new AgentRuntime(new Map());
    await expect(runtime.run(makeInput(), makeCtx())).rejects.toThrow("Unknown provider");
  });

  // ── Retry logic ──────────────────────────────────────────────────

  describe("retry", () => {
    it("retries on non-zero exit code", async () => {
      const provider = makeProvider([
        { stdout: "", exitCode: 1 },
        { stdout: "Fixed output", exitCode: 0 },
      ]);
      const runtime = new AgentRuntime(new Map([["test-provider", provider]]));

      const result = await runtime.run(makeInput(), makeCtx());

      expect(result.output).toBe("Fixed output");
      expect(result.attempts).toBe(2);
      expect(provider.execute).toHaveBeenCalledTimes(2);
    });

    it("throws after max retries exhausted", async () => {
      const provider = makeProvider([{ stdout: "", exitCode: 1 }]);
      const runtime = new AgentRuntime(new Map([["test-provider", provider]]));

      await expect(
        runtime.run(makeInput({ maxRetries: 2 }), makeCtx()),
      ).rejects.toThrow("failed after 2 attempts");
    });

    it("throws on abort signal", async () => {
      const controller = new AbortController();
      controller.abort();
      const provider = makeProvider([{ stdout: "ok", exitCode: 0 }]);
      const runtime = new AgentRuntime(new Map([["test-provider", provider]]));

      await expect(
        runtime.run(makeInput(), makeCtx({ signal: controller.signal })),
      ).rejects.toThrow("Aborted");
    });
  });

  // ── IdempotencyGuard ─────────────────────────────────────────────

  describe("IdempotencyGuard", () => {
    it("acquires and releases lock on success", async () => {
      const lock: LockHandle = { key: "test", lockId: "l1", acquiredAt: "now" };
      const guard: IdempotencyGuard = {
        acquire: vi.fn().mockResolvedValue(lock),
        complete: vi.fn().mockResolvedValue(undefined),
        release: vi.fn().mockResolvedValue(undefined),
      };
      const provider = makeProvider([{ stdout: "ok", exitCode: 0 }]);
      const runtime = new AgentRuntime(new Map([["test-provider", provider]]), guard);

      await runtime.run(makeInput(), makeCtx());

      expect(guard.acquire).toHaveBeenCalled();
      expect(guard.release).toHaveBeenCalledWith(lock, expect.anything());
      expect(guard.complete).not.toHaveBeenCalled();
    });

    it("releases lock on failure", async () => {
      const lock: LockHandle = { key: "test", lockId: "l1", acquiredAt: "now" };
      const guard: IdempotencyGuard = {
        acquire: vi.fn().mockResolvedValue(lock),
        complete: vi.fn().mockResolvedValue(undefined),
        release: vi.fn().mockResolvedValue(undefined),
      };
      const provider = makeProvider([{ stdout: "", exitCode: 1 }]);
      const runtime = new AgentRuntime(new Map([["test-provider", provider]]), guard);

      await expect(runtime.run(makeInput({ maxRetries: 1 }), makeCtx())).rejects.toThrow();

      expect(guard.release).toHaveBeenCalledWith(lock, expect.anything());
      expect(guard.complete).not.toHaveBeenCalled();
    });

    it("caps the lock TTL at the safe ceiling when the run budget exceeds it", async () => {
      // Regression: a hard-killed creator run left an agent:creator:sample lock
      // with a 3h TTL (1h timeout × 3 retries) that blocked every later creator
      // run on the repo for hours (2026-06-04). The TTL must be bounded to a
      // safe period so a leaked lock self-heals — without auto-clearing locks
      // or hiding the LOCK_FAILED error.
      const lock: LockHandle = { key: "test", lockId: "l1", acquiredAt: "now" };
      const guard: IdempotencyGuard = {
        acquire: vi.fn().mockResolvedValue(lock),
        complete: vi.fn().mockResolvedValue(undefined),
        release: vi.fn().mockResolvedValue(undefined),
      };
      const provider = makeProvider([{ stdout: "ok", exitCode: 0 }]);
      const runtime = new AgentRuntime(new Map([["test-provider", provider]]), guard);

      // creator-like budget: 1h per attempt × 3 retries = 3h, well over the cap.
      await runtime.run(makeInput({ timeoutMs: 60 * 60 * 1000, maxRetries: 3 }), makeCtx());

      const ttlArg = (guard.acquire as ReturnType<typeof vi.fn>).mock.calls[0][1];
      expect(ttlArg).toBe(60 * 60 * 1000); // capped to 1h, not 3h
    });

    it("uses the raw run budget for the lock TTL when it is under the ceiling", async () => {
      const lock: LockHandle = { key: "test", lockId: "l1", acquiredAt: "now" };
      const guard: IdempotencyGuard = {
        acquire: vi.fn().mockResolvedValue(lock),
        complete: vi.fn().mockResolvedValue(undefined),
        release: vi.fn().mockResolvedValue(undefined),
      };
      const provider = makeProvider([{ stdout: "ok", exitCode: 0 }]);
      const runtime = new AgentRuntime(new Map([["test-provider", provider]]), guard);

      // 60s × 3 = 180s, comfortably under the 1h cap → passed through unchanged.
      await runtime.run(makeInput({ timeoutMs: 60_000, maxRetries: 3 }), makeCtx());

      const ttlArg = (guard.acquire as ReturnType<typeof vi.fn>).mock.calls[0][1];
      expect(ttlArg).toBe(180_000);
    });

    it("throws when lock acquisition fails", async () => {
      const guard: IdempotencyGuard = {
        acquire: vi.fn().mockResolvedValue(null),
        complete: vi.fn(),
        release: vi.fn(),
      };
      const provider = makeProvider([{ stdout: "ok", exitCode: 0 }]);
      const runtime = new AgentRuntime(new Map([["test-provider", provider]]), guard);

      await expect(runtime.run(makeInput(), makeCtx())).rejects.toThrow("Failed to acquire lock");
    });
  });

  // ── Verify ─────────────────────────────────────────────────────────

  describe("verify", () => {
    it("retries when verify command fails", async () => {
      const { execFile: mockExecFile } = await import("node:child_process");
      const execMock = vi.mocked(mockExecFile);

      // First call: provider execute (succeed). Second: verify (fail). Third: provider (succeed). Fourth: verify (pass)
      let execCallIdx = 0;
      execMock.mockImplementation((...args: unknown[]) => {
        // Node's execFile is variadic — (file, opts, cb) for shell-mode
        // verify, (file, args, opts, cb) for the older git-diff path.
        // Accept either shape and locate the callback by type.
        const cb = args.find((arg) => typeof arg === "function") as
          | ((err: Error | null, stdout: string, stderr: string) => void)
          | undefined;
        if (!cb) throw new Error("expected callback in execFile args");
        execCallIdx++;
        if (execCallIdx === 1) {
          cb(new Error("lint failed"), "Error: missing semicolon", "");
        } else {
          cb(null, "", "");
        }
        return {} as ReturnType<typeof mockExecFile>;
      });

      const provider = makeProvider([
        { stdout: "first output", exitCode: 0 },
        { stdout: "fixed output", exitCode: 0 },
      ]);
      const runtime = new AgentRuntime(new Map([["test-provider", provider]]));

      const result = await runtime.run(
        makeInput({ verifyCommand: "npm test" }),
        makeCtx(),
      );

      expect(result.output).toBe("fixed output");
      expect(result.attempts).toBe(2);
    });
  });

  // ── Review ────────────────────────────────────────────────────────

  describe("review", () => {
    it("skips review when not enabled", async () => {
      const provider = makeProvider([{ stdout: "output", exitCode: 0 }]);
      const verifier = makeProvider([{ stdout: "REJECTED", exitCode: 0 }]);
      const runtime = new AgentRuntime(new Map([
        ["test-provider", provider],
        ["verifier", verifier],
      ]));

      const result = await runtime.run(makeInput({ reviewEnabled: false }), makeCtx());

      expect(result.output).toBe("output");
      expect(verifier.execute).not.toHaveBeenCalled();
    });

    it("passes when verifier says APPROVED", async () => {
      const provider = makeProvider([{ stdout: "code changes", exitCode: 0 }]);
      const verifier = makeProvider([{ stdout: "Looks good. APPROVED.", exitCode: 0 }]);
      const runtime = new AgentRuntime(new Map([
        ["test-provider", provider],
        ["verifier", verifier],
      ]));

      const result = await runtime.run(
        makeInput({ reviewEnabled: true }),
        makeCtx(),
      );

      expect(result.output).toBe("code changes");
      expect(verifier.execute).toHaveBeenCalled();
    });

    it("retries when verifier rejects", async () => {
      const provider = makeProvider([
        { stdout: "bad code", exitCode: 0 },
        { stdout: "fixed code", exitCode: 0 },
      ]);
      const verifierResponses = [
        { stdout: "REJECTED: missing error handling", exitCode: 0 },
        { stdout: "APPROVED", exitCode: 0 },
      ];
      let reviewIdx = 0;
      const verifier: AgentProvider = {
        id: "verifier",
        execute: vi.fn().mockImplementation(async () => {
          const resp = verifierResponses[reviewIdx] ?? verifierResponses[verifierResponses.length - 1];
          reviewIdx++;
          return { ...resp, durationMs: 50 };
        }),
      };
      const runtime = new AgentRuntime(new Map([
        ["test-provider", provider],
        ["verifier", verifier],
      ]));

      const result = await runtime.run(
        makeInput({ reviewEnabled: true }),
        makeCtx(),
      );

      expect(result.output).toBe("fixed code");
      expect(result.attempts).toBe(2);
    });

    it("skips review when no verifier provider registered", async () => {
      const provider = makeProvider([{ stdout: "output", exitCode: 0 }]);
      const runtime = new AgentRuntime(new Map([["test-provider", provider]]));

      const result = await runtime.run(
        makeInput({ reviewEnabled: true }),
        makeCtx(),
      );

      expect(result.output).toBe("output");
    });
  });
});

// ── parseReviewVerdict ─────────────────────────────────────────────────

describe("parseReviewVerdict", () => {
  it("returns approved for explicit APPROVED marker", () => {
    expect(parseReviewVerdict("## Verdict: APPROVED").kind).toBe("approved");
    expect(parseReviewVerdict("## Verdict: APPROVED\n\nAll checks passed.").kind).toBe("approved");
  });

  it("returns approved for legacy bare-line APPROVED", () => {
    expect(parseReviewVerdict("APPROVED").kind).toBe("approved");
    expect(parseReviewVerdict("approved").kind).toBe("approved");
  });

  it("legacy NOT APPROVED becomes retry (safety)", () => {
    const v = parseReviewVerdict("APPROVED but actually NOT APPROVED — missing tests");
    expect(v.kind).toBe("retry");
  });

  it("legacy REJECTED maps to retry (backward compat)", () => {
    const v = parseReviewVerdict("REJECTED: code quality issues");
    expect(v.kind).toBe("retry");
    if (v.kind === "retry") expect(v.feedback).toContain("code quality issues");
  });

  it("empty output becomes retry", () => {
    expect(parseReviewVerdict("").kind).toBe("retry");
    expect(parseReviewVerdict("   \n ").kind).toBe("retry");
  });

  it("## Verdict: RETRY extracts feedback section", () => {
    const v = parseReviewVerdict([
      "## Verdict: RETRY",
      "",
      "## Feedback",
      "Missing null check on line 42",
    ].join("\n"));
    expect(v.kind).toBe("retry");
    if (v.kind === "retry") expect(v.feedback).toContain("Missing null check");
  });

  it("## Verdict: FAILED extracts reason section", () => {
    const v = parseReviewVerdict([
      "## Verdict: FAILED",
      "",
      "## Reason",
      "Build is broken in a way the agent cannot fix",
    ].join("\n"));
    expect(v.kind).toBe("failed");
    if (v.kind === "failed") expect(v.reason).toContain("Build is broken");
  });

  it("## Verdict: CANCELLED extracts reason section", () => {
    const v = parseReviewVerdict([
      "## Verdict: CANCELLED",
      "",
      "## Reason",
      "Task is already fixed in main",
    ].join("\n"));
    expect(v.kind).toBe("cancelled");
    if (v.kind === "cancelled") expect(v.reason).toContain("already fixed");
  });

  it("## Verdict: REJECTED extracts reason section", () => {
    const v = parseReviewVerdict([
      "## Verdict: REJECTED",
      "",
      "## Reason",
      "Scope too broad — split into per-module tasks",
    ].join("\n"));
    expect(v.kind).toBe("rejected");
    if (v.kind === "rejected") expect(v.reason).toContain("too broad");
  });

  it("unknown format defaults to retry with raw output as feedback", () => {
    const v = parseReviewVerdict("Some random text without a verdict");
    expect(v.kind).toBe("retry");
    if (v.kind === "retry") expect(v.feedback).toContain("Some random text");
  });
});

// ── buildReviewPrompt ──────────────────────────────────────────────────

describe("buildReviewPrompt", () => {
  it("includes task input and changes", () => {
    const prompt = buildReviewPrompt("diff output", "fix the bug");
    expect(prompt).toContain("fix the bug");
    expect(prompt).toContain("diff output");
    expect(prompt).toContain("APPROVED");
  });

  it("includes stage-specific criteria when provided", () => {
    const criteria = "Verify all finding files exist on disk.";
    const prompt = buildReviewPrompt("diff", "task", criteria);
    expect(prompt).toContain("Stage-Specific Review Criteria");
    expect(prompt).toContain(criteria);
  });

  it("omits criteria section when not provided", () => {
    const prompt = buildReviewPrompt("diff", "task");
    expect(prompt).not.toContain("Stage-Specific Review Criteria");
  });

  it("omits criteria section when undefined", () => {
    const prompt = buildReviewPrompt("diff", "task", undefined);
    expect(prompt).not.toContain("Stage-Specific Review Criteria");
  });
});

describe("truncateErrorContext", () => {
  it("returns input unchanged when under the limit", () => {
    expect(truncateErrorContext("short error")).toBe("short error");
  });

  it("keeps a 2000-byte payload intact", () => {
    const content = "x".repeat(2000);
    expect(truncateErrorContext(content)).toBe(content);
  });

  it("preserves both head and tail when oversized, dropping the middle", () => {
    // ~200 KB input with a distinct head marker, middle filler, and a
    // tail marker — realistic for a long .NET build log where the
    // root-cause keyword appears at the very top.
    const headMarker = "ROOT_CAUSE_AT_HEAD";
    const tailMarker = "FINAL_EXIT_AT_TAIL";
    const filler = "X".repeat(200_000);
    const content = headMarker + filler + tailMarker;
    const result = truncateErrorContext(content);

    expect(result.length).toBeLessThan(content.length);
    expect(result.length).toBeLessThanOrEqual(2_100);
    expect(result).toContain(headMarker);
    expect(result).toContain(tailMarker);
    expect(result).toContain("bytes truncated");
  });

  it("caps output small enough to avoid spawn E2BIG", () => {
    // Linux ARG_MAX is ~128 KB — ensure our cap is well below it
    const huge = "A".repeat(500_000);
    expect(truncateErrorContext(huge).length).toBeLessThan(4_000);
  });
});

describe("errorFingerprint", () => {
  it("collapses same root cause across different file paths", () => {
    const a = "Project Source/Backend/Identity/Sample.Identity.Api.csproj : Package 'AutoMapper' 15.1.0 has a known high severity vulnerability";
    const b = "Project Source/Backend/Sample/Sample.Tests.csproj : Package 'AutoMapper' 15.1.0 has a known high severity vulnerability";
    expect(errorFingerprint(a)).toBe(errorFingerprint(b));
  });

  it("collapses line:col differences", () => {
    expect(errorFingerprint("foo.ts:10:5 error TS2304: cannot find X"))
      .toBe(errorFingerprint("foo.ts:99:42 error TS2304: cannot find X"));
  });

  it("strips attempt counters", () => {
    expect(errorFingerprint("Attempt 1/3 build failed: x")).toBe(errorFingerprint("Attempt 2/3 build failed: x"));
  });

  it("treats different root causes as distinct", () => {
    const a = "Package 'AutoMapper' 15.1.0 has a known high severity vulnerability";
    const b = "Package 'Newtonsoft.Json' 12.0.3 has a known low severity vulnerability";
    expect(errorFingerprint(a)).not.toBe(errorFingerprint(b));
  });
});
