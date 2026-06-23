import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { VCSPlatform, ConventionsConfig } from "@operator/core";
import { aggregateRetrospectiveMetrics } from "./metrics-aggregator.js";
import { makeTestKindRegistry } from "../../test-helpers/test-kind-registry.js";

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

function makeVCS(overrides?: Partial<VCSPlatform>): VCSPlatform {
  return {
    id: "github",
    capabilities: { codeReviews: true, labels: true, branches: true, comments: true, workItems: true, issueHierarchy: false },
    getCodeReviews: vi.fn().mockResolvedValue([]),
    getCodeReview: vi.fn(),
    createCodeReview: vi.fn(),
    updateCodeReview: vi.fn(),
    closeCodeReview: vi.fn(),
    getComments: vi.fn().mockResolvedValue([]),
    getReviewComments: vi.fn().mockResolvedValue([]),
    postComment: vi.fn(),
    getLabels: vi.fn().mockResolvedValue([]),
    addLabel: vi.fn(),
    removeLabel: vi.fn(),
    createBranch: vi.fn(),
    deleteBranch: vi.fn(),
    listBranches: vi.fn().mockResolvedValue([]),
    ...overrides,
  };
}

describe("aggregateRetrospectiveMetrics", () => {
  let dataDir: string;
  let tasksDir: string;
  let findingsDir: string;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "metrics-agg-"));
    tasksDir = join(dataDir, "tasks");
    findingsDir = join(dataDir, "findings");
    await mkdir(tasksDir, { recursive: true });
    await mkdir(findingsDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  async function writeTask(id: string, status: string, extra = ""): Promise<void> {
    const content = `---\nid: ${id}\nkind: task\ntitle: "${id} title"\nstatus: ${status}\npriority: 3\ncreated_at: 2026-05-01T00:00:00Z\n${extra}---\n\n${id} body.`;
    await writeFile(join(tasksDir, `${id}.md`), content, "utf-8");
  }

  async function writeFinding(id: string, status: string, extra = ""): Promise<void> {
    const content = `---\nid: ${id}\nkind: finding\ntitle: "${id} title"\nstatus: ${status}\npriority: 3\ncreated_at: 2026-05-01T00:00:00Z\n${extra}---\n\n${id} body.`;
    await writeFile(join(findingsDir, `${id}.md`), content, "utf-8");
  }

  it("emits all six section headers in order even when every store is empty", async () => {
    const out = await aggregateRetrospectiveMetrics({
      vcs: makeVCS(), kindRegistry: makeTestKindRegistry(),
      workspacePath: dataDir, conventions: CONVENTIONS,
    });
    expect(out).toContain("## Task Statistics");
    expect(out).toContain("## Recently Completed Tasks");
    expect(out).toContain("## Pending Findings");
    expect(out).toContain("## Current Task Queue");
    expect(out).toContain("## Merged PR Feedback");
    expect(out).toContain("## Rejected PR Feedback");
    const headerOrder = [
      "## Task Statistics",
      "## Recently Completed Tasks",
      "## Pending Findings",
      "## Current Task Queue",
      "## Merged PR Feedback",
      "## Rejected PR Feedback",
    ];
    let cursor = 0;
    for (const h of headerOrder) {
      const i = out.indexOf(h, cursor);
      expect(i).toBeGreaterThanOrEqual(cursor);
      cursor = i + h.length;
    }
  });

  it("renders (none) placeholders when there are no completed tasks, no findings, and no pending queue", async () => {
    const out = await aggregateRetrospectiveMetrics({
      vcs: makeVCS(), kindRegistry: makeTestKindRegistry(),
      workspacePath: dataDir, conventions: CONVENTIONS,
    });
    expect(out).toMatch(/## Recently Completed Tasks\n\(none\)/);
    expect(out).toMatch(/## Pending Findings\n\(none\)/);
    expect(out).toMatch(/## Current Task Queue\n\(none\)/);
  });

  it("counts tasks across completed / failed / pending statuses", async () => {
    await writeTask("T1", "completed", `completed_at: 2026-05-08T10:00:00Z\n`);
    await writeTask("T2", "completed", `completed_at: 2026-05-09T10:00:00Z\n`);
    await writeTask("T3", "failed", "");
    await writeTask("T4", "pending", "");
    await writeTask("T5", "pending", "");
    const out = await aggregateRetrospectiveMetrics({
      vcs: makeVCS(), kindRegistry: makeTestKindRegistry(),
      workspacePath: dataDir, conventions: CONVENTIONS,
    });
    expect(out).toContain("- Completed: 2");
    expect(out).toContain("- Failed: 1");
    expect(out).toContain("- Pending: 2");
  });

  it("sorts recently completed tasks by completedAt descending and caps at 10", async () => {
    for (let i = 1; i <= 12; i++) {
      const day = String(i).padStart(2, "0");
      await writeTask(`T${i}`, "completed", `completed_at: 2026-05-${day}T10:00:00Z\n`);
    }
    const out = await aggregateRetrospectiveMetrics({
      vcs: makeVCS(), kindRegistry: makeTestKindRegistry(),
      workspacePath: dataDir, conventions: CONVENTIONS,
    });
    const recentSection = out.split("## Recently Completed Tasks\n")[1].split("\n\n")[0];
    const lines = recentSection.split("\n").filter((l) => l.startsWith("- "));
    expect(lines.length).toBe(10);
    expect(lines[0]).toContain("**T12**");
    expect(lines[9]).toContain("**T3**");
  });

  it("lists pending findings with source label, falling back to 'unknown'", async () => {
    await writeFinding("F1", "pending", `source: typescript-strict\n`);
    await writeFinding("F2", "pending", "");
    const out = await aggregateRetrospectiveMetrics({
      vcs: makeVCS(), kindRegistry: makeTestKindRegistry(),
      workspacePath: dataDir, conventions: CONVENTIONS,
    });
    expect(out).toContain("**F1** (typescript-strict)");
    expect(out).toContain("**F2** (unknown)");
  });

  it("renders the pending queue with priority prefix", async () => {
    await writeTask("T1", "pending", "priority: 5\n");
    await writeTask("T2", "pending", "priority: 1\n");
    const out = await aggregateRetrospectiveMetrics({
      vcs: makeVCS(), kindRegistry: makeTestKindRegistry(),
      workspacePath: dataDir, conventions: CONVENTIONS,
    });
    expect(out).toMatch(/## Current Task Queue\n- \*\*T[12]\*\* \(P[15]\)/);
  });
});
