import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { OperationContext, VCSPlatform, CodeReview, KindRegistry } from "@operator/core";
import type { StateManager } from "@operator/core";
import {
  createWorkItemFile,
  readWorkItemFile,
  parseWorkItemContent,
  updateWorkItemFileStatus,
  syncWorkItemToDb,
  syncFilesToState,
  updateStatusAndSync,
  buildStateContext,
  listPendingItems,
  summarizeTasks,
  collectMergedPRFeedback,
  collectRejectedPRFeedback,
  stampWorkItem,
  derivePathFromBody,
  aggregateDerivedCompletions,
} from "./work-items.js";
import type { WorkItemFileData } from "./work-items.js";

// ── Helpers ──────────────────────────────────────────────────────────

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "wi-test-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

function makeCtx(): OperationContext {
  return {
    traceId: "test-trace",
    repoId: "test-repo",
    action: "test",
    budget: { spentUsd: 0, add: vi.fn(), isExceeded: () => false },
    signal: AbortSignal.timeout(30_000),
  };
}

function makeFinding(overrides?: Partial<WorkItemFileData>): WorkItemFileData {
  return {
    id: "F20260322-0001",
    kind: "finding",
    title: "SQL injection in login",
    body: "Detailed description of the vulnerability.",
    status: "pending",
    priority: 3,
    source: "code-analyzer",
    createdAt: "2026-03-22T10:00:00Z",
    ...overrides,
  };
}

function makeTask(overrides?: Partial<WorkItemFileData>): WorkItemFileData {
  return {
    id: "T20260322-000101",
    kind: "task",
    title: "Fix SQL injection",
    body: "Implement parameterized queries.",
    status: "pending",
    priority: 3,
    createdAt: "2026-03-22T10:30:00Z",
    parentId: "F20260322-0001",
    ...overrides,
  };
}

/** In-memory KindRegistry stub — three standard kinds. */
function makeRegistry(): KindRegistry {
  const entries = [
    { name: "finding", label: "Finding", idPrefix: "F", dataDir: "findings",
      branchPrefix: "ai/findings", prPrefix: "[AI:Finding]",
      terminalStatuses: ["completed", "failed", "rejected", "duplicate"] },
    { name: "task", label: "Task", idPrefix: "T", dataDir: "tasks",
      branchPrefix: "ai/tasks", prPrefix: "[AI:Task]",
      terminalStatuses: ["completed", "failed", "rejected", "duplicate", "cancelled"] },
    { name: "request", label: "Request", idPrefix: "R", dataDir: "requests",
      branchPrefix: "ai/requests", prPrefix: "[AI:Request]",
      terminalStatuses: ["completed", "rejected"] },
  ] as const;
  return {
    all: entries,
    get: (kind) => entries.find((e) => e.name === kind),
    isTerminal: (kind, status) => entries.find((e) => e.name === kind)?.terminalStatuses.includes(status) ?? false,
    labelFor: (kind) => entries.find((e) => e.name === kind)?.label ?? "Unknown",
    branchPrefixFor: (kind) => entries.find((e) => e.name === kind)?.branchPrefix ?? "",
    dataDirFor: (kind) => entries.find((e) => e.name === kind)?.dataDir ?? "",
    generateId: async (kind, date) => {
      const def = entries.find((e) => e.name === kind);
      if (!def) throw new Error(`unknown kind: ${kind}`);
      const d = date ?? "20260322";
      return `${def.idPrefix}${d}-0001`;
    },
  };
}

// ── File operations ──────────────────────────────────────────────────

describe("createWorkItemFile", () => {
  it("creates finding file with frontmatter and body", async () => {
    const item = makeFinding();
    const path = await createWorkItemFile(tempDir, item);

    expect(path).toBe(join(tempDir, "F20260322-0001.md"));
    const content = await readFile(path, "utf-8");
    expect(content).toContain("id: F20260322-0001");
    expect(content).toContain('title: "SQL injection in login"');
    expect(content).toContain("status: pending");
    expect(content).toContain("priority: 3");
    expect(content).toContain('source: "code-analyzer"');
    expect(content).toContain("Detailed description");
  });

  it("creates task file with parent_id", async () => {
    const item = makeTask();
    const path = await createWorkItemFile(tempDir, item);

    const content = await readFile(path, "utf-8");
    expect(content).toContain('parent_id: "F20260322-0001"');
  });

  it("creates task file with depends_on", async () => {
    const item = makeTask({ dependsOn: ["T20260322-000100", "T20260322-000099"] });
    const path = await createWorkItemFile(tempDir, item);

    const content = await readFile(path, "utf-8");
    expect(content).toContain("depends_on: T20260322-000100,T20260322-000099");
  });
});

describe("readWorkItemFile", () => {
  it("reads and parses finding file", async () => {
    const original = makeFinding();
    const path = await createWorkItemFile(tempDir, original);

    const parsed = await readWorkItemFile(path);
    expect(parsed.id).toBe("F20260322-0001");
    expect(parsed.kind).toBe("finding");
    expect(parsed.title).toBe("SQL injection in login");
    expect(parsed.status).toBe("pending");
    expect(parsed.priority).toBe(3);
    expect(parsed.source).toBe("code-analyzer");
    expect(parsed.body).toBe("Detailed description of the vulnerability.");
  });

  it("reads and parses task file with parent_id", async () => {
    const original = makeTask();
    const path = await createWorkItemFile(tempDir, original);

    const parsed = await readWorkItemFile(path);
    expect(parsed.id).toBe("T20260322-000101");
    expect(parsed.kind).toBe("task");
    expect(parsed.parentId).toBe("F20260322-0001");
  });


  it("infers kind from ID prefix (legacy fallback, no registry)", async () => {
    const content = "---\nid: F20260322-0001\ntitle: Test\nstatus: pending\npriority: 5\ncreated_at: now\n---\n\nBody\n";
    const path = join(tempDir, "F20260322-0001.md");
    await writeFile(path, content);

    const parsed = await readWorkItemFile(path);
    expect(parsed.kind).toBe("finding");
  });

  it("falls back to filename for missing id", async () => {
    const content = "---\ntitle: No ID\nstatus: pending\npriority: 5\ncreated_at: now\n---\n\nBody\n";
    const path = join(tempDir, "T20260322-000101.md");
    await writeFile(path, content);

    const parsed = await readWorkItemFile(path);
    expect(parsed.id).toBe("T20260322-000101");
    expect(parsed.kind).toBe("task");
  });

  it("throws on invalid frontmatter", async () => {
    const path = join(tempDir, "bad.md");
    await writeFile(path, "No frontmatter here");

    await expect(readWorkItemFile(path)).rejects.toThrow("Invalid frontmatter");
  });
});

// ── stampWorkItem (updatedAt + lastEventAt semantics) ────────────────

