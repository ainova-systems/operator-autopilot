import { describe, it, expect, vi } from "vitest";
import type { VCSPlatform } from "@operator/core";
import type { ConventionsConfig } from "@operator/core";
import { PRManager } from "./pr-manager.js";
import type { TemplateSource } from "../agents/kv-template-source.js";

const CONVENTIONS: ConventionsConfig = {
  labels: { pending: "ai:pending", processing: "ai:processing", inReview: "ai:in-review", readyToMerge: "ai:ready-to-merge", failed: "ai:failed", manual: "ai:manual", cancelled: "ai:cancelled", rejected: "ai:rejected" },
  branches: { aiPrefix: "ai", init: "ai/init", tasks: "ai/tasks", findings: "ai/findings", research: "ai/research", improver: "ai/improver" },
  prPrefixes: { task: "[AI:Task]", finding: "[AI:Finding]", research: "[AI:Research]", improver: "[AI:Improver]", init: "[AI:Init]" },
  patterns: { taskId: "T{DATE}-{SEQ}", findingPrefix: "F" },
  commentMarker: "<!-- bot:operator -->",
};

function makeVCS(overrides?: Partial<VCSPlatform>): VCSPlatform {
  return {
    id: "github", capabilities: { codeReviews: true, labels: true, branches: true, comments: true, workItems: true, issueHierarchy: false },
    getCodeReviews: vi.fn().mockResolvedValue([]),
    getCodeReview: vi.fn(),
    createCodeReview: vi.fn().mockResolvedValue({ id: 42, title: "", url: "", branch: "", baseBranch: "", draft: true, labels: [], comments: [], merged: false, closed: false }),
    updateCodeReview: vi.fn().mockResolvedValue(undefined),
    closeCodeReview: vi.fn().mockResolvedValue(undefined),
    getComments: vi.fn().mockResolvedValue([]), getReviewComments: vi.fn().mockResolvedValue([]),
    postComment: vi.fn().mockResolvedValue({ id: "c1", author: "bot", body: "", createdAt: "" }),
    getLabels: vi.fn().mockResolvedValue([]),
    addLabel: vi.fn().mockResolvedValue(undefined),
    removeLabel: vi.fn().mockResolvedValue(undefined),
    createBranch: vi.fn(), deleteBranch: vi.fn(), listBranches: vi.fn().mockResolvedValue([]),
    ...overrides,
  };
}

