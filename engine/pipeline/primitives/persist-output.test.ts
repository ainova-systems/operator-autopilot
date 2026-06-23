import { describe, it, expect, vi, beforeEach } from "vitest";
import type { OperationContext, CodeReview } from "@operator/core";
import { WorkspaceError } from "@operator/core";
import { FileOutputAdapter } from "./persist-output.js";
import type { StagePersistInput } from "./persist-output.js";
import type { WorkspaceHandle } from "./workspace-scope.js";
import type { StageDef, StageInput, AgentResult, Verdict } from "../types.js";

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

function makeStageDef(overrides: Partial<StageDef> = {}): StageDef {
  return {
    name: "research",
    agent: "analyst",
    selector: "discovery",
    merge: "gated",
    branchScope: "singleton",
    branchPrefix: "ai/research",
    schedule: "0 8 * * *",
    enabled: true,
    baseBranch: "develop",
    ...overrides,
  };
}

function makeStageInput(): StageInput {
  return { scopeKey: "20260416" };
}

function makeAgentResult(verdict: Verdict = "approved"): AgentResult {
  return { verdict, output: "", attempts: 1, summary: "ok" };
}

function makeWorkspace(branch = "ai/research/20260416"): WorkspaceHandle {
  return { branch, baseBranch: "develop", existedRemote: false };
}

function makeGit(options?: { commitSha?: string | null; headSha?: string; commitCount?: number }) {
  const sha = options && "commitSha" in options ? options.commitSha : "abc123";
  return {
    addAll: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    commitIfChanged: vi
      .fn<(msg: string) => Promise<string | null>>()
      .mockResolvedValue(sha ?? null),
    push: vi.fn<(branch: string) => Promise<void>>().mockResolvedValue(undefined),
    headSha: vi.fn<() => Promise<string>>().mockResolvedValue(options?.headSha ?? "head-sha"),
    commitCount: vi.fn<(base: string) => Promise<number>>().mockResolvedValue(options?.commitCount ?? 1),
  };
}

function makePRManager(options?: { existingPR?: CodeReview | null; createdId?: number }) {
  const createdCR: CodeReview = {
    id: options?.createdId ?? 42,
    title: "",
    url: "",
    branch: "",
    baseBranch: "",
    labels: [],
    comments: [],
    closed: false,
    merged: false,
    draft: true,
  };
  return {
    findOpenPR: vi
      .fn<(branch: string) => Promise<CodeReview | null>>()
      .mockResolvedValue(options?.existingPR ?? null),
    createDraft: vi
      .fn<
        (input: { title: string; body: string; branch: string; baseBranch: string }) => Promise<CodeReview>
      >()
      .mockResolvedValue(createdCR),
    markInReview: vi.fn<(crId: number) => Promise<void>>().mockResolvedValue(undefined),
    markReadyToMerge: vi.fn<(crId: number) => Promise<void>>().mockResolvedValue(undefined),
    markFailed: vi.fn<(crId: number) => Promise<void>>().mockResolvedValue(undefined),
  };
}

function makeVCS(options?: { createdId?: number }) {
  const createdCR: CodeReview = {
    id: options?.createdId ?? 99,
    title: "",
    url: "",
    branch: "",
    baseBranch: "",
    labels: [],
    comments: [],
    closed: false,
    merged: false,
    draft: false,
  };
  return {
    createCodeReview: vi
      .fn<
        (input: {
          title: string;
          body: string;
          baseBranch: string;
          headBranch: string;
          draft: boolean;
        }) => Promise<CodeReview>
      >()
      .mockResolvedValue(createdCR),
  };
}

function makeStagePersistInput(overrides?: Partial<StagePersistInput>): StagePersistInput {
  return {
    commitMessage: "Daily research 20260416, 3 findings",
    pr: { title: "[AI:Research] 3 findings", body: "body", draft: false },
    onSuccess: "in-review",
    ...overrides,
  };
}