describe("stampWorkItem", () => {
  function baseRow(overrides?: Record<string, unknown>): Record<string, unknown> {
    return {
      id: "F20260501-0001",
      kind: "finding",
      title: "Test",
      status: "pending",
      priority: 5,
      createdAt: "2026-05-01T10:00:00.000Z",
      statusReason: "initial",
      hasDrift: false,
      isActive: true,
      statusSources: {
        developFile: { value: "pending", observedAt: "2026-05-01T10:00:00.000Z" },
      },
      recentExecutionIds: [],
      ...overrides,
    };
  }

  it("seeds lastEventAt from createdAt when there is no prior row", () => {
    const stamped = stampWorkItem(undefined, baseRow());
    expect(stamped.lastEventAt).toBe("2026-05-01T10:00:00.000Z");
    expect(stamped.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(stamped.updatedAt).toEqual(expect.any(String));
  });

  it("preserves both updatedAt and lastEventAt when content is unchanged", async () => {
    const first = stampWorkItem(undefined, baseRow());
    await new Promise((r) => setTimeout(r, 5));
    const second = stampWorkItem(first, baseRow());
    expect(second.updatedAt).toBe(first.updatedAt);
    expect(second.lastEventAt).toBe(first.lastEventAt);
    expect(second.contentHash).toBe(first.contentHash);
  });

  it("preserves both timestamps when only observedAt drifts", async () => {
    const first = stampWorkItem(undefined, baseRow());
    await new Promise((r) => setTimeout(r, 5));
    const refreshed = baseRow({
      statusSources: {
        developFile: { value: "pending", observedAt: "2026-05-01T11:00:00.000Z" },
      },
    });
    const second = stampWorkItem(first, refreshed);
    expect(second.updatedAt).toBe(first.updatedAt);
    expect(second.lastEventAt).toBe(first.lastEventAt);
  });

  it("bumps both timestamps when status flips", async () => {
    const first = stampWorkItem(undefined, baseRow());
    await new Promise((r) => setTimeout(r, 5));
    const second = stampWorkItem(first, baseRow({ status: "in-review" }));
    expect(second.updatedAt).not.toBe(first.updatedAt);
    expect(second.lastEventAt).not.toBe(first.lastEventAt);
    expect(new Date(second.lastEventAt).getTime()).toBeGreaterThan(
      new Date(first.lastEventAt).getTime(),
    );
  });

  it("bumps lastEventAt when a new execution id is prepended", async () => {
    const first = stampWorkItem(undefined, baseRow());
    await new Promise((r) => setTimeout(r, 5));
    const second = stampWorkItem(first, baseRow({ recentExecutionIds: ["exec-1"] }));
    expect(second.lastEventAt).not.toBe(first.lastEventAt);
  });

  it("bumps lastEventAt on a prState transition (open → merged)", async () => {
    const first = stampWorkItem(undefined, baseRow({
      statusSources: {
        developFile: { value: "pending", observedAt: "2026-05-01T10:00:00.000Z" },
        prState: { value: "open", observedAt: "2026-05-01T10:00:00.000Z", prNumber: 42, branch: "ai/findings/F1" },
      },
    }));
    await new Promise((r) => setTimeout(r, 5));
    const second = stampWorkItem(first, baseRow({
      statusSources: {
        developFile: { value: "pending", observedAt: "2026-05-01T11:00:00.000Z" },
        prState: { value: "merged", observedAt: "2026-05-01T11:00:00.000Z", prNumber: 42, branch: "ai/findings/F1" },
      },
    }));
    expect(second.lastEventAt).not.toBe(first.lastEventAt);
  });

  it("bumps lastEventAt on a checks transition (passing → failing)", async () => {
    const first = stampWorkItem(undefined, baseRow({
      statusSources: {
        developFile: { value: "pending", observedAt: "2026-05-01T10:00:00.000Z" },
        checks: { value: "passing", observedAt: "2026-05-01T10:00:00.000Z", checks: [] },
      },
    }));
    await new Promise((r) => setTimeout(r, 5));
    const second = stampWorkItem(first, baseRow({
      statusSources: {
        developFile: { value: "pending", observedAt: "2026-05-01T11:00:00.000Z" },
        checks: { value: "failing", observedAt: "2026-05-01T11:00:00.000Z", checks: [] },
      },
    }));
    expect(second.lastEventAt).not.toBe(first.lastEventAt);
  });

  it("preserves lastEventAt when only nested check timestamps drift", async () => {
    const first = stampWorkItem(undefined, baseRow({
      statusSources: {
        developFile: { value: "pending", observedAt: "2026-05-01T10:00:00.000Z" },
        checks: {
          value: "passing",
          observedAt: "2026-05-01T10:00:00.000Z",
          checks: [
            { name: "lint", conclusion: "success", completedAt: "2026-05-01T09:30:00.000Z" },
          ],
        },
      },
    }));
    await new Promise((r) => setTimeout(r, 5));
    // Same aggregate value, only the inner observedAt + per-check
    // completedAt drift → row content hashes the same → no event.
    const second = stampWorkItem(first, baseRow({
      statusSources: {
        developFile: { value: "pending", observedAt: "2026-05-01T11:00:00.000Z" },
        checks: {
          value: "passing",
          observedAt: "2026-05-01T11:00:00.000Z",
          checks: [
            { name: "lint", conclusion: "success", completedAt: "2026-05-01T09:30:00.000Z" },
          ],
        },
      },
    }));
    expect(second.lastEventAt).toBe(first.lastEventAt);
    expect(second.updatedAt).toBe(first.updatedAt);
  });

  it("bumps updatedAt but not lastEventAt for non-event content drift (e.g. title fix)", async () => {
    const first = stampWorkItem(undefined, baseRow());
    await new Promise((r) => setTimeout(r, 5));
    const second = stampWorkItem(first, baseRow({ title: "Renamed" }));
    expect(second.updatedAt).not.toBe(first.updatedAt);
    expect(second.lastEventAt).toBe(first.lastEventAt);
  });
});

describe("parseWorkItemContent", () => {
  it("parses priority defaults to 5", () => {
    const content = "---\nid: F1\ntitle: T\nstatus: pending\ncreated_at: now\n---\n\nBody\n";
    const parsed = parseWorkItemContent(content, "F1.md");
    expect(parsed.priority).toBe(5);
  });

  it("clamps invalid priority to 5", () => {
    const content = "---\nid: F1\ntitle: T\nstatus: pending\npriority: 99\ncreated_at: now\n---\n\nBody\n";
    const parsed = parseWorkItemContent(content, "F1.md");
    expect(parsed.priority).toBe(5);
  });

  it("prefers `kind` frontmatter field over inferring from id prefix", () => {
    const content = "---\nid: F1\ntitle: T\nkind: request\nstatus: pending\ncreated_at: now\n---\n\nBody\n";
    const parsed = parseWorkItemContent(content, "F1.md");
    expect(parsed.kind).toBe("request");
  });

  it("reads legacy `type` frontmatter field when `kind` is absent", () => {
    const content = "---\nid: F1\ntitle: T\ntype: request\nstatus: pending\ncreated_at: now\n---\n\nBody\n";
    const parsed = parseWorkItemContent(content, "F1.md");
    expect(parsed.kind).toBe("request");
  });

  it("uses registry longest-prefix match when registry is supplied", () => {
    const registry = makeRegistry();
    const content = "---\nid: F20260322-0001\ntitle: Test\nstatus: pending\ncreated_at: now\n---\n\nBody\n";
    const parsed = parseWorkItemContent(content, "F20260322-0001.md", registry);
    expect(parsed.kind).toBe("finding");
  });

  it("infers 'request' for ID with non-F/T prefix under the fallback heuristic", () => {
    const content = "---\nid: R123\ntitle: Request\nstatus: pending\ncreated_at: now\n---\n\nBody\n";
    const parsed = parseWorkItemContent(content, "R123.md");
    expect(parsed.kind).toBe("request");
  });
});

// ── Path heuristic (context-filter fallback) ─────────────────────────

describe("derivePathFromBody", () => {
  it("returns undefined when body is empty or has no Affected Files section", () => {
    expect(derivePathFromBody("")).toBeUndefined();
    expect(derivePathFromBody("just plain body text, no headings")).toBeUndefined();
    expect(derivePathFromBody("## Problem\nsome problem\n\n## Solution\ndo it")).toBeUndefined();
  });

  // Regression for the 2026-05-20 incident: a frontend-only task whose
  // body's `## Affected Files` listed only `Source/Frontend/...` paths
  // but no frontmatter `path:` was set on the file shipped the full
  // Backend Operator Context block. The derived path must let
  // pathsOverlap reject backend.md (path: "Source/Backend/**") at the
  // prompt-builder layer 3.
  it("extracts Source/Frontend/** glob from a frontend-only Affected Files block (2026-05-20 incident shape)", () => {
    const body = `# Add test coverage for use-delete-modal and use-command hooks

## Problem
Two hooks lack coverage.

## Affected Files
- \`Source/Frontend/src/shared/hooks/modal/use-delete-modal.test.ts\` - Create new test file
- \`Source/Frontend/src/shared/hooks/records/use-command.test.ts\` - Create new test file

## Acceptance Criteria
- [ ] Tests pass`;
    expect(derivePathFromBody(body)).toBe("Source/Frontend/src/shared/hooks/**");
  });

  it("extracts Source/Backend/** from a backend-only Affected Files block", () => {
    const body = `## Affected Files
- \`Source/Backend/Sample/Sample.Application/Commands/Foo.cs\`
- \`Source/Backend/Sample/Sample.Application/Commands/Bar.cs\`
`;
    const result = derivePathFromBody(body);
    expect(result).toMatch(/^Source\/Backend\//);
    expect(result).toMatch(/\/\*\*$/);
  });

  it("returns undefined for mixed backend + frontend so both contexts load", () => {
    const body = `## Affected Files
- \`Source/Backend/Sample/Foo.cs\`
- \`Source/Frontend/src/Bar.tsx\`
`;
    // Common depth = 1 (only `Source`), heuristic requires ≥ 2 — falls back to undefined,
    // which preserves "no path filter" behaviour and loads both contexts.
    expect(derivePathFromBody(body)).toBeUndefined();
  });

  it("returns undefined when Affected Files lists a top-level file", () => {
    const body = `## Affected Files
- \`package.json\`
`;
    expect(derivePathFromBody(body)).toBeUndefined();
  });

  it("returns undefined when Affected Files has no recognisable file paths", () => {
    const body = `## Affected Files
- TBD
- See linked design doc
`;
    expect(derivePathFromBody(body)).toBeUndefined();
  });

  it("accepts plain bullets without backticks", () => {
    const body = `## Affected Files
- Source/Frontend/src/foo.ts
- Source/Frontend/src/bar.ts
`;
    expect(derivePathFromBody(body)).toBe("Source/Frontend/src/**");
  });

  it("respects the next ## heading as the section boundary (does not slurp later sections)", () => {
    const body = `## Affected Files
- \`Source/Frontend/A.ts\`
- \`Source/Frontend/B.ts\`

## References
- \`Source/Backend/Z.cs\`
`;
    // Z.cs must NOT pollute the heuristic — it lives in a different section.
    expect(derivePathFromBody(body)).toBe("Source/Frontend/**");
  });

  it("is case-insensitive on the Affected Files heading", () => {
    const body = `## affected files
- \`Source/Frontend/a.ts\`
- \`Source/Frontend/b.ts\`
`;
    expect(derivePathFromBody(body)).toBe("Source/Frontend/**");
  });

  // Regression for PR #888 — F20260322-0004. Findings use a
  // `**Domain**:` key-value pair instead of `## Affected Files`. The
  // 2026-05-20 path heuristic only recognised the latter, so all 22
  // pending findings shipped both backend and frontend context to the
  // planner agent (~6k extra chars per call).
  it("extracts glob from `**Domain**: <path>` field on a finding body (F20260322-0004 shape)", () => {
    const body = `**Severity**: medium
**Priority**: 4
**Files Affected**: 1

**Pattern**: Interactive shared component missing colocated test file
**Domain**: Source/Frontend/src/shared/components/fields/

**Impact**: DecimalInput handles decimal number parsing.

**Fix**: Create the test file.
`;
    expect(derivePathFromBody(body)).toBe("Source/Frontend/src/shared/components/fields/**");
  });

  it("strips trailing slash on Domain value (`/` and `//` both collapse)", () => {
    expect(derivePathFromBody("**Domain**: Source/Backend/Foo/")).toBe("Source/Backend/Foo/**");
    expect(derivePathFromBody("**Domain**: Source/Backend/Foo//")).toBe("Source/Backend/Foo/**");
  });

  it("returns undefined when Domain value is a single segment (too broad)", () => {
    expect(derivePathFromBody("**Domain**: tools")).toBeUndefined();
    expect(derivePathFromBody("**Domain**: /")).toBeUndefined();
  });

  it("Affected Files heuristic wins over Domain when both are present (more specific)", () => {
    const body = `**Domain**: Source/Frontend

## Affected Files
- \`Source/Frontend/src/foo.ts\`
- \`Source/Frontend/src/bar.ts\`
`;
    expect(derivePathFromBody(body)).toBe("Source/Frontend/src/**");
  });
});

describe("parseWorkItemContent — path frontmatter + heuristic fallback", () => {
  it("uses explicit frontmatter `path:` when present (heuristic does not override)", () => {
    const content = `---
id: T20260520-000999
kind: task
title: "Explicit override"
status: pending
priority: 3
path: "tools/explicit/**"
created_at: "2026-05-20T00:00:00Z"
---

## Affected Files
- \`Source/Frontend/foo.ts\`
- \`Source/Frontend/bar.ts\`
`;
    const parsed = parseWorkItemContent(content, "T20260520-000999.md");
    expect(parsed.path).toBe("tools/explicit/**");
  });

  it("falls back to body heuristic when frontmatter omits `path:` (T20260411-000106 regression)", () => {
    const content = `---
id: T20260411-000106
kind: task
title: "Add test coverage"
status: pending
priority: 3
created_at: "2026-04-12T21:49:49Z"
---

## Affected Files
- \`Source/Frontend/src/shared/hooks/modal/use-delete-modal.test.ts\`
- \`Source/Frontend/src/shared/hooks/records/use-command.test.ts\`
`;
    const parsed = parseWorkItemContent(content, "T20260411-000106.md");
    expect(parsed.path).toBe("Source/Frontend/src/shared/hooks/**");
  });

  it("leaves path undefined when neither frontmatter nor body supply a hint", () => {
    const content = `---
id: T20260520-000888
kind: task
title: "Nothing to derive"
status: pending
priority: 3
created_at: "2026-05-20T00:00:00Z"
---

# Title

Just a plain body without an Affected Files section.
`;
    const parsed = parseWorkItemContent(content, "T20260520-000888.md");
    expect(parsed.path).toBeUndefined();
  });
});

// ── Status updates ───────────────────────────────────────────────────

describe("updateWorkItemFileStatus", () => {
  it("updates status to in-progress and adds started_at (ports task-start.sh)", async () => {
    const path = await createWorkItemFile(tempDir, makeTask());

    await updateWorkItemFileStatus(path, "in-progress", "2026-03-22T11:00:00Z");

    const parsed = await readWorkItemFile(path);
    expect(parsed.status).toBe("in-progress");
    expect(parsed.startedAt).toBe("2026-03-22T11:00:00Z");
  });

  it("updates status to completed and adds completed_at (ports task-complete.sh)", async () => {
    const path = await createWorkItemFile(tempDir, makeTask({ status: "in-progress" }));

    await updateWorkItemFileStatus(path, "completed", "2026-03-22T12:00:00Z");

    const parsed = await readWorkItemFile(path);
    expect(parsed.status).toBe("completed");
    expect(parsed.completedAt).toBe("2026-03-22T12:00:00Z");
  });

  it("updates status to failed and adds failed_at", async () => {
    const path = await createWorkItemFile(tempDir, makeTask({ status: "in-progress" }));

    await updateWorkItemFileStatus(path, "failed", "2026-03-22T12:00:00Z");

    const parsed = await readWorkItemFile(path);
    expect(parsed.status).toBe("failed");
    expect(parsed.failedAt).toBe("2026-03-22T12:00:00Z");
  });

  it("updates status to rejected and adds rejected_at (ports finding-complete.sh)", async () => {
    const path = await createWorkItemFile(tempDir, makeFinding({ status: "in-progress" }));

    await updateWorkItemFileStatus(path, "rejected", "2026-03-22T12:00:00Z");

    const parsed = await readWorkItemFile(path);
    expect(parsed.status).toBe("rejected");
    expect(parsed.rejectedAt).toBe("2026-03-22T12:00:00Z");
  });

  it("duplicate uses completed_at (V1 behavior)", async () => {
    const path = await createWorkItemFile(tempDir, makeFinding({ status: "pending" }));

    await updateWorkItemFileStatus(path, "duplicate", "2026-03-22T12:00:00Z");

    const parsed = await readWorkItemFile(path);
    expect(parsed.status).toBe("duplicate");
    expect(parsed.completedAt).toBe("2026-03-22T12:00:00Z");
  });

  it("updates existing timestamp field", async () => {
    const path = await createWorkItemFile(tempDir, makeTask({
      status: "in-progress",
      startedAt: "2026-03-22T10:00:00Z",
    }));

    await updateWorkItemFileStatus(path, "in-progress", "2026-03-22T11:00:00Z");

    const parsed = await readWorkItemFile(path);
    expect(parsed.startedAt).toBe("2026-03-22T11:00:00Z");
  });

  it("adds auto timestamp when not provided", async () => {
    const path = await createWorkItemFile(tempDir, makeTask());

    await updateWorkItemFileStatus(path, "completed");

    const parsed = await readWorkItemFile(path);
    expect(parsed.status).toBe("completed");
    expect(parsed.completedAt).toBeDefined();
    expect(parsed.completedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("pending status adds no timestamp", async () => {
    const path = await createWorkItemFile(tempDir, makeTask({ status: "in-progress" }));

    await updateWorkItemFileStatus(path, "pending", "2026-03-22T12:00:00Z");

    const parsed = await readWorkItemFile(path);
    expect(parsed.status).toBe("pending");
    // No new timestamp field added for pending
  });
});

// ── DB sync ──────────────────────────────────────────────────────────

function makeStateMock(listImpl?: StateManager["listWorkItems"]): StateManager {
  return {
    upsertWorkItem: vi.fn().mockResolvedValue(undefined),
    deleteWorkItem: vi.fn().mockResolvedValue(undefined),
    getWorkItem: vi.fn(),
    listWorkItems: listImpl ?? vi.fn().mockResolvedValue([]),
    updateWorkItemStatus: vi.fn(),
    appendExecution: vi.fn(),
    listExecutions: vi.fn(),
    saveOutcome: vi.fn(),
    listOutcomes: vi.fn(),
    isScheduleDue: vi.fn(),
    markScheduleRun: vi.fn(),
    isKnownItem: vi.fn(),
    markKnownItem: vi.fn(),
    close: vi.fn(),
  };
}

describe("syncWorkItemToDb", () => {
  it("calls upsertWorkItem on StateManager", async () => {
    const state = makeStateMock();

    const item = makeFinding();
    await syncWorkItemToDb(state, makeCtx(), item);

    expect(state.upsertWorkItem).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        id: "F20260322-0001",
        kind: "finding",
        title: "SQL injection in login",
        status: "pending",
        priority: 3,
        source: "code-analyzer",
      }),
    );
  });
});

// ── Build state context ──────────────────────────────────────────────

describe("buildStateContext", () => {
  function makeState(
    findings: Array<{ id: string; title: string; source?: string; status: string; priority: number }>,
    tasks: Array<{ id: string; title: string; status: string; priority: number; updatedAt?: string }>,
  ): StateManager {
    return makeStateMock(vi.fn().mockImplementation(async (_ctx, filters) => {
      if (filters?.kind === "finding") {
        return findings.map((f) => ({ ...f, kind: "finding", body: "", createdAt: "", updatedAt: "" }));
      }
      if (filters?.kind === "task") {
        return tasks.map((t) => ({ ...t, kind: "task", body: "", createdAt: "", updatedAt: t.updatedAt || "" }));
      }
      return [];
    }));
  }

  it("returns empty context when no items", async () => {
    const vars = await buildStateContext(makeState([], []), makeRegistry(), makeCtx());

    expect(vars.KNOWN_ISSUES).toContain("none");
    expect(vars.PENDING_TASKS).toContain("none");
    expect(vars.RECENTLY_FIXED).toContain("none");
    expect(vars.HISTORICAL_PATTERNS).toContain("Total known findings: 0");
  });

  it("formats known issues from findings", async () => {
    const state = makeState(
      [{ id: "F1", title: "Bug A", source: "scanner", status: "pending", priority: 3 }],
      [],
    );
    const vars = await buildStateContext(state, makeRegistry(), makeCtx());

    expect(vars.KNOWN_ISSUES).toContain("1 known findings");
    expect(vars.KNOWN_ISSUES).toContain("`scanner`");
    expect(vars.KNOWN_ISSUES).toContain("Bug A");
    expect(vars.KNOWN_ISSUES).toContain("priority: 3");
  });

  it("formats pending tasks with in-progress marker", async () => {
    const state = makeState([], [
      { id: "T1", title: "Fix A", status: "in-progress", priority: 2 },
      { id: "T2", title: "Fix B", status: "pending", priority: 5 },
    ]);
    const vars = await buildStateContext(state, makeRegistry(), makeCtx());

    expect(vars.PENDING_TASKS).toContain("2 tasks in queue (1 in-progress)");
    expect(vars.PENDING_TASKS).toContain("**in-progress**");
    expect(vars.PENDING_TASKS).toContain("**T1**");
  });

  it("excludes terminal tasks from pending", async () => {
    const state = makeState([], [
      { id: "T1", title: "Done", status: "completed", priority: 5 },
      { id: "T2", title: "Active", status: "pending", priority: 5 },
    ]);
    const vars = await buildStateContext(state, makeRegistry(), makeCtx());

    expect(vars.PENDING_TASKS).toContain("1 tasks in queue");
    expect(vars.PENDING_TASKS).toContain("**T2**");
    expect(vars.PENDING_TASKS).not.toContain("**T1**");
  });

  it("formats recently fixed (last 10, reverse sorted)", async () => {
    const state = makeState([], [
      { id: "T001", title: "Old", status: "completed", priority: 5, updatedAt: "2026-03-20" },
      { id: "T002", title: "New", status: "completed", priority: 5, updatedAt: "2026-03-22" },
    ]);
    const vars = await buildStateContext(state, makeRegistry(), makeCtx());

    expect(vars.RECENTLY_FIXED).toContain("2 recently completed");
    const t002Pos = vars.RECENTLY_FIXED.indexOf("T002");
    const t001Pos = vars.RECENTLY_FIXED.indexOf("T001");
    expect(t002Pos).toBeLessThan(t001Pos);
  });

  it("limits recently fixed to 10", async () => {
    const tasks = Array.from({ length: 15 }, (_, i) => ({
      id: `T${String(i).padStart(3, "0")}`,
      title: `Task ${i}`,
      status: "completed" as const,
      priority: 5,
    }));
    const state = makeState([], tasks);
    const vars = await buildStateContext(state, makeRegistry(), makeCtx());

    expect(vars.RECENTLY_FIXED).toContain("10 recently completed");
  });

  it("calculates historical patterns", async () => {
    const state = makeState(
      [{ id: "F1", title: "A", source: "s", status: "pending", priority: 1 }],
      [
        { id: "T1", title: "B", status: "in-progress", priority: 2 },
        { id: "T2", title: "C", status: "completed", priority: 3 },
      ],
    );
    const vars = await buildStateContext(state, makeRegistry(), makeCtx());

    expect(vars.HISTORICAL_PATTERNS).toContain("Total known findings: 1");
    expect(vars.HISTORICAL_PATTERNS).toContain("Pending tasks: 1 (1 in-progress)");
    expect(vars.HISTORICAL_PATTERNS).toContain("Recently completed: 1");
  });

  it("uses id when source is missing for findings", async () => {
    const state = makeState(
      [{ id: "F1", title: "No source", status: "pending", priority: 5 }],
      [],
    );
    const vars = await buildStateContext(state, makeRegistry(), makeCtx());

    expect(vars.KNOWN_ISSUES).toContain("`F1`");
  });

  it("excludes terminal and over-age findings from KNOWN_ISSUES (dedup-saturation regression)", async () => {
    // Regression: buildStateContext used to inject EVERY finding of every
    // status with no recency cap, so after ~90 findings the analyst's dedup
    // list saturated and it reported "0 findings" for ~6 weeks. The window
    // now admits only NON-TERMINAL findings created within DEDUP_WINDOW_DAYS.
    const now = Date.parse("2026-06-24T00:00:00Z");
    const findings = [
      { id: "F-recent", title: "Recent open", source: "scanner", status: "in-progress", priority: 3, createdAt: "2026-06-20T00:00:00Z" },
      { id: "F-old", title: "Old open", source: "scanner", status: "in-progress", priority: 3, createdAt: "2026-04-01T00:00:00Z" },
      { id: "F-done", title: "Already fixed", source: "scanner", status: "completed", priority: 3, createdAt: "2026-06-23T00:00:00Z" },
    ];
    const state = makeStateMock(vi.fn().mockImplementation(async (_ctx, filters) => {
      if (filters?.kind === "finding") {
        return findings.map((f) => ({ ...f, kind: "finding", body: "", updatedAt: "" }));
      }
      return [];
    }));

    const vars = await buildStateContext(state, makeRegistry(), makeCtx(), { now });

    expect(vars.KNOWN_ISSUES).toContain("Recent open");
    expect(vars.KNOWN_ISSUES).not.toContain("Old open");      // aged out (>30d)
    expect(vars.KNOWN_ISSUES).not.toContain("Already fixed");  // terminal
    expect(vars.KNOWN_ISSUES).toContain("1 known findings");
    // HISTORICAL_PATTERNS keeps the FULL count — it is a stat, not a suppression list.
    expect(vars.HISTORICAL_PATTERNS).toContain("Total known findings: 3");
  });
});

// ── updateWorkItemFileStatus upsert fallback ─────────────────────────

describe("updateWorkItemFileStatus — upsert without anchors", () => {
  it("inserts timestamp when no anchor field exists in frontmatter", async () => {
    const content = "---\nid: T1\ntitle: Test\n---\n\nBody\n";
    const path = join(tempDir, "T-min.md");
    await writeFile(path, content, "utf-8");

    await updateWorkItemFileStatus(path, "completed", "2026-03-22T12:00:00Z");

    const updated = await readFile(path, "utf-8");
    expect(updated).toContain("completed_at:");
  });
});

// ── Sync all files to state ─────────────────────────────────────────

describe("syncFilesToState", () => {
  it("upserts every {idPrefix}.md file and returns per-kind counts", async () => {
    const { mkdir } = await import("node:fs/promises");
    const dataDir = join(tempDir, "data");
    await mkdir(join(dataDir, "findings"), { recursive: true });
    await mkdir(join(dataDir, "tasks"), { recursive: true });

    await createWorkItemFile(join(dataDir, "findings"), makeFinding({ id: "F20260322-0001" }));
    await createWorkItemFile(join(dataDir, "findings"), makeFinding({ id: "F20260322-0002" }));
    await createWorkItemFile(join(dataDir, "tasks"), makeTask({ id: "T20260322-000101" }));
    // Should be ignored (wrong prefix / extension).
    await writeFile(join(dataDir, "findings", "README.md"), "docs");
    await writeFile(join(dataDir, "tasks", "T20260322-000102.txt"), "ignored");

    const state = makeStateMock();

    const result = await syncFilesToState(makeRegistry(), dataDir, state, makeCtx());
    expect(result).toEqual({ finding: 2, task: 1, request: 0 });
    expect(state.upsertWorkItem).toHaveBeenCalledTimes(3);
  });

  // Regression: 2026-05-20 double-prefix bug. After d16d88b changed
  // `kindDef.dataDir` from `tasks` to `.operator/data/tasks` (full
  // workspace-relative path), the entry.ts caller still passed
  // `{workspacePath}/.operator/data` as the second argument, and the
  // function then did `join(workspaceDataDir, kindDef.dataDir)` →
  // `{wp}/.operator/data/.operator/data/tasks`, which doesn't exist, so
  // sync reported 0 files even when develop had 169 tasks + 97 findings.
  // The fix realigned the caller contract so the second argument is the
  // workspace ROOT and `kindDef.dataDir` carries the prefix. This test
  // pins that contract: production-style prefixed dataDir + workspace
  // root MUST find the files at `{workspacePath}/.operator/data/{kind}`.
  it("finds files when registry dataDir carries the prod `.operator/data/{kind}` prefix", async () => {
    const { mkdir } = await import("node:fs/promises");
    const workspacePath = join(tempDir, "prefixed-ws");
    const findingsDir = join(workspacePath, ".operator", "data", "findings");
    const tasksDir = join(workspacePath, ".operator", "data", "tasks");
    await mkdir(findingsDir, { recursive: true });
    await mkdir(tasksDir, { recursive: true });

    await createWorkItemFile(findingsDir, makeFinding({ id: "F20260520-0001" }));
    await createWorkItemFile(findingsDir, makeFinding({ id: "F20260520-0002" }));
    await createWorkItemFile(tasksDir, makeTask({ id: "T20260520-000101" }));
    await createWorkItemFile(tasksDir, makeTask({ id: "T20260520-000102" }));

    // Production-style registry: dataDir carries the full `.operator/data/{kind}` prefix.
    const prodRegistry: KindRegistry = {
      ...makeRegistry(),
      all: [
        { name: "finding", label: "Finding", idPrefix: "F", dataDir: ".operator/data/findings",
          branchPrefix: "ai/findings", prPrefix: "[AI:Finding]",
          terminalStatuses: ["completed", "failed", "rejected", "duplicate"] },
        { name: "task", label: "Task", idPrefix: "T", dataDir: ".operator/data/tasks",
          branchPrefix: "ai/tasks", prPrefix: "[AI:Task]",
          terminalStatuses: ["completed", "failed", "rejected", "duplicate", "cancelled"] },
        { name: "request", label: "Request", idPrefix: "R", dataDir: ".operator/data/requests",
          branchPrefix: "ai/requests", prPrefix: "[AI:Request]",
          terminalStatuses: ["completed", "rejected"] },
      ],
      dataDirFor: (kind) => {
        if (kind === "finding") return ".operator/data/findings";
        if (kind === "task") return ".operator/data/tasks";
        if (kind === "request") return ".operator/data/requests";
        return "";
      },
    };

    const state = makeStateMock();
    const result = await syncFilesToState(prodRegistry, workspacePath, state, makeCtx());
    expect(result).toEqual({ finding: 2, task: 2, request: 0 });
    expect(state.upsertWorkItem).toHaveBeenCalledTimes(4);
  });

  it("skips unreadable files without throwing", async () => {
    const { mkdir } = await import("node:fs/promises");
    const dataDir = join(tempDir, "data2");
    await mkdir(join(dataDir, "findings"), { recursive: true });
    await mkdir(join(dataDir, "tasks"), { recursive: true });
    await writeFile(join(dataDir, "findings", "F-bad.md"), "no frontmatter");
    await writeFile(join(dataDir, "tasks", "T-bad.md"), "no frontmatter");

    const state = makeStateMock();
    const result = await syncFilesToState(makeRegistry(), dataDir, state, makeCtx());
    expect(result).toEqual({ finding: 0, task: 0, request: 0 });
    expect(state.upsertWorkItem).not.toHaveBeenCalled();
  });

  it("evicts orphan rows whose develop file has disappeared (T20260416-000102 regression)", async () => {
    // Pre-state: DB has three task rows (101 still on develop, 102 +
    // 104 are phantoms whose feature branches never merged so their
    // files are not on develop). After sync, 102 + 104 must be
    // deleted; 101 stays.
    const { mkdir } = await import("node:fs/promises");
    const dataDir = join(tempDir, "data-evict");
    await mkdir(join(dataDir, "tasks"), { recursive: true });
    await mkdir(join(dataDir, "findings"), { recursive: true });
    await createWorkItemFile(join(dataDir, "tasks"), makeTask({ id: "T20260416-000101" }));

    const dbItems: WorkItem[] = [
      makeTask({ id: "T20260416-000101" }),
      makeTask({ id: "T20260416-000102" }),
      makeTask({ id: "T20260416-000104" }),
    ];
    const state = makeStateMock(
      vi.fn().mockImplementation(async (_ctx, filters: { kind?: string }) => {
        if (filters?.kind === "task") return dbItems;
        return [];
      }),
    );
    await syncFilesToState(makeRegistry(), dataDir, state, makeCtx());
    expect(state.deleteWorkItem).toHaveBeenCalledTimes(2);
    expect(state.deleteWorkItem).toHaveBeenCalledWith(expect.anything(), "T20260416-000102");
    expect(state.deleteWorkItem).toHaveBeenCalledWith(expect.anything(), "T20260416-000104");
    expect(state.deleteWorkItem).not.toHaveBeenCalledWith(expect.anything(), "T20260416-000101");
  });

  it("does NOT evict an id whose file is present but unreadable (transient parse error keeps the row)", async () => {
    const { mkdir } = await import("node:fs/promises");
    const dataDir = join(tempDir, "data-transient");
    await mkdir(join(dataDir, "tasks"), { recursive: true });
    // File exists in directory listing but has no parseable frontmatter
    await writeFile(join(dataDir, "tasks", "T20260416-000101.md"), "garbage no frontmatter");
    const dbItems: WorkItem[] = [makeTask({ id: "T20260416-000101" })];
    const state = makeStateMock(
      vi.fn().mockImplementation(async (_ctx, filters: { kind?: string }) => {
        if (filters?.kind === "task") return dbItems;
        return [];
      }),
    );
    await syncFilesToState(makeRegistry(), dataDir, state, makeCtx());
    expect(state.deleteWorkItem).not.toHaveBeenCalled();
  });

  it("mirrors reconciled status to SQLite (not raw file literal) when observations are provided — F20260404-0001 PR-on-PR loop regression", async () => {
    // Pre-fix bug: syncWorkItemToDb wrote item.status (raw develop literal,
    // "pending") to SQLite BEFORE reconcileAndWrite computed the authoritative
    // "rejected" from KV's prior executionVerdict source. The selector
    // (deps.state.listWorkItems) read SQLite, saw "pending", re-picked the
    // finding every cycle even though KV correctly held "rejected". Bug
    // observed live on a real repo (recentExecutionIds had 3
    // executions of the same finding-plan run on the same rejected finding).
    //
    // Fix: reconcileAndWrite runs first and returns the computed status;
    // syncWorkItemToDb mirrors that to SQLite. Both stores agree.
    const { mkdir } = await import("node:fs/promises");
    const workspacePath = join(tempDir, "ws");
    const dataDir = join(workspacePath, ".operator", "data");
    await mkdir(join(dataDir, "findings"), { recursive: true });
    // Develop branch file shows status=pending (stale because rejection PR
    // hasn't been merged — feature branch carries the real `rejected` but
    // develop is behind).
    await createWorkItemFile(
      join(dataDir, "findings"),
      makeFinding({ id: "F20260404-0001", status: "pending" }),
    );

    // KV has prior row with status=rejected from a previous execution's
    // verdict — the executionVerdict source is what should make the
    // reconciler return "rejected" again.
    const priorKvRow = {
      id: "F20260404-0001",
      kind: "finding",
      title: "Test",
      status: "rejected" as const,
      statusReason: "execution-verdict",
      priority: 3,
      statusSources: {
        executionVerdict: {
          value: "rejected" as const,
          observedAt: "2026-05-13T08:24:20.588Z",
          executionId: "prior-exec",
          stageName: "finding-plan",
        },
      },
      hasDrift: false,
    };
    const kv = {
      get: vi.fn().mockImplementation(async (cat: string, key: string) => {
        if (cat === "work-items" && key === "F20260404-0001") {
          return { key, value: priorKvRow, updatedAt: "2026-05-13T08:24:20.588Z" };
        }
        return null;
      }),
      put: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined),
      list: vi.fn().mockResolvedValue([]),
    };

    const state = makeStateMock();
    const observations = {
      kv: kv as unknown as import("@operator/core").KVStore,
      git: { headSha: vi.fn().mockResolvedValue("aaeca53") },
      prManager: { findOpenPR: vi.fn().mockResolvedValue(null) },
      vcs: undefined,
      workspacePath,
      branchPrefixFor: (kind: string) => kind === "finding" ? "ai/findings" : "ai/tasks",
    };

    // makeRegistry() doesn't ship terminalStatusesFor — reconcileAndWrite
    // needs it. Extend in-place so the kind-aware terminal set reaches
    // reconcileEffectiveStatus correctly.
    const registry = {
      ...makeRegistry(),
      terminalStatusesFor: (kind: string) => new Set(
        kind === "finding" ? ["completed", "failed", "rejected", "duplicate", "merged"]
        : kind === "task" ? ["completed", "failed", "rejected", "duplicate", "cancelled", "merged"]
        : ["completed", "rejected"],
      ),
    } as unknown as KindRegistry;
    await syncFilesToState(registry, dataDir, state, makeCtx(), observations);

    // The critical assertion: SQLite upsert receives status=rejected
    // (reconciled), NOT status=pending (raw develop file literal).
    expect(state.upsertWorkItem).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        id: "F20260404-0001",
        status: "rejected",
      }),
    );
    // KV also receives the reconciled status (regression guard for the
    // pre-existing kv:work-items write path).
    expect(kv.put).toHaveBeenCalledWith(
      "work-items",
      "F20260404-0001",
      expect.objectContaining({ status: "rejected" }),
    );
  });
});