describe("PRManager", () => {
  it("createDraft creates PR and adds pending label", async () => {
    const vcs = makeVCS();
    const pm = new PRManager(vcs, CONVENTIONS);

    const cr = await pm.createDraft({
      title: "Test PR", body: "Body", branch: "ai/test", baseBranch: "develop",
    });

    expect(cr.id).toBe(42);
    expect(vcs.createCodeReview).toHaveBeenCalledWith(expect.objectContaining({ draft: true }));
    expect(vcs.addLabel).toHaveBeenCalledWith(42, "ai:pending");
  });

  it("markProcessing removes existing labels and adds processing", async () => {
    const vcs = makeVCS({
      getLabels: vi.fn().mockResolvedValue([{ name: "ai:pending" }, { name: "ai:in-review" }]),
    });
    const pm = new PRManager(vcs, CONVENTIONS);

    await pm.markProcessing(42);

    expect(vcs.removeLabel).toHaveBeenCalledWith(42, "ai:pending");
    expect(vcs.removeLabel).toHaveBeenCalledWith(42, "ai:in-review");
    expect(vcs.addLabel).toHaveBeenCalledWith(42, "ai:processing");
  });

  it("markProcessing skips remove when labels not present", async () => {
    const vcs = makeVCS(); // getLabels returns []
    const pm = new PRManager(vcs, CONVENTIONS);

    await pm.markProcessing(42);

    expect(vcs.removeLabel).not.toHaveBeenCalled();
    expect(vcs.addLabel).toHaveBeenCalledWith(42, "ai:processing");
  });

  it("markInReview removes processing and adds in-review", async () => {
    const vcs = makeVCS({
      getLabels: vi.fn().mockResolvedValue([{ name: "ai:processing" }]),
    });
    const pm = new PRManager(vcs, CONVENTIONS);

    await pm.markInReview(42);

    expect(vcs.removeLabel).toHaveBeenCalledWith(42, "ai:processing");
    expect(vcs.addLabel).toHaveBeenCalledWith(42, "ai:in-review");
    expect(vcs.updateCodeReview).toHaveBeenCalledWith(42, { draft: false });
  });

  it("markReadyToMerge removes in-review and adds ready-to-merge", async () => {
    const vcs = makeVCS({
      getLabels: vi.fn().mockResolvedValue([{ name: "ai:in-review" }]),
    });
    const pm = new PRManager(vcs, CONVENTIONS);

    await pm.markReadyToMerge(42);

    expect(vcs.removeLabel).toHaveBeenCalledWith(42, "ai:in-review");
    expect(vcs.addLabel).toHaveBeenCalledWith(42, "ai:ready-to-merge");
    expect(vcs.updateCodeReview).toHaveBeenCalledWith(42, { draft: false });
  });

  it("markFailed removes processing and adds failed", async () => {
    const vcs = makeVCS({
      getLabels: vi.fn().mockResolvedValue([{ name: "ai:processing" }]),
    });
    const pm = new PRManager(vcs, CONVENTIONS);

    await pm.markFailed(42);

    expect(vcs.removeLabel).toHaveBeenCalledWith(42, "ai:processing");
    expect(vcs.addLabel).toHaveBeenCalledWith(42, "ai:failed");
  });

  it("markFailed sweeps pending / inReview / readyToMerge too", async () => {
    const vcs = makeVCS({
      getLabels: vi.fn().mockResolvedValue([
        { name: "ai:pending" },
        { name: "ai:in-review" },
        { name: "ai:ready-to-merge" },
      ]),
    });
    const pm = new PRManager(vcs, CONVENTIONS);

    await pm.markFailed(42);

    expect(vcs.removeLabel).toHaveBeenCalledWith(42, "ai:pending");
    expect(vcs.removeLabel).toHaveBeenCalledWith(42, "ai:in-review");
    expect(vcs.removeLabel).toHaveBeenCalledWith(42, "ai:ready-to-merge");
    expect(vcs.addLabel).toHaveBeenCalledWith(42, "ai:failed");
  });

  it("closeAndClean closes PR and removes only existing labels", async () => {
    const vcs = makeVCS({
      getLabels: vi.fn().mockResolvedValue([{ name: "ai:processing" }]),
    });
    const pm = new PRManager(vcs, CONVENTIONS);

    await pm.closeAndClean(42);

    expect(vcs.closeCodeReview).toHaveBeenCalledWith(42);
    expect(vcs.removeLabel).toHaveBeenCalledWith(42, "ai:processing");
    expect(vcs.removeLabel).not.toHaveBeenCalledWith(42, "ai:pending");
  });

  it("skips addLabel when label already present", async () => {
    const vcs = makeVCS({
      getLabels: vi.fn().mockResolvedValue([{ name: "ai:processing" }]),
    });
    const pm = new PRManager(vcs, CONVENTIONS);

    await pm.markProcessing(42); // should not add ai:processing again

    expect(vcs.addLabel).not.toHaveBeenCalled();
  });

  it("postBotComment includes marker", async () => {
    const vcs = makeVCS();
    const pm = new PRManager(vcs, CONVENTIONS);

    await pm.postBotComment(42, "Applied changes.");

    expect(vcs.postComment).toHaveBeenCalledWith(42, expect.stringContaining("<!-- bot:operator -->"));
    expect(vcs.postComment).toHaveBeenCalledWith(42, expect.stringContaining("Applied changes."));
  });

  it("postThreadReply replies with the marker prepended", async () => {
    const replyToReviewThread = vi.fn().mockResolvedValue(undefined);
    const vcs = makeVCS({ replyToReviewThread });
    const pm = new PRManager(vcs, CONVENTIONS);

    await pm.postThreadReply("THREAD_A", "Addressed — added the guard.");

    expect(replyToReviewThread).toHaveBeenCalledWith({
      threadId: "THREAD_A",
      body: expect.stringContaining("<!-- bot:operator -->"),
    });
    expect(replyToReviewThread).toHaveBeenCalledWith({
      threadId: "THREAD_A",
      body: expect.stringContaining("added the guard"),
    });
  });

  it("postThreadReply is a no-op when the platform has no thread-reply support", async () => {
    const vcs = makeVCS();
    const pm = new PRManager(vcs, CONVENTIONS);
    await expect(pm.postThreadReply("THREAD_A", "note")).resolves.toBeUndefined();
  });

  it("resolveThread resolves via the platform", async () => {
    const resolveReviewThread = vi.fn().mockResolvedValue(undefined);
    const vcs = makeVCS({ resolveReviewThread });
    const pm = new PRManager(vcs, CONVENTIONS);

    await pm.resolveThread("THREAD_A");
    expect(resolveReviewThread).toHaveBeenCalledWith("THREAD_A");
  });

  it("resolveThread is a no-op when the platform has no thread-resolve support", async () => {
    const vcs = makeVCS();
    const pm = new PRManager(vcs, CONVENTIONS);
    await expect(pm.resolveThread("THREAD_A")).resolves.toBeUndefined();
  });

  it("findOpenPR returns matching PR", async () => {
    const vcs = makeVCS({
      getCodeReviews: vi.fn().mockResolvedValue([
        { id: 10, branch: "ai/tasks/T1", closed: false },
        { id: 11, branch: "ai/tasks/T2", closed: true },
      ]),
    });
    const pm = new PRManager(vcs, CONVENTIONS);

    expect(await pm.findOpenPR("ai/tasks/T1")).toEqual(expect.objectContaining({ id: 10 }));
    expect(await pm.findOpenPR("ai/tasks/T2")).toBeNull();
    expect(await pm.findOpenPR("ai/tasks/T3")).toBeNull();
  });

  it("findOpenAIPRs filters by ai/ prefix", async () => {
    const vcs = makeVCS({
      getCodeReviews: vi.fn().mockResolvedValue([
        { id: 1, branch: "ai/tasks/T1", closed: false },
        { id: 2, branch: "feature/x", closed: false },
        { id: 3, branch: "ai/findings/F1", closed: true },
      ]),
    });
    const pm = new PRManager(vcs, CONVENTIONS);

    const prs = await pm.findOpenAIPRs();
    expect(prs).toHaveLength(1);
    expect(prs[0].id).toBe(1);
  });

  it("loadTemplate delegates to TemplateSource and substitutes variables", async () => {
    const templateSource: TemplateSource = {
      load: vi.fn().mockResolvedValue("Hello World, week 2026W12!"),
    };
    const pm = new PRManager(makeVCS(), CONVENTIONS, templateSource);
    const result = await pm.loadTemplate("/ignored", "test.md", { NAME: "World", WEEK: "2026W12" });
    expect(result).toBe("Hello World, week 2026W12!");
    expect(templateSource.load).toHaveBeenCalledWith("test.md", { NAME: "World", WEEK: "2026W12" });
  });

  it("loadTemplate throws when no TemplateSource is configured", async () => {
    const pm = new PRManager(makeVCS(), CONVENTIONS);
    await expect(pm.loadTemplate("/ignored", "x.md", {})).rejects.toThrow(/TemplateSource not configured/);
  });

  it("label operations handle errors gracefully", async () => {
    const vcs = makeVCS({
      getLabels: vi.fn().mockResolvedValue([{ name: "ai:pending" }, { name: "ai:processing" }]),
      removeLabel: vi.fn().mockRejectedValue(new Error("404")),
      addLabel: vi.fn().mockRejectedValue(new Error("422")),
    });
    const pm = new PRManager(vcs, CONVENTIONS);

    await pm.markProcessing(42);
    await pm.markInReview(42);
    await pm.markReadyToMerge(42);
    await pm.markFailed(42);
    await pm.markCancelled(42);
    await pm.markRejected(42);
    await pm.closeAndClean(42);
  });

  it("markCancelled sets ai:cancelled label and closes PR", async () => {
    const vcs = makeVCS({
      getLabels: vi.fn().mockResolvedValue([{ name: "ai:processing" }]),
    });
    const pm = new PRManager(vcs, CONVENTIONS);

    await pm.markCancelled(42);

    expect(vcs.removeLabel).toHaveBeenCalledWith(42, "ai:processing");
    expect(vcs.addLabel).toHaveBeenCalledWith(42, "ai:cancelled");
    expect(vcs.closeCodeReview).toHaveBeenCalledWith(42);
  });

  it("markRejected sets ai:rejected label and closes PR", async () => {
    const vcs = makeVCS({
      getLabels: vi.fn().mockResolvedValue([{ name: "ai:processing" }]),
    });
    const pm = new PRManager(vcs, CONVENTIONS);

    await pm.markRejected(42);

    expect(vcs.removeLabel).toHaveBeenCalledWith(42, "ai:processing");
    expect(vcs.addLabel).toHaveBeenCalledWith(42, "ai:rejected");
    expect(vcs.closeCodeReview).toHaveBeenCalledWith(42);
  });

  it("markCancelled removes previous in-review label if present", async () => {
    const vcs = makeVCS({
      getLabels: vi.fn().mockResolvedValue([{ name: "ai:in-review" }]),
    });
    const pm = new PRManager(vcs, CONVENTIONS);

    await pm.markCancelled(42);

    expect(vcs.removeLabel).toHaveBeenCalledWith(42, "ai:in-review");
    expect(vcs.addLabel).toHaveBeenCalledWith(42, "ai:cancelled");
  });

  it("cancelled label falls back to ai:cancelled when convention omits it", async () => {
    const vcs = makeVCS({ getLabels: vi.fn().mockResolvedValue([]) });
    const minimalConv: ConventionsConfig = {
      ...CONVENTIONS,
      labels: { pending: "ai:pending", processing: "ai:processing", inReview: "ai:in-review", readyToMerge: "ai:ready-to-merge", failed: "ai:failed" },
    };
    const pm = new PRManager(vcs, minimalConv);

    await pm.markCancelled(42);
    expect(vcs.addLabel).toHaveBeenCalledWith(42, "ai:cancelled");
  });
});
