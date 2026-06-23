import { describe, it, expect } from "vitest";
import type { WorkspaceGit } from "../../infra/git.js";
import {
  captureHeadSnapshot,
  verifyHeadUnchanged,
} from "./head-snapshot-contract.js";

function makeGit(headShaValues: string[]): WorkspaceGit {
  const queue = [...headShaValues];
  return {
    async headSha() {
      if (queue.length === 0) throw new Error("headSha() called more times than queued");
      return queue.shift()!;
    },
  } as unknown as WorkspaceGit;
}

describe("captureHeadSnapshot", () => {
  it("returns the current HEAD sha as a snapshot", async () => {
    const git = makeGit(["abc123def456789012345678901234567890aaaa"]);
    const snapshot = await captureHeadSnapshot(git);
    expect(snapshot.sha).toBe("abc123def456789012345678901234567890aaaa");
  });
});

describe("verifyHeadUnchanged", () => {
  it("returns ok=true when HEAD matches the snapshot", async () => {
    const sha = "abc123def456789012345678901234567890aaaa";
    const git = makeGit([sha, sha]);
    const snapshot = await captureHeadSnapshot(git);
    const result = await verifyHeadUnchanged(git, snapshot);
    expect(result.ok).toBe(true);
    expect(result.preSha).toBe(sha);
    expect(result.postSha).toBe(sha);
    expect(result.message).toBeNull();
  });

  it("returns ok=false with a diagnostic message when HEAD moved", async () => {
    const preSha = "abc123def456789012345678901234567890aaaa";
    const postSha = "fff999eee888777666555444333222111000bbbb";
    const git = makeGit([preSha, postSha]);
    const snapshot = await captureHeadSnapshot(git);
    const result = await verifyHeadUnchanged(git, snapshot);
    expect(result.ok).toBe(false);
    expect(result.preSha).toBe(preSha);
    expect(result.postSha).toBe(postSha);
    expect(result.message).toContain("agent modified branch directly");
    expect(result.message).toContain("abc123d");
    expect(result.message).toContain("fff999e");
  });

  it("renders <none> in the message when the pre-snapshot was null", async () => {
    const postSha = "fff999eee888777666555444333222111000bbbb";
    const git = makeGit([postSha]);
    const result = await verifyHeadUnchanged(git, { sha: null });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("<none>");
    expect(result.message).toContain("fff999e");
  });

  it("treats a same-string second read as ok=true even after multiple HEAD calls", async () => {
    const sha = "1111222233334444555566667777888899990000";
    const git = makeGit([sha, sha, sha]);
    const snapshot1 = await captureHeadSnapshot(git);
    const result1 = await verifyHeadUnchanged(git, snapshot1);
    const result2 = await verifyHeadUnchanged(git, snapshot1);
    expect(result1.ok).toBe(true);
    expect(result2.ok).toBe(true);
  });
});