describe("updateStatusAndSync", () => {
  it("updates file status and writes the fresh row into state", async () => {
    const path = await createWorkItemFile(tempDir, makeTask({ status: "pending" }));
    const state = makeStateMock();
    const res = await updateStatusAndSync(path, "completed", state, makeCtx());
    expect(res.status).toBe("completed");
    expect(state.upsertWorkItem).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ id: "T20260322-000101", status: "completed" }),
    );
  });
});

// ── Derived `completed` aggregation (post-sync pass) ────────────────

describe("aggregateDerivedCompletions", () => {
  /**
   * Registry variant where `task.parentKinds = ["finding"]` AND finding's
   * terminalStatuses include `completed`. The base `makeRegistry()` stub
   * omits both (it predates the 2026-05-20 derivation feature). Local to
   * this describe so the broader test surface stays untouched.
   */
  function makeRegistryWithParentLinks(): KindRegistry {
    const entries = [
      { name: "finding", label: "Finding", idPrefix: "F", dataDir: "findings",
        branchPrefix: "ai/findings", prPrefix: "[AI:Finding]",
        terminalStatuses: ["merged", "completed", "failed", "rejected", "duplicate"],
        parentKinds: [] },
      { name: "task", label: "Task", idPrefix: "T", dataDir: "tasks",
        branchPrefix: "ai/tasks", prPrefix: "[AI:Task]",
        terminalStatuses: ["merged", "failed", "rejected", "duplicate", "cancelled"],
        parentKinds: ["finding"] },
    ] as const;
    return {
      all: entries,
      get: (kind) => entries.find((e) => e.name === kind),
      isTerminal: (kind, status) => entries.find((e) => e.name === kind)?.terminalStatuses.includes(status) ?? false,
      labelFor: (kind) => entries.find((e) => e.name === kind)?.label ?? "Unknown",
      branchPrefixFor: (kind) => entries.find((e) => e.name === kind)?.branchPrefix ?? "",
      dataDirFor: (kind) => entries.find((e) => e.name === kind)?.dataDir ?? "",
      generateId: async (kind, date) => {
        const def = entries.find((e) => e.name === kind);
        if (!def) throw new Error(`unknown kind: ${kind}`);
        return `${def.idPrefix}${date ?? "20260520"}-0001`;
      },
    };
  }

  /**
   * Build a fixture: KV preloaded with a parent record, state mock that
   * answers `listWorkItems({ kind: 'finding', status: ['merged'] })`,
   * and a `childrenByParent` map composed from the supplied children.
   */
  function fixture(opts: {
    parent: { id: string; status: WorkItemStatus };
    children: { id: string; kind: WorkItemKind; status: WorkItemStatus }[];
  }) {
    const kvStore = new Map<string, Record<string, unknown>>();
    kvStore.set(`work-items/${opts.parent.id}`, {
      id: opts.parent.id, kind: "finding", status: opts.parent.status,
    });
    const kv = {
      get: vi.fn().mockImplementation(async (cat: string, key: string) => {
        const v = kvStore.get(`${cat}/${key}`);
        return v ? { key, value: v } : null;
      }),
      put: vi.fn().mockImplementation(async (cat: string, key: string, value: Record<string, unknown>) => {
        kvStore.set(`${cat}/${key}`, value);
      }),
      delete: vi.fn().mockImplementation(async () => {}),
      list: vi.fn().mockResolvedValue([]),
    } as unknown as KVStore;

    const state = makeStateMock(
      vi.fn().mockImplementation(async (_ctx, filter: { kind?: string; status?: WorkItemStatus[] }) => {
        if (filter?.kind === "finding"
            && filter.status?.includes("merged")
            && opts.parent.status === "merged") {
          return [{ id: opts.parent.id, kind: "finding", status: "merged" } as WorkItem];
        }
        return [];
      }),
    );

    const childrenByParent = new Map<string, { kind: WorkItemKind; status: WorkItemStatus }[]>();
    if (opts.children.length > 0) {
      childrenByParent.set(opts.parent.id, opts.children.map((c) => ({ kind: c.kind, status: c.status })));
    }

    return { kv, kvStore, state, childrenByParent };
  }

  it("promotes a merged parent to `completed` when every child is terminal", async () => {
    const f = fixture({
      parent: { id: "F20260520-0001", status: "merged" },
      children: [
        { id: "T20260520-000101", kind: "task", status: "merged" },
        { id: "T20260520-000102", kind: "task", status: "merged" },
      ],
    });
    await aggregateDerivedCompletions(
      makeRegistryWithParentLinks(), f.state, makeCtx(), { kv: f.kv }, f.childrenByParent,
    );
    expect(f.state.updateWorkItemStatus).toHaveBeenCalledWith(
      expect.anything(), "F20260520-0001", "completed",
    );
    expect(f.kvStore.get("work-items/F20260520-0001")).toMatchObject({ status: "completed" });
  });

  it("leaves the parent alone when at least one child is still in-flight", async () => {
    const f = fixture({
      parent: { id: "F20260520-0010", status: "merged" },
      children: [
        { id: "T20260520-000201", kind: "task", status: "merged" },
        { id: "T20260520-000202", kind: "task", status: "pending" },
      ],
    });
    await aggregateDerivedCompletions(
      makeRegistryWithParentLinks(), f.state, makeCtx(), { kv: f.kv }, f.childrenByParent,
    );
    expect(f.state.updateWorkItemStatus).not.toHaveBeenCalled();
  });

  it("leaves the parent alone when it has no children at all (no derivation when nothing to roll up)", async () => {
    const f = fixture({
      parent: { id: "F20260520-0020", status: "merged" },
      children: [],
    });
    await aggregateDerivedCompletions(
      makeRegistryWithParentLinks(), f.state, makeCtx(), { kv: f.kv }, f.childrenByParent,
    );
    expect(f.state.updateWorkItemStatus).not.toHaveBeenCalled();
  });

  it("does NOT promote a parent that is not in `merged` (pending stays pending)", async () => {
    const f = fixture({
      parent: { id: "F20260520-0030", status: "pending" },
      children: [{ id: "T20260520-000301", kind: "task", status: "merged" }],
    });
    await aggregateDerivedCompletions(
      makeRegistryWithParentLinks(), f.state, makeCtx(), { kv: f.kv }, f.childrenByParent,
    );
    expect(f.state.updateWorkItemStatus).not.toHaveBeenCalled();
  });

  it("counts a rejected child as terminal — parent promoted even when children failed", async () => {
    // Rejected/failed children are terminal per the kind registry. Once
    // every spawned task has stopped (whatever outcome), the finding's
    // "do I still have outstanding work" answer is no.
    const f = fixture({
      parent: { id: "F20260520-0040", status: "merged" },
      children: [
        { id: "T20260520-000401", kind: "task", status: "merged" },
        { id: "T20260520-000402", kind: "task", status: "rejected" },
      ],
    });
    await aggregateDerivedCompletions(
      makeRegistryWithParentLinks(), f.state, makeCtx(), { kv: f.kv }, f.childrenByParent,
    );
    expect(f.state.updateWorkItemStatus).toHaveBeenCalledWith(
      expect.anything(), "F20260520-0040", "completed",
    );
  });

  it("no-op when registry has no parent-having kinds (short-circuit)", async () => {
    const f = fixture({
      parent: { id: "F20260520-0050", status: "merged" },
      children: [{ id: "T20260520-000501", kind: "task", status: "merged" }],
    });
    await aggregateDerivedCompletions(
      makeRegistry(), f.state, makeCtx(), { kv: f.kv }, f.childrenByParent,
    );
    expect(f.state.updateWorkItemStatus).not.toHaveBeenCalled();
  });

  it("is idempotent — second invocation does not rewrite KV when already `completed`", async () => {
    const f = fixture({
      parent: { id: "F20260520-0060", status: "merged" },
      children: [{ id: "T20260520-000601", kind: "task", status: "merged" }],
    });
    await aggregateDerivedCompletions(
      makeRegistryWithParentLinks(), f.state, makeCtx(), { kv: f.kv }, f.childrenByParent,
    );
    // Simulate post-promotion state: KV now carries `completed`. The
    // SQLite listWorkItems({status: ['merged']}) candidate filter
    // returns nothing on the next pass — that's what makes the rule
    // idempotent. Reset the spy and re-run; nothing should fire.
    f.kvStore.set("work-items/F20260520-0060", { id: "F20260520-0060", kind: "finding", status: "completed" });
    vi.mocked(f.state.listWorkItems).mockResolvedValue([]); // no more "merged" candidates
    vi.mocked(f.state.updateWorkItemStatus).mockClear();
    vi.mocked(f.kv.put).mockClear();
    await aggregateDerivedCompletions(
      makeRegistryWithParentLinks(), f.state, makeCtx(), { kv: f.kv }, f.childrenByParent,
    );
    expect(f.state.updateWorkItemStatus).not.toHaveBeenCalled();
    expect(f.kv.put).not.toHaveBeenCalled();
  });
});

