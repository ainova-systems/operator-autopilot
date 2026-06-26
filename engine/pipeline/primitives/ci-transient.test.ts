import { describe, it, expect, vi } from "vitest";
import type { CheckRun } from "@operator/core";
import {
  isFailingConclusion,
  matchesTransient,
  classifyChecksFailureMode,
  TRANSIENT_CI_PATTERNS,
} from "./ci-transient.js";

function check(partial: Partial<CheckRun>): CheckRun {
  return { name: "check", conclusion: "failure", ...partial };
}

describe("isFailingConclusion", () => {
  it("treats failure/timed_out/action_required/startup_failure as failing", () => {
    for (const c of ["failure", "timed_out", "ACTION_REQUIRED", "startup_failure"]) {
      expect(isFailingConclusion(c)).toBe(true);
    }
  });
  it("treats success/neutral/skipped/empty as not failing", () => {
    for (const c of ["success", "neutral", "skipped", "cancelled", "", undefined, null]) {
      expect(isFailingConclusion(c)).toBe(false);
    }
  });
});

describe("matchesTransient", () => {
  it("matches the real npm ci ECONNRESET signature", () => {
    expect(matchesTransient("#12 82.50 npm error code ECONNRESET\nnpm error network aborted")).toBe(true);
  });
  it("matches registry 5xx and runner-loss signatures", () => {
    expect(matchesTransient("503 Service Unavailable")).toBe(true);
    expect(matchesTransient("The runner has received a shutdown signal")).toBe(true);
    expect(matchesTransient("getaddrinfo EAI_AGAIN registry.npmjs.org")).toBe(true);
  });
  it("does not match a genuine test/compile failure", () => {
    expect(matchesTransient("FAIL src/auth.test.ts\nAssertionError: expected 200 to equal 401")).toBe(false);
    expect(matchesTransient("error TS2322: Type 'string' is not assignable to type 'number'")).toBe(false);
  });
  it("has no empty/duplicate patterns", () => {
    expect(TRANSIENT_CI_PATTERNS.length).toBeGreaterThan(0);
    const sources = TRANSIENT_CI_PATTERNS.map((r) => r.source);
    expect(new Set(sources).size).toBe(sources.length);
  });
});

describe("classifyChecksFailureMode", () => {
  const noVcs = { vcs: {} };

  it("returns code for an empty failing set", async () => {
    expect(await classifyChecksFailureMode([], noVcs)).toBe("code");
  });

  it("classifies transient from inline summary without fetching logs", async () => {
    const getJobLogTail = vi.fn();
    const out = await classifyChecksFailureMode(
      [check({ name: "Deploy", summary: "npm error code ECONNRESET" })],
      { vcs: { getJobLogTail } },
    );
    expect(out).toBe("transient");
    expect(getJobLogTail).not.toHaveBeenCalled();
  });

  it("fetches the job log when inline text has no signal, then classifies transient", async () => {
    const getJobLogTail = vi.fn().mockResolvedValue("RUN npm ci\nnpm error network aborted ECONNRESET");
    const out = await classifyChecksFailureMode(
      [check({ name: "Deploy PR Environment", jobId: 83632478650 })],
      { vcs: { getJobLogTail } },
    );
    expect(out).toBe("transient");
    expect(getJobLogTail).toHaveBeenCalledWith(83632478650);
  });

  it("returns code when any failing check is not provably transient (mixed bag)", async () => {
    const getJobLogTail = vi.fn()
      .mockResolvedValueOnce("npm error code ECONNRESET")           // Deploy → transient
      .mockResolvedValueOnce("FAIL auth.test.ts AssertionError");   // Unit → code
    const out = await classifyChecksFailureMode(
      [check({ name: "Deploy", jobId: 1 }), check({ name: "Unit", jobId: 2 })],
      { vcs: { getJobLogTail } },
    );
    expect(out).toBe("code");
  });

  it("classifies transient when every one of several failing checks is a flake, and logs the decision", async () => {
    const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const getJobLogTail = vi.fn()
      .mockResolvedValueOnce("npm error code ECONNRESET")
      .mockResolvedValueOnce("503 Service Unavailable from registry");
    const out = await classifyChecksFailureMode(
      [check({ name: "Deploy", jobId: 1 }), check({ name: "Assets", jobId: 2 })],
      { vcs: { getJobLogTail }, log },
    );
    expect(out).toBe("transient");
    expect(log.info).toHaveBeenCalledWith(
      expect.stringContaining("infra flakes"),
      expect.objectContaining({ failingCount: 2, checks: "Deploy, Assets" }),
    );
  });

  it("logs a debug line naming the check when a failure is not transient", async () => {
    const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const out = await classifyChecksFailureMode(
      [check({ name: "Unit", summary: "AssertionError" })],
      { vcs: {}, log },
    );
    expect(out).toBe("code");
    expect(log.debug).toHaveBeenCalledWith(
      expect.stringContaining("no transient signal"),
      expect.objectContaining({ check: "Unit" }),
    );
  });

  it("returns code when no job log is available", async () => {
    const getJobLogTail = vi.fn().mockResolvedValue(undefined);
    const out = await classifyChecksFailureMode(
      [check({ name: "Deploy", jobId: 1 })],
      { vcs: { getJobLogTail } },
    );
    expect(out).toBe("code");
  });
});
