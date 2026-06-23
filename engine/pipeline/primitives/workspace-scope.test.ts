import { describe, it, expect, vi, beforeEach } from "vitest";
import type { OperationContext } from "@operator/core";
import { WorkspaceError } from "@operator/core";
import { FileWorkspaceScope } from "./workspace-scope.js";

function makeCtx(aborted = false): OperationContext {
  const controller = new AbortController();
  if (aborted) controller.abort();
  return {
    traceId: "test-trace",
    repoId: "sample",
    action: "test",
    budget: { limitUsd: undefined, spentUsd: 0, add: () => {}, isExceeded: () => false },
    signal: controller.signal,
  };
}

function makeGit() {
  return {
    remoteBranchExists: vi.fn<(branch: string) => Promise<boolean>>(),
    checkoutNewBranch: vi.fn<(name: string, fromBranch: string) => Promise<void>>().mockResolvedValue(undefined),
    checkoutExisting: vi.fn<(branch: string) => Promise<void>>().mockResolvedValue(undefined),
  };
}

describe("FileWorkspaceScope.prepare", () => {
  let scope: FileWorkspaceScope;

  beforeEach(() => {
    scope = new FileWorkspaceScope();
  });

  it("creates a new branch from base when the remote branch does NOT exist (first-time singleton)", async () => {
    const git = makeGit();
    git.remoteBranchExists.mockResolvedValue(false);

    const handle = await scope.prepare(
      { branch: "ai/improver/2026W16", baseBranch: "develop" },
      git,
      makeCtx(),
    );

    expect(git.remoteBranchExists).toHaveBeenCalledWith("ai/improver/2026W16");
    expect(git.checkoutNewBranch).toHaveBeenCalledWith("ai/improver/2026W16", "develop");
    expect(git.checkoutExisting).not.toHaveBeenCalled();
    expect(handle).toEqual({
      branch: "ai/improver/2026W16",
      baseBranch: "develop",
      existedRemote: false,
    });
  });

  it("reuses an existing remote branch (2026-04-13 improver incident fix)", async () => {
    const git = makeGit();
    git.remoteBranchExists.mockResolvedValue(true);

    const handle = await scope.prepare(
      { branch: "ai/improver/2026W16", baseBranch: "develop" },
      git,
      makeCtx(),
    );

    // The bug was that a previous version of the code went straight to
    // checkoutNewBranch in this situation, creating a divergent local
    // branch that later failed to push fast-forward. The primitive must
    // take the checkoutExisting path instead.
    expect(git.checkoutExisting).toHaveBeenCalledWith("ai/improver/2026W16");
    expect(git.checkoutNewBranch).not.toHaveBeenCalled();
    expect(handle).toEqual({
      branch: "ai/improver/2026W16",
      baseBranch: "develop",
      existedRemote: true,
    });
  });

  it("handles per-item scope names the same way (no special logic per scope)", async () => {
    const git = makeGit();
    git.remoteBranchExists.mockResolvedValue(false);

    const handle = await scope.prepare(
      { branch: "ai/tasks/T20260415-0001", baseBranch: "develop" },
      git,
      makeCtx(),
    );

    expect(git.checkoutNewBranch).toHaveBeenCalledWith("ai/tasks/T20260415-0001", "develop");
    expect(handle.existedRemote).toBe(false);
  });

  it("handles existing per-item branches by checking out from the remote", async () => {
    const git = makeGit();
    git.remoteBranchExists.mockResolvedValue(true);

    await scope.prepare(
      { branch: "ai/tasks/T20260415-0001", baseBranch: "develop" },
      git,
      makeCtx(),
    );

    expect(git.checkoutExisting).toHaveBeenCalledWith("ai/tasks/T20260415-0001");
    expect(git.checkoutNewBranch).not.toHaveBeenCalled();
  });

  it("handles the init singleton-bootstrap branch (fresh repo → createNew)", async () => {
    const git = makeGit();
    git.remoteBranchExists.mockResolvedValue(false);

    const handle = await scope.prepare(
      { branch: "ai/init", baseBranch: "master" },
      git,
      makeCtx(),
    );

    expect(git.checkoutNewBranch).toHaveBeenCalledWith("ai/init", "master");
    expect(handle.existedRemote).toBe(false);
  });

  it("handles the init singleton-bootstrap branch (pending init PR → checkoutExisting)", async () => {
    const git = makeGit();
    git.remoteBranchExists.mockResolvedValue(true);

    const handle = await scope.prepare(
      { branch: "ai/init", baseBranch: "master" },
      git,
      makeCtx(),
    );

    expect(git.checkoutExisting).toHaveBeenCalledWith("ai/init");
    expect(handle.existedRemote).toBe(true);
  });

  it("rejects aborted context before touching git", async () => {
    const git = makeGit();

    await expect(
      scope.prepare(
        { branch: "ai/init", baseBranch: "master" },
        git,
        makeCtx(true),
      ),
    ).rejects.toBeInstanceOf(WorkspaceError);

    expect(git.remoteBranchExists).not.toHaveBeenCalled();
    expect(git.checkoutNewBranch).not.toHaveBeenCalled();
    expect(git.checkoutExisting).not.toHaveBeenCalled();
  });

  it("rejects missing branch", async () => {
    const git = makeGit();

    await expect(
      scope.prepare(
        { branch: "", baseBranch: "develop" },
        git,
        makeCtx(),
      ),
    ).rejects.toBeInstanceOf(WorkspaceError);
  });

  it("rejects missing baseBranch", async () => {
    const git = makeGit();

    await expect(
      scope.prepare(
        { branch: "ai/init", baseBranch: "" },
        git,
        makeCtx(),
      ),
    ).rejects.toBeInstanceOf(WorkspaceError);
  });
});