// ── Retrospective-oriented helpers (Step 12) ────────────────────────

describe("listPendingItems", () => {
  it("returns pending + reopened findings, skips terminal", async () => {
    const { mkdir } = await import("node:fs/promises");
    const findingsDir = join(tempDir, "findings");
    await mkdir(findingsDir, { recursive: true });
    await createWorkItemFile(findingsDir, makeFinding({ id: "F1", status: "pending" }));
    await createWorkItemFile(findingsDir, makeFinding({ id: "F2", status: "completed" }));
    await createWorkItemFile(findingsDir, makeFinding({ id: "F3", status: "reopened" }));

    const pending = await listPendingItems(makeRegistry(), "finding", tempDir);
    const ids = pending.map((f) => f.id).sort();
    expect(ids).toEqual(["F1", "F3"]);
  });

  it("returns empty list for unknown kind", async () => {
    expect(await listPendingItems(makeRegistry(), "bogus", tempDir)).toEqual([]);
  });

  it("returns empty list for missing directory", async () => {
    expect(await listPendingItems(makeRegistry(), "finding", join(tempDir, "missing"))).toEqual([]);
  });

  it("skips unreadable files", async () => {
    const { mkdir } = await import("node:fs/promises");
    const findingsDir = join(tempDir, "findings");
    await mkdir(findingsDir, { recursive: true });
    await writeFile(join(findingsDir, "F-bad.md"), "not valid frontmatter");
    expect(await listPendingItems(makeRegistry(), "finding", tempDir)).toEqual([]);
  });

  it("ignores files without matching idPrefix", async () => {
    const { mkdir } = await import("node:fs/promises");
    const findingsDir = join(tempDir, "findings");
    await mkdir(findingsDir, { recursive: true });
    await writeFile(join(findingsDir, "README.md"), "# docs");
    expect(await listPendingItems(makeRegistry(), "finding", tempDir)).toEqual([]);
  });
});