describe("FileOutputAdapter.persist — frozen signature (Step 8c)", () => {
  let adapter: FileOutputAdapter;

  beforeEach(() => {
    adapter = new FileOutputAdapter();
  });

  it("commits, pushes, creates a READY PR, and marks completed on approved + onSuccess=completed (research success)", async () => {
    const git = makeGit({ commitSha: "sha-research" });
    const prManager = makePRManager();
    const vcs = makeVCS({ createdId: 777 });

    const result = await adapter.persist(
      makeStageDef(), makeStageInput(), makeAgentResult("approved"),
      makeWorkspace("ai/research/20260416"),
      makeStagePersistInput({ onSuccess: "in-review", pr: { title: "x", body: "y", draft: false } }),
      { git, prManager, vcs }, makeCtx(),
    );

    expect(git.addAll).toHaveBeenCalledOnce();
    expect(git.commitIfChanged).toHaveBeenCalledWith("Daily research 20260416, 3 findings");
    expect(git.push).toHaveBeenCalledWith("ai/research/20260416");
    expect(prManager.createDraft).not.toHaveBeenCalled();
    expect(vcs.createCodeReview).toHaveBeenCalledWith({
      title: "x",
      body: "y",
      baseBranch: "develop",
      headBranch: "ai/research/20260416",
      draft: false,
    });
    expect(prManager.markInReview).toHaveBeenCalledWith(777);
    expect(prManager.markFailed).not.toHaveBeenCalled();
    expect(result).toEqual({
      committed: true,
      sha: "sha-research",
      prNumber: 777,
      prExisted: false,
    });
  });

  it("creates a DRAFT PR and marks failed on non-approved verdict (research all-failed)", async () => {
    const git = makeGit();
    const prManager = makePRManager({ createdId: 123 });
    const vcs = makeVCS();

    const result = await adapter.persist(
      makeStageDef(), makeStageInput(), makeAgentResult("failed"),
      makeWorkspace(),
      makeStagePersistInput({ onSuccess: "in-review", pr: { title: "f", body: "f", draft: true } }),
      { git, prManager, vcs }, makeCtx(),
    );

    expect(prManager.createDraft).toHaveBeenCalled();
    expect(vcs.createCodeReview).not.toHaveBeenCalled();
    expect(prManager.markFailed).toHaveBeenCalledWith(123);
    expect(prManager.markInReview).not.toHaveBeenCalled();
    expect(result.prNumber).toBe(123);
  });

  it("creates a DRAFT PR and applies NO transition on approved + onSuccess=none (init success)", async () => {
    const git = makeGit();
    const prManager = makePRManager({ createdId: 773 });
    const vcs = makeVCS();

    const result = await adapter.persist(
      makeStageDef(), makeStageInput(), makeAgentResult("approved"),
      makeWorkspace("ai/init"),
      makeStagePersistInput({ onSuccess: "none", pr: { title: "[AI:Init]", body: "b", draft: true } }),
      { git, prManager, vcs }, makeCtx(),
    );

    expect(prManager.createDraft).toHaveBeenCalledOnce();
    expect(prManager.markInReview).not.toHaveBeenCalled();
    expect(prManager.markFailed).not.toHaveBeenCalled();
    expect(result.prNumber).toBe(773);
  });

  it("creates a READY PR and applies NO transition on approved + onSuccess=none (improver success)", async () => {
    const git = makeGit();
    const prManager = makePRManager();
    const vcs = makeVCS({ createdId: 500 });

    const result = await adapter.persist(
      makeStageDef(), makeStageInput(), makeAgentResult("approved"),
      makeWorkspace("ai/improver/2026W16"),
      makeStagePersistInput({ onSuccess: "none", pr: { title: "[AI:Improver]", body: "b", draft: false } }),
      { git, prManager, vcs }, makeCtx(),
    );

    expect(vcs.createCodeReview).toHaveBeenCalledOnce();
    expect(prManager.createDraft).not.toHaveBeenCalled();
    expect(prManager.markInReview).not.toHaveBeenCalled();
    expect(prManager.markFailed).not.toHaveBeenCalled();
    expect(result.prNumber).toBe(500);
  });

  it("treats undefined onSuccess as 'none' (default)", async () => {
    const git = makeGit();
    const prManager = makePRManager({ createdId: 10 });
    const vcs = makeVCS();

    await adapter.persist(
      makeStageDef(), makeStageInput(), makeAgentResult("approved"),
      makeWorkspace(),
      { commitMessage: "x", pr: { title: "t", body: "b", draft: true } },
      { git, prManager, vcs }, makeCtx(),
    );

    expect(prManager.markInReview).not.toHaveBeenCalled();
    expect(prManager.markFailed).not.toHaveBeenCalled();
  });

  it("short-circuits when commitIfChanged returns null and no open PR exists", async () => {
    const git = makeGit({ commitSha: null });
    const prManager = makePRManager();
    prManager.findOpenPR.mockResolvedValueOnce(null);
    const vcs = makeVCS();

    const result = await adapter.persist(
      makeStageDef(), makeStageInput(), makeAgentResult("approved"),
      makeWorkspace(),
      makeStagePersistInput({ onSuccess: "in-review" }),
      { git, prManager, vcs }, makeCtx(),
    );

    expect(git.addAll).toHaveBeenCalledOnce();
    expect(git.commitIfChanged).toHaveBeenCalledOnce();
    expect(git.push).not.toHaveBeenCalled();
    expect(prManager.findOpenPR).toHaveBeenCalledOnce();
    expect(prManager.createDraft).not.toHaveBeenCalled();
    expect(vcs.createCodeReview).not.toHaveBeenCalled();
    expect(prManager.markInReview).not.toHaveBeenCalled();
    expect(prManager.markFailed).not.toHaveBeenCalled();
    expect(result).toEqual({
      committed: false,
      sha: null,
      prNumber: null,
      prExisted: false,
    });
  });

  it("applies label transition on no-commit when a PR already exists (PR #754 incident fix)", async () => {
    // Reproduces 2026-04-20 PR #754 incident: pr-review ran, agent decided
    // no changes needed, commitIfChanged returned null — before the fix
    // the PR was left stuck on `ai:processing` because no label transition
    // fired. After the fix, the approved verdict + onSuccess="completed"
    // still drives markCompleted on the existing PR.
    const existingPR: CodeReview = {
      id: 754, title: "existing pr-review", url: "", branch: "ai/tasks/T754",
      baseBranch: "develop", draft: false, labels: [],
      comments: [], merged: false, closed: false,
    };
    const git = makeGit({ commitSha: null });
    const prManager = makePRManager();
    prManager.findOpenPR.mockResolvedValueOnce(existingPR);
    const vcs = makeVCS();

    const result = await adapter.persist(
      makeStageDef({ name: "pr-review" }),
      makeStageInput(), makeAgentResult("approved"),
      makeWorkspace("ai/tasks/T754"),
      makeStagePersistInput({ onSuccess: "in-review" }),
      { git, prManager, vcs }, makeCtx(),
    );

    expect(prManager.findOpenPR).toHaveBeenCalledWith("ai/tasks/T754");
    expect(prManager.markInReview).toHaveBeenCalledWith(754);
    expect(prManager.markFailed).not.toHaveBeenCalled();
    expect(git.push).not.toHaveBeenCalled();
    expect(vcs.createCodeReview).not.toHaveBeenCalled();
    expect(result).toEqual({
      committed: false,
      sha: null,
      prNumber: 754,
      prExisted: true,
    });
  });

  it("marks existing PR failed on no-commit when agent verdict is not approved", async () => {
    const existingPR: CodeReview = {
      id: 754, title: "x", url: "", branch: "ai/tasks/T754",
      baseBranch: "develop", draft: false, labels: [],
      comments: [], merged: false, closed: false,
    };
    const git = makeGit({ commitSha: null });
    const prManager = makePRManager();
    prManager.findOpenPR.mockResolvedValueOnce(existingPR);
    const vcs = makeVCS();

    await adapter.persist(
      makeStageDef({ name: "pr-review" }),
      makeStageInput(), makeAgentResult("failed"),
      makeWorkspace("ai/tasks/T754"),
      makeStagePersistInput({ onSuccess: "in-review" }),
      { git, prManager, vcs }, makeCtx(),
    );

    expect(prManager.markFailed).toHaveBeenCalledWith(754);
    expect(prManager.markInReview).not.toHaveBeenCalled();
  });

  it("reuses an existing open PR instead of creating a new one", async () => {
    const existingPR: CodeReview = {
      id: 555,
      title: "existing",
      url: "",
      branch: "ai/improver/2026W16",
      baseBranch: "develop",
      labels: [{ name: "ai:processing" }],
      comments: [],
      closed: false,
      merged: false,
      draft: false,
    };
    const git = makeGit();
    const prManager = makePRManager({ existingPR });
    const vcs = makeVCS();

    const result = await adapter.persist(
      makeStageDef(), makeStageInput(), makeAgentResult("approved"),
      makeWorkspace("ai/improver/2026W16"),
      makeStagePersistInput({ onSuccess: "none", pr: { title: "t", body: "b", draft: false } }),
      { git, prManager, vcs }, makeCtx(),
    );

    expect(prManager.findOpenPR).toHaveBeenCalledWith("ai/improver/2026W16");
    expect(prManager.createDraft).not.toHaveBeenCalled();
    expect(vcs.createCodeReview).not.toHaveBeenCalled();
    expect(result.prNumber).toBe(555);
    expect(result.prExisted).toBe(true);
  });

  it("reuses an existing PR AND still applies markFailed on failed verdict (re-run of stuck improver)", async () => {
    const existingPR: CodeReview = {
      id: 600,
      title: "existing",
      url: "",
      branch: "ai/improver/2026W16",
      baseBranch: "develop",
      labels: [{ name: "ai:processing" }],
      comments: [],
      closed: false,
      merged: false,
      draft: true,
    };
    const git = makeGit();
    const prManager = makePRManager({ existingPR });
    const vcs = makeVCS();

    const result = await adapter.persist(
      makeStageDef(), makeStageInput(), makeAgentResult("failed"),
      makeWorkspace("ai/improver/2026W16"),
      makeStagePersistInput({ onSuccess: "in-review", pr: { title: "fail", body: "fail", draft: true } }),
      { git, prManager, vcs }, makeCtx(),
    );

    expect(prManager.markFailed).toHaveBeenCalledWith(600);
    expect(prManager.markInReview).not.toHaveBeenCalled();
    expect(result.prExisted).toBe(true);
    expect(result.prNumber).toBe(600);
  });

  it("skips PR creation when the post-push commit count between base and head is zero", async () => {
    const git = makeGit({ commitSha: "deadbeef", commitCount: 0 });
    const prManager = makePRManager();
    const vcs = makeVCS();

    const result = await adapter.persist(
      makeStageDef(), makeStageInput(), makeAgentResult("approved"),
      makeWorkspace(),
      makeStagePersistInput({ onSuccess: "in-review" }),
      { git, prManager, vcs }, makeCtx(),
    );

    expect(result.committed).toBe(true);
    expect(result.sha).toBe("deadbeef");
    expect(result.prNumber).toBeNull();
    expect(prManager.createDraft).not.toHaveBeenCalled();
    expect(vcs.createCodeReview).not.toHaveBeenCalled();
    expect(prManager.markInReview).not.toHaveBeenCalled();
  });

  it("treats GitHub 422 'No commits between' on PR creation as empty-diff (post-push guard)", async () => {
    // Local commitCount returns >0 (e.g. stale `origin/<base>` ref), so the
    // local empty-diff guard does not trip. GitHub then refuses
    // `pulls.create` with "No commits between" because the actual remote
    // base already includes the head's history. Persist must handle this
    // exactly like the local guard — log a WARN and return committed=true
    // with prNumber=null instead of propagating the 422.
    const git = makeGit({ commitSha: "deadbeef", commitCount: 1 });
    const prManager = makePRManager();
    const vcs = makeVCS();
    vcs.createCodeReview.mockRejectedValueOnce(
      new Error(
        `Validation Failed: {"resource":"PullRequest","code":"custom","message":"No commits between develop and ai/research/20260508"} - https://docs.github.com/rest/pulls/pulls#create-a-pull-request`,
      ),
    );

    const result = await adapter.persist(
      makeStageDef(), makeStageInput(), makeAgentResult("approved"),
      makeWorkspace("ai/research/20260508"),
      makeStagePersistInput({
        onSuccess: "in-review",
        pr: { title: "x", body: "y", draft: false },
      }),
      { git, prManager, vcs }, makeCtx(),
    );

    expect(result.committed).toBe(true);
    expect(result.sha).toBe("deadbeef");
    expect(result.prNumber).toBeNull();
    expect(result.prExisted).toBe(false);
    expect(vcs.createCodeReview).toHaveBeenCalledOnce();
    expect(prManager.createDraft).not.toHaveBeenCalled();
    expect(prManager.markInReview).not.toHaveBeenCalled();
    expect(prManager.markFailed).not.toHaveBeenCalled();
  });

  it("treats GitHub 422 'No commits between' on draft PR creation as empty-diff", async () => {
    const git = makeGit({ commitSha: "deadbeef", commitCount: 1 });
    const prManager = makePRManager();
    const vcs = makeVCS();
    prManager.createDraft.mockRejectedValueOnce(
      new Error(
        `Validation Failed: {"resource":"PullRequest","message":"No commits between develop and ai/findings/F1"}`,
      ),
    );

    const result = await adapter.persist(
      makeStageDef(), makeStageInput(), makeAgentResult("rejected"),
      makeWorkspace("ai/findings/F1"),
      makeStagePersistInput({
        pr: { title: "x", body: "y", draft: true },
      }),
      { git, prManager, vcs }, makeCtx(),
    );

    expect(result.committed).toBe(true);
    expect(result.sha).toBe("deadbeef");
    expect(result.prNumber).toBeNull();
    expect(prManager.createDraft).toHaveBeenCalledOnce();
    expect(prManager.markFailed).not.toHaveBeenCalled();
  });

  it("re-throws non-empty-diff PR creation errors", async () => {
    const git = makeGit({ commitSha: "deadbeef", commitCount: 1 });
    const prManager = makePRManager();
    const vcs = makeVCS();
    vcs.createCodeReview.mockRejectedValueOnce(
      new Error(`Validation Failed: rate limit exceeded`),
    );

    await expect(
      adapter.persist(
        makeStageDef(), makeStageInput(), makeAgentResult("approved"),
        makeWorkspace(),
        makeStagePersistInput({
          onSuccess: "in-review",
          pr: { title: "x", body: "y", draft: false },
        }),
        { git, prManager, vcs }, makeCtx(),
      ),
    ).rejects.toThrow("rate limit exceeded");
  });

  it("rejects aborted context before touching the workspace", async () => {
    const git = makeGit();
    const prManager = makePRManager();
    const vcs = makeVCS();

    await expect(
      adapter.persist(
        makeStageDef(), makeStageInput(), makeAgentResult("approved"),
        makeWorkspace(),
        makeStagePersistInput(),
        { git, prManager, vcs }, makeCtx(true),
      ),
    ).rejects.toBeInstanceOf(WorkspaceError);

    expect(git.addAll).not.toHaveBeenCalled();
    expect(git.commitIfChanged).not.toHaveBeenCalled();
    expect(git.push).not.toHaveBeenCalled();
  });

  it("captures feature-branch observations before+after commit when kv + itemId + itemPath are provided (Step 14)", async () => {
    const { mkdtemp, mkdir, writeFile, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const workspace = await mkdtemp(join(tmpdir(), "persist-obs-"));
    try {
      await mkdir(join(workspace, ".operator", "data", "tasks"), { recursive: true });
      await writeFile(
        join(workspace, ".operator", "data", "tasks", "T1.md"),
        `---\nstatus: in-progress\n---\nbody`,
        "utf-8",
      );

      const git = makeGit({ commitSha: "sha-obs" });
      const prManager = makePRManager({ createdId: 900 });
      const vcs = makeVCS();
      const kvStore = new Map<string, unknown>();
      const kv = {
        get: vi.fn(async (cat: string, key: string) =>
          kvStore.has(`${cat}/${key}`)
            ? { key, value: kvStore.get(`${cat}/${key}`) }
            : null,
        ),
        put: vi.fn(async (cat: string, key: string, value: unknown) => {
          kvStore.set(`${cat}/${key}`, value);
        }),
        delete: vi.fn(), list: vi.fn(), close: vi.fn(),
      };

      await adapter.persist(
        makeStageDef(), makeStageInput(), makeAgentResult("approved"),
        makeWorkspace("ai/tasks/T1"),
        makeStagePersistInput({
          itemId: "T1",
          itemPath: ".operator/data/tasks/T1.md",
        }),
        { git, prManager, vcs, kv: kv as never, workspacePath: workspace },
        makeCtx(),
      );

      // Two observations recorded — pre-commit + post-commit.
      const putCalls = kv.put.mock.calls.filter((c) => c[0] === "work-items");
      expect(putCalls.length).toBe(2);
      const finalRow = putCalls[1][2] as {
        statusSources?: { featureBranchFile?: { value: string; branch: string } };
      };
      expect(finalRow.statusSources?.featureBranchFile?.branch).toBe("ai/tasks/T1");
      expect(finalRow.statusSources?.featureBranchFile?.value).toBe("in-progress");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("silently skips observation when itemId/itemPath are absent", async () => {
    const git = makeGit();
    const prManager = makePRManager({ createdId: 901 });
    const vcs = makeVCS();
    const kv = {
      get: vi.fn(), put: vi.fn(), delete: vi.fn(), list: vi.fn(), close: vi.fn(),
    };

    await adapter.persist(
      makeStageDef(), makeStageInput(), makeAgentResult("approved"),
      makeWorkspace(), makeStagePersistInput(),
      { git, prManager, vcs, kv: kv as never, workspacePath: "/tmp" },
      makeCtx(),
    );

    expect(kv.put).not.toHaveBeenCalled();
  });
});
