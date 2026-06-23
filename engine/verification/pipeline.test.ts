import { describe, it, expect, vi } from "vitest";
import type { VerificationCheck } from "@operator/core";
import { SequentialVerificationPipeline, ScriptVerificationCheck } from "./pipeline.js";

type ExecFileCallback = (err: Error | null, stdout: string, stderr: string) => void;

// Mock child_process for ScriptVerificationCheck
vi.mock("node:child_process", () => ({
  execFile: vi.fn((_cmd: string, _args: string[], _opts: unknown, cb: ExecFileCallback) => {
    cb(null, "OK", "");
    return {};
  }),
}));

function makeCtx() {
  return {
    traceId: "t", repoId: "r", action: "a",
    budget: { spentUsd: 0, add: vi.fn(), isExceeded: () => false },
    signal: AbortSignal.timeout(30_000),
  };
}

function makeCheck(id: string, passed: boolean, details?: string): VerificationCheck {
  return {
    id,
    run: vi.fn().mockResolvedValue({ name: id, passed, details }),
  };
}

// ── SequentialVerificationPipeline ────────────────────────────────────

describe("SequentialVerificationPipeline", () => {
  it("runs all checks sequentially", async () => {
    const checks = [makeCheck("lint", true), makeCheck("test", true)];
    const pipeline = new SequentialVerificationPipeline(checks);

    const results = await pipeline.run({ projectPath: "/project", operation: makeCtx() });

    expect(results).toHaveLength(2);
    expect(results[0].name).toBe("lint");
    expect(results[0].passed).toBe(true);
    expect(results[1].name).toBe("test");
  });

  it("collects failures without stopping", async () => {
    const checks = [
      makeCheck("lint", false, "Missing semicolon"),
      makeCheck("test", true),
    ];
    const pipeline = new SequentialVerificationPipeline(checks);

    const results = await pipeline.run({ projectPath: "/project", operation: makeCtx() });

    expect(results).toHaveLength(2);
    expect(results[0].passed).toBe(false);
    expect(results[0].details).toBe("Missing semicolon");
    expect(results[1].passed).toBe(true);
  });

  it("stops on aborted signal", async () => {
    const controller = new AbortController();
    controller.abort();
    const checks = [makeCheck("lint", true), makeCheck("test", true)];
    const pipeline = new SequentialVerificationPipeline(checks);

    const results = await pipeline.run({
      projectPath: "/project",
      operation: {
        ...makeCtx(),
        signal: controller.signal,
      },
    });

    expect(results).toHaveLength(1);
    expect(results[0].passed).toBe(false);
    expect(results[0].details).toBe("Aborted");
  });

  it("handles empty checks list", async () => {
    const pipeline = new SequentialVerificationPipeline([]);
    const results = await pipeline.run({ projectPath: "/project", operation: makeCtx() });
    expect(results).toHaveLength(0);
  });
});

// ── ScriptVerificationCheck ──────────────────────────────────────────

describe("ScriptVerificationCheck", () => {
  it("passes when command succeeds", async () => {
    const check = new ScriptVerificationCheck("build", "npm run build");
    const result = await check.run({ projectPath: "/project", operation: makeCtx() });

    expect(result.name).toBe("build");
    expect(result.passed).toBe(true);
  });

  it("fails when command returns error", async () => {
    const { execFile: mockExecFile } = await import("node:child_process");
    vi.mocked(mockExecFile).mockImplementationOnce(
      (_cmd: unknown, _args: unknown, _opts: unknown, cb: unknown) => {
        (cb as ExecFileCallback)(new Error("exit code 1"), "Error output", "");
        return {} as ReturnType<typeof mockExecFile>;
      },
    );

    const check = new ScriptVerificationCheck("test", "npm test");
    const result = await check.run({ projectPath: "/project", operation: makeCtx() });

    expect(result.name).toBe("test");
    expect(result.passed).toBe(false);
    expect(result.details).toContain("Error output");
  });

  it("uses stderr when stdout is empty on error", async () => {
    const { execFile: mockExecFile } = await import("node:child_process");
    vi.mocked(mockExecFile).mockImplementationOnce(
      (_cmd: unknown, _args: unknown, _opts: unknown, cb: unknown) => {
        (cb as ExecFileCallback)(new Error("fail"), "", "stderr output");
        return {} as ReturnType<typeof mockExecFile>;
      },
    );

    const check = new ScriptVerificationCheck("lint", "eslint .");
    const result = await check.run({ projectPath: "/project", operation: makeCtx() });

    expect(result.passed).toBe(false);
    expect(result.details).toContain("stderr output");
  });

  it("uses error.message when both stdout and stderr are empty", async () => {
    const { execFile: mockExecFile } = await import("node:child_process");
    vi.mocked(mockExecFile).mockImplementationOnce(
      (_cmd: unknown, _args: unknown, _opts: unknown, cb: unknown) => {
        (cb as ExecFileCallback)(new Error("timeout killed"), "", "");
        return {} as ReturnType<typeof mockExecFile>;
      },
    );

    const check = new ScriptVerificationCheck("build", "make build");
    const result = await check.run({ projectPath: "/project", operation: makeCtx() });

    expect(result.passed).toBe(false);
    expect(result.details).toContain("timeout killed");
  });
});