describe("summarizeTasks", () => {
  it("partitions tasks into completed / failed / pending", async () => {
    const { mkdir } = await import("node:fs/promises");
    const tasksDir = join(tempDir, "tasks");
    await mkdir(tasksDir, { recursive: true });
    await createWorkItemFile(tasksDir, makeTask({ id: "T20260322-000101", status: "completed" }));
    await createWorkItemFile(tasksDir, makeTask({ id: "T20260322-000102", status: "duplicate" }));
    await createWorkItemFile(tasksDir, makeTask({ id: "T20260322-000103", status: "failed" }));
    await createWorkItemFile(tasksDir, makeTask({ id: "T20260322-000104", status: "rejected" }));
    await createWorkItemFile(tasksDir, makeTask({ id: "T20260322-000105", status: "pending" }));

    const res = await summarizeTasks(makeRegistry(), tempDir);
    expect(res.completed.map((t) => t.id).sort()).toEqual(["T20260322-000101", "T20260322-000102"]);
    expect(res.failed.map((t) => t.id).sort()).toEqual(["T20260322-000103", "T20260322-000104"]);
    expect(res.pending.map((t) => t.id)).toEqual(["T20260322-000105"]);
  });

  it("returns empty buckets when the registry has no 'task' kind", async () => {
    const noTaskRegistry: KindRegistry = {
      ...makeRegistry(),
      get: (k) => (k === "task" ? undefined : makeRegistry().get(k)),
    };
    const res = await summarizeTasks(noTaskRegistry, tempDir);
    expect(res).toEqual({ completed: [], failed: [], pending: [] });
  });

  it("returns empty buckets for missing directory", async () => {
    const res = await summarizeTasks(makeRegistry(), join(tempDir, "missing"));
    expect(res).toEqual({ completed: [], failed: [], pending: [] });
  });

  it("skips unreadable task files", async () => {
    const { mkdir } = await import("node:fs/promises");
    const tasksDir = join(tempDir, "tasks");
    await mkdir(tasksDir, { recursive: true });
    await writeFile(join(tasksDir, "T-bad.md"), "not valid");
    const res = await summarizeTasks(makeRegistry(), tempDir);
    expect(res.pending).toEqual([]);
  });

  it("ignores non-T prefix and non-md files", async () => {
    const { mkdir } = await import("node:fs/promises");
    const tasksDir = join(tempDir, "tasks");
    await mkdir(tasksDir, { recursive: true });
    await writeFile(join(tasksDir, "notes.txt"), "ignore");
    await writeFile(join(tasksDir, "README.md"), "# docs");
    const res = await summarizeTasks(makeRegistry(), tempDir);
    expect(res.completed).toEqual([]);
    expect(res.failed).toEqual([]);
    expect(res.pending).toEqual([]);
  });
});

