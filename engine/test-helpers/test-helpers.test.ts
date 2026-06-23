import { describe, it, expect, vi } from "vitest";
import type { OperationContext } from "@operator/core";
import { TestVCSPlatform } from "./test-vcs-platform.js";
import { TestStateManager } from "./test-state-manager.js";
import { NoOpTelemetry } from "./noop-telemetry.js";

function makeCtx(): OperationContext {
  return {
    traceId: "test-trace",
    repoId: "test-repo",
    action: "test",
    budget: { spentUsd: 0, add: vi.fn(), isExceeded: () => false },
    signal: AbortSignal.timeout(30_000),
  };
}

describe("TestVCSPlatform", () => {
  it("creates and retrieves code reviews", async () => {
    const vcs = new TestVCSPlatform();
    const cr = await vcs.createCodeReview({
      title: "Test PR",
      body: "Body",
      baseBranch: "main",
      headBranch: "ai/tasks/T001",
    });
    expect(cr.id).toBeDefined();
    expect(cr.title).toBe("Test PR");

    const found = await vcs.getCodeReview(cr.id);
    expect(found).not.toBeNull();
  });

  it("manages labels", async () => {
    const vcs = new TestVCSPlatform();
    const cr = await vcs.createCodeReview({
      title: "PR", body: "", baseBranch: "main", headBranch: "feat",
    });
    await vcs.addLabel(cr.id, "ai:pending");
    await vcs.addLabel(cr.id, "ai:processing");
    expect(await vcs.getLabels(cr.id)).toHaveLength(2);

    await vcs.removeLabel(cr.id, "ai:pending");
    expect(await vcs.getLabels(cr.id)).toHaveLength(1);
  });

  it("manages branches", async () => {
    const vcs = new TestVCSPlatform();
    await vcs.createBranch("ai/tasks/T001", "main");
    await vcs.createBranch("ai/tasks/T002", "main");
    await vcs.createBranch("ai/research/2026-03-19", "main");

    expect(await vcs.listBranches("ai/tasks/")).toHaveLength(2);
    expect(await vcs.listBranches()).toHaveLength(3);

    await vcs.deleteBranch("ai/tasks/T001");
    expect(await vcs.listBranches("ai/tasks/")).toHaveLength(1);
  });

  it("posts and retrieves comments", async () => {
    const vcs = new TestVCSPlatform();
    const cr = await vcs.createCodeReview({
      title: "PR", body: "", baseBranch: "main", headBranch: "feat",
    });
    await vcs.postComment(cr.id, "LGTM");
    const comments = await vcs.getComments(cr.id);
    expect(comments).toHaveLength(1);
    expect(comments[0].body).toBe("LGTM");
  });

  it("closes code reviews", async () => {
    const vcs = new TestVCSPlatform();
    const cr = await vcs.createCodeReview({
      title: "PR", body: "", baseBranch: "main", headBranch: "feat",
    });
    await vcs.closeCodeReview(cr.id);
    const found = await vcs.getCodeReview(cr.id);
    expect(found?.closed).toBe(true);
  });
});

describe("TestStateManager", () => {
  it("upserts and retrieves work items", async () => {
    const state = new TestStateManager();
    const ctx = makeCtx();
    await state.upsertWorkItem(ctx, {
      id: "T001", type: "task", title: "Fix", body: "Details",
      status: "pending", priority: 2, createdAt: "2026-03-19T10:00:00Z",
      updatedAt: "2026-03-19T10:00:00Z",
    });
    const item = await state.getWorkItem(ctx, "T001");
    expect(item?.title).toBe("Fix");
  });

  it("tracks schedules", async () => {
    const state = new TestStateManager();
    const ctx = makeCtx();

    expect(await state.isScheduleDue(ctx, "repo", "research", 60)).toBe(true);
    await state.markScheduleRun(ctx, "repo", "research");
    expect(await state.isScheduleDue(ctx, "repo", "research", 60)).toBe(false);
  });

  it("tracks dedup", async () => {
    const state = new TestStateManager();
    const ctx = makeCtx();

    expect(await state.isKnownItem(ctx, "repo", "issue:42")).toBe(false);
    await state.markKnownItem(ctx, "repo", "issue:42");
    expect(await state.isKnownItem(ctx, "repo", "issue:42")).toBe(true);
  });

  it("close is safe to call", () => {
    const state = new TestStateManager();
    state.close(); // no-op, should not throw
  });
});

describe("NoOpTelemetry", () => {
  it("captures messages", () => {
    const tel = new NoOpTelemetry();
    tel.info("started", { repo: "sample" });
    tel.warn("slow");
    tel.error("failed", { code: "ERR" });

    expect(tel.messages).toHaveLength(3);
    expect(tel.messages[0].level).toBe("info");
    expect(tel.messages[2].message).toBe("failed");
  });
});
