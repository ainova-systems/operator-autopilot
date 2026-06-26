import { describe, it, expect, vi } from "vitest";
import type { Octokit } from "@octokit/rest";
import { reRunFailedJobs, fetchJobLogTail, JOB_LOG_TAIL_BYTES } from "./actions.js";

function octokitWith(actions: Record<string, unknown>): Octokit {
  return { rest: { actions } } as unknown as Octokit;
}

describe("reRunFailedJobs", () => {
  it("re-runs each distinct run id once and returns true", async () => {
    const reRun = vi.fn().mockResolvedValue({});
    const ok = await reRunFailedJobs(
      octokitWith({ reRunWorkflowFailedJobs: reRun }),
      "owner", "repo", [101, 101, 202],
    );
    expect(ok).toBe(true);
    expect(reRun).toHaveBeenCalledTimes(2);
    expect(reRun).toHaveBeenCalledWith({ owner: "owner", repo: "repo", run_id: 101 });
    expect(reRun).toHaveBeenCalledWith({ owner: "owner", repo: "repo", run_id: 202 });
  });

  it("swallows a per-run error and still re-runs the others", async () => {
    const reRun = vi.fn()
      .mockRejectedValueOnce({ status: 403 })
      .mockResolvedValueOnce({});
    const seen: Array<{ runId: number; ok: boolean }> = [];
    const ok = await reRunFailedJobs(
      octokitWith({ reRunWorkflowFailedJobs: reRun }),
      "owner", "repo", [1, 2],
      (runId, success) => seen.push({ runId, ok: success }),
    );
    expect(ok).toBe(true);
    expect(seen).toEqual([{ runId: 1, ok: false }, { runId: 2, ok: true }]);
  });

  it("returns false when no run could be re-triggered", async () => {
    const reRun = vi.fn().mockRejectedValue({ status: 422 });
    const ok = await reRunFailedJobs(
      octokitWith({ reRunWorkflowFailedJobs: reRun }),
      "owner", "repo", [1],
    );
    expect(ok).toBe(false);
  });

  it("returns false with no run ids without calling the API", async () => {
    const reRun = vi.fn();
    const ok = await reRunFailedJobs(octokitWith({ reRunWorkflowFailedJobs: reRun }), "owner", "repo", []);
    expect(ok).toBe(false);
    expect(reRun).not.toHaveBeenCalled();
  });
});

describe("fetchJobLogTail", () => {
  it("returns the full log when under the cap", async () => {
    const download = vi.fn().mockResolvedValue({ data: "npm error code ECONNRESET" });
    const out = await fetchJobLogTail(octokitWith({ downloadJobLogsForWorkflowRun: download }), "o", "r", 7);
    expect(out).toBe("npm error code ECONNRESET");
    expect(download).toHaveBeenCalledWith({ owner: "o", repo: "r", job_id: 7 });
  });

  it("returns only the trailing bytes when the log is large", async () => {
    const big = "x".repeat(JOB_LOG_TAIL_BYTES + 500) + "TAIL_MARKER";
    const download = vi.fn().mockResolvedValue({ data: big });
    const out = await fetchJobLogTail(octokitWith({ downloadJobLogsForWorkflowRun: download }), "o", "r", 7);
    expect(out).toBeDefined();
    expect(out!.length).toBe(JOB_LOG_TAIL_BYTES);
    expect(out!.endsWith("TAIL_MARKER")).toBe(true);
  });

  it("returns undefined on empty body", async () => {
    const download = vi.fn().mockResolvedValue({ data: "" });
    const out = await fetchJobLogTail(octokitWith({ downloadJobLogsForWorkflowRun: download }), "o", "r", 7);
    expect(out).toBeUndefined();
  });

  it("returns undefined when the fetch throws", async () => {
    const download = vi.fn().mockRejectedValue(new Error("502"));
    const out = await fetchJobLogTail(octokitWith({ downloadJobLogsForWorkflowRun: download }), "o", "r", 7);
    expect(out).toBeUndefined();
  });
});