describe("collectMergedPRFeedback", () => {
  const MARKER = "<!-- bot:operator -->";

  function makeVCS(closedPRs: CodeReview[] = []): Pick<VCSPlatform, "getCodeReviews" | "getComments" | "getReviewComments"> {
    return {
      getCodeReviews: vi.fn().mockImplementation((opts?: { state?: string }) => {
        if (opts?.state === "closed") return Promise.resolve(closedPRs);
        return Promise.resolve([]);
      }),
      getComments: vi.fn().mockResolvedValue([]),
      getReviewComments: vi.fn().mockResolvedValue([]),
    } as unknown as Pick<VCSPlatform, "getCodeReviews" | "getComments" | "getReviewComments">;
  }

  it("collects feedback from merged AI PRs", async () => {
    const vcs = makeVCS([
      { id: 10, title: "Fix auth", url: "", branch: "ai/tasks/T1", baseBranch: "main", draft: false, labels: [], comments: [], merged: true, closed: true },
      { id: 11, title: "Non-AI PR", url: "", branch: "feature/x", baseBranch: "main", draft: false, labels: [], comments: [], merged: true, closed: true },
    ]);
    (vcs.getComments as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: "1", author: "user1", body: "Nice work!", createdAt: "2026-04-01T10:00:00Z" },
      { id: "2", author: "bot", body: `${MARKER} done`, createdAt: "2026-04-01T11:00:00Z" },
    ]);
    (vcs.getReviewComments as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: "3", author: "reviewer", body: "Consider bcrypt", createdAt: "2026-04-01T12:00:00Z", path: "src/auth.ts" },
    ]);

    const result = await collectMergedPRFeedback(vcs, MARKER);
    expect(result).toContain("PR #10: Fix auth");
    expect(result).toContain("@user1: Nice work!");
    expect(result).not.toContain("bot:operator");
    expect(result).toContain("src/auth.ts: Consider bcrypt");
    expect(result).not.toContain("Non-AI PR");
  });

  it("returns fallback when no merged AI PRs", async () => {
    const vcs = makeVCS([]);
    expect(await collectMergedPRFeedback(vcs, MARKER)).toContain("No merged AI PRs");
  });

  it("handles API error gracefully", async () => {
    const vcs = makeVCS();
    (vcs.getCodeReviews as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("down"));
    expect(await collectMergedPRFeedback(vcs, MARKER)).toContain("No merged AI PRs");
  });

  it("defaults reviewComments path to 'unknown' when missing", async () => {
    const vcs = makeVCS([
      { id: 20, title: "t", url: "", branch: "ai/x", baseBranch: "m", draft: false, labels: [], comments: [], merged: true, closed: true },
    ]);
    (vcs.getReviewComments as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: "1", author: "r", body: "oops", createdAt: "" },
    ]);
    const result = await collectMergedPRFeedback(vcs, MARKER);
    expect(result).toContain("unknown: oops");
  });
});

