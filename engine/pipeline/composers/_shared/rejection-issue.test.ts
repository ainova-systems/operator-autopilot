import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ConventionsConfig, TrackerPlatform } from "@operator/core";
import type { TemplateSource } from "../../../agents/kv-template-source.js";
import type { Logger } from "../../../logging/logger.js";
import {
  createRejectionIssue,
  loadRejectedIssueTemplate,
  type RejectionIssueDeps,
} from "./rejection-issue.js";

const CONVENTIONS: ConventionsConfig = {
  labels: {
    pending: "ai:pending", processing: "ai:processing",
    inReview: "ai:in-review", readyToMerge: "ai:ready-to-merge", failed: "ai:failed", manual: "ai:manual",
  },
  branches: {
    aiPrefix: "ai", init: "ai/init", tasks: "ai/tasks",
    findings: "ai/findings", research: "ai/research", improver: "ai/improver",
  },
  prPrefixes: {
    task: "[AI:Task]", finding: "[AI:Finding]", research: "[AI:Research]",
    improver: "[AI:Improver]", init: "[AI:Init]",
  },
  patterns: { taskId: "T{DATE}-{SEQ}", findingPrefix: "F" },
  commentMarker: "<!-- bot:operator -->",
};

function makeTracker(): TrackerPlatform {
  return {
    id: "github",
    capabilities: { codeReviews: false, labels: false, branches: false, comments: false, workItems: true, issueHierarchy: false },
    getWorkItems: vi.fn().mockResolvedValue([]),
    getWorkItem: vi.fn().mockResolvedValue(null),
    updateWorkItem: vi.fn().mockResolvedValue(undefined),
    postWorkItemComment: vi.fn().mockResolvedValue({ id: "1", author: "bot", body: "", createdAt: "" }),
    createWorkItem: vi.fn().mockResolvedValue({ id: "1", kind: "request", title: "", body: "", status: "pending", priority: 5, createdAt: "", updatedAt: "" }),
  };
}

let tmp: string;
let templatesDir: string;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "rejection-issue-"));
  templatesDir = join(tmp, "templates");
  await mkdir(templatesDir, { recursive: true });
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

function makeDeps(overrides?: Partial<RejectionIssueDeps>): RejectionIssueDeps {
  return {
    tracker: makeTracker(),
    conventions: CONVENTIONS,
    templatesDir,
    ...overrides,
  };
}

describe("loadRejectedIssueTemplate", () => {
  it("loads from TemplateSource when wired", async () => {
    const templates = {
      load: vi.fn().mockResolvedValue("kv-body {ITEM_ID}"),
    } as unknown as TemplateSource;
    const body = await loadRejectedIssueTemplate(makeDeps({ templates }), { ITEM_ID: "T1" });
    expect(body).toBe("kv-body {ITEM_ID}");
    expect(templates.load).toHaveBeenCalledWith("rejected-issue-body.md", { ITEM_ID: "T1" });
  });

  it("falls back to filesystem read when TemplateSource is missing", async () => {
    await writeFile(join(templatesDir, "rejected-issue-body.md"), "fs-body {ITEM_ID}");
    const warn = vi.fn();
    const log = { info: vi.fn(), debug: vi.fn(), warn, error: vi.fn() } as unknown as Logger;
    const body = await loadRejectedIssueTemplate(makeDeps({ log }), { ITEM_ID: "T1" });
    expect(body).toBe("fs-body T1");
    expect(warn).toHaveBeenCalledWith(
      "rejection: TemplateSource missing, falling back to filesystem read",
      expect.objectContaining({ scope: "rejection", templatesDir }),
    );
  });
});

describe("createRejectionIssue", () => {
  it("creates a manual tracker issue with substituted template", async () => {
    await writeFile(join(templatesDir, "rejected-issue-body.md"), "{ITEM_ID} {RECOMMENDATION}");
    const tracker = makeTracker();
    await createRejectionIssue(
      makeDeps({ tracker }),
      {
        id: "T20260322-000101", kind: "task", title: "Fix bug", body: "details",
        status: "pending", priority: 5, createdAt: "", previousPrs: "10,20",
      },
      "task",
      50,
      "max-retries",
      2,
    );
    expect(tracker.createWorkItem).toHaveBeenCalledOnce();
    expect(tracker.createWorkItem).toHaveBeenCalledWith({
      title: "[ai:manual] task T20260322-000101: Fix bug",
      body: "T20260322-000101 max-retries",
      labels: ["ai:manual"],
    });
  });

  it("returns without calling tracker when none is supplied", async () => {
    const tracker = makeTracker();
    await createRejectionIssue(
      makeDeps({ tracker: undefined }),
      {
        id: "T1", kind: "task", title: "T", body: "",
        status: "pending", priority: 5, createdAt: "",
      },
      "task",
      1,
      "max-retries",
      0,
    );
    expect(tracker.createWorkItem).not.toHaveBeenCalled();
  });

  it("logs error and continues when tracker.createWorkItem fails", async () => {
    await writeFile(join(templatesDir, "rejected-issue-body.md"), "{ITEM_ID}");
    const tracker = makeTracker();
    (tracker.createWorkItem as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("boom"));
    const error = vi.fn();
    const log = { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error } as unknown as Logger;
    await createRejectionIssue(
      makeDeps({ tracker, log }),
      {
        id: "T20260322-000101", kind: "task", title: "T1", body: "",
        status: "pending", priority: 5, createdAt: "", previousPrs: "10,20",
      },
      "task",
      50,
      "max-retries",
      2,
    );
    expect(error).toHaveBeenCalledWith(
      "rejection: manual-issue creation failed for T20260322-000101",
      expect.objectContaining({ scope: "rejection", itemId: "T20260322-000101" }),
    );
  });
});