describe("collectRejectedPRFeedback", () => {
  const MARKER = "<!-- bot:operator -->";

  function makeVCS(closedPRs: CodeReview[] = []): Pick<VCSPlatform, "getCodeReviews" | "getComments" | "getReviewComments"> {
    return {
      getCodeReviews: vi.fn().mockImplementation((opts?: { state?: string }) => {
        if (opts?.state === "closed") return Promise.resolve(closedPRs);
        return Promise.resolve([]);
      }),
      getComments: vi.fn().mockResolvedValue([]),
      getReviewComments: vi.fn().mockResolvedValue([]),
    } as unknown as Pick<VCSPlatform, "getCodeReviews" | "getComments" | "getReviewComments">;
  }

  it("collects feedback from rejected AI PRs", async () => {
    const vcs = makeVCS([
      { id: 20, title: "Bad fix", url: "", branch: "ai/tasks/T2", baseBranch: "main", draft: false, labels: [], comments: [], merged: false, closed: true },
    ]);
    (vcs.getComments as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: "1", author: "user1", body: "This breaks tests", createdAt: "2026-04-01T10:00:00Z" },
    ]);

    const result = await collectRejectedPRFeedback(vcs, MARKER);
    expect(result).toContain("PR #20 (REJECTED): Bad fix");
    expect(result).toContain("@user1: This breaks tests");
  });

  it("returns fallback when no rejected PRs", async () => {
    const vcs = makeVCS([
      { id: 10, title: "Good", url: "", branch: "ai/tasks/T1", baseBranch: "main", draft: false, labels: [], comments: [], merged: true, closed: true },
    ]);
    expect(await collectRejectedPRFeedback(vcs, MARKER)).toContain("No rejected AI PRs");
  });

  it("handles API error gracefully", async () => {
    const vcs = makeVCS();
    (vcs.getCodeReviews as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("down"));
    expect(await collectRejectedPRFeedback(vcs, MARKER)).toContain("No rejected AI PRs");
  });
});
