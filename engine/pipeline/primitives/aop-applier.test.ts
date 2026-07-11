import { describe, it, expect, beforeEach, vi } from "vitest";
import type {
  AgentEventStream,
  AgentEventParseResult,
  KindDefinition,
  KindRegistry,
  OperationContext,
  WorkItemKind,
  WorkItemRecord,
  WorkItemRef,
  WorkItemSource,
  WorkItemStatus,
  BodyMergeStrategy,
  WorkItemListFilter,
} from "@operator/core";
import type { Logger } from "../../logging/logger.js";
import { applyAgentEvents } from "./aop-applier.js";

const KINDS: KindDefinition[] = [
  {
    name: "finding",
    label: "Finding",
    idPrefix: "F",
    dataDir: ".operator/data/findings",
    branchPrefix: "ai/findings",
    prPrefix: "[AI:Finding]",
    terminalStatuses: ["completed", "failed", "rejected", "duplicate", "merged"],
  },
  {
    name: "task",
    label: "Task",
    idPrefix: "T",
    dataDir: ".operator/data/tasks",
    branchPrefix: "ai/tasks",
    prPrefix: "[AI:Task]",
    terminalStatuses: ["completed", "failed", "rejected", "duplicate", "merged"],
  },
];

class FakeRegistry implements KindRegistry {
  private nextSeq = 0;
  readonly all = KINDS;
  get(kind: WorkItemKind): KindDefinition | undefined { return KINDS.find((k) => k.name === kind); }
  isTerminal(kind: WorkItemKind, status: WorkItemStatus): boolean {
    return (this.get(kind)?.terminalStatuses ?? []).includes(status);
  }
  async generateId(kind: WorkItemKind, date?: string): Promise<string> {
    this.nextSeq++;
    const d = date ?? "20260508";
    return `${this.get(kind)!.idPrefix}${d}-${String(this.nextSeq).padStart(4, "0")}`;
  }
  labelFor(kind: WorkItemKind): string { return this.get(kind)!.label; }
  branchPrefixFor(kind: WorkItemKind): string { return this.get(kind)!.branchPrefix; }
  dataDirFor(kind: WorkItemKind): string { return this.get(kind)!.dataDir; }
  parentKindsFor(): readonly WorkItemKind[] { return []; }
  terminalStatusesFor(kind: WorkItemKind): ReadonlySet<WorkItemStatus> {
    return new Set(this.get(kind)?.terminalStatuses ?? []);
  }
}

class FakeSource implements WorkItemSource {
  readonly created: WorkItemRecord[] = [];
  readonly statusUpdates: Array<{ ref: WorkItemRef; status: WorkItemStatus; reason?: string }> = [];
  readonly bodyUpdates: Array<{ ref: WorkItemRef; body: string; mergeStrategy: BodyMergeStrategy }> = [];
  readonly store = new Map<string, WorkItemRecord>();
  failNextCreate = false;
  failNextStatusUpdate = false;

  async create(item: WorkItemRecord, _ctx: OperationContext): Promise<WorkItemRecord> {
    if (this.failNextCreate) {
      this.failNextCreate = false;
      throw new Error("fake create boom");
    }
    this.created.push(item);
    this.store.set(item.id, item);
    return item;
  }
  async read(ref: WorkItemRef, _ctx: OperationContext): Promise<WorkItemRecord | null> {
    return this.store.get(ref.id) ?? null;
  }
  async updateStatus(ref: WorkItemRef, status: WorkItemStatus, reason: string | undefined, _ctx: OperationContext): Promise<WorkItemRecord> {
    if (this.failNextStatusUpdate) {
      this.failNextStatusUpdate = false;
      throw Object.assign(new Error("fake updateStatus boom"), { code: "WI_NOT_FOUND" });
    }
    this.statusUpdates.push({ ref, status, reason });
    const prior = this.store.get(ref.id);
    const next: WorkItemRecord = prior
      ? { ...prior, status }
      : { id: ref.id, kind: ref.kind, title: "", body: "", status, priority: 5, createdAt: "ts" };
    this.store.set(ref.id, next);
    return next;
  }
  async updateBody(ref: WorkItemRef, body: string, mergeStrategy: BodyMergeStrategy, _sectionHeader: string | undefined, _ctx: OperationContext): Promise<WorkItemRecord> {
    this.bodyUpdates.push({ ref, body, mergeStrategy });
    const prior = this.store.get(ref.id);
    const next: WorkItemRecord = prior
      ? { ...prior, body }
      : { id: ref.id, kind: ref.kind, title: "", body, status: "pending", priority: 5, createdAt: "ts" };
    this.store.set(ref.id, next);
    return next;
  }
  async list(filter: WorkItemListFilter, _ctx: OperationContext): Promise<readonly WorkItemRecord[]> {
    return [...this.store.values()].filter((r) => r.kind === filter.kind);
  }
}

function fakeStream(result: AgentEventParseResult): AgentEventStream {
  return { parse: () => result };
}

function makeCtx(): OperationContext {
  return {
    traceId: "t", repoId: "r", action: "test",
    budget: { spentUsd: 0, add: () => {}, isExceeded: () => false },
    signal: AbortSignal.timeout(30_000),
  };
}

function fakeLogger(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(),
  };
}

describe("applyAgentEvents — F4 generic AOP applier", () => {
  let registry: FakeRegistry;
  let source: FakeSource;

  beforeEach(() => {
    registry = new FakeRegistry();
    source = new FakeSource();
  });

  it("applies a child-item event by creating a record on the WorkItemSource", async () => {
    const stream = fakeStream({
      events: [
        { type: "child-item", kind: "task", parent: "self", title: "Add tests", body: "body", priority: 3 },
      ],
      diagnostics: [],
    });

    const result = await applyAgentEvents(
      "raw",
      { stream, source, registry },
      { workItem: { id: "F20260508-0001", kind: "finding" }, date: "20260508" },
      makeCtx(),
    );

    expect(source.created).toHaveLength(1);
    expect(source.created[0]).toMatchObject({
      kind: "task",
      title: "Add tests",
      priority: 3,
      parentId: "F20260508-0001",
      status: "pending",
    });
    expect(source.created[0].id).toMatch(/^T20260508-/);
    expect(result.applied.childItems).toHaveLength(1);
    expect(result.verdict).toBe("approved");
    expect(result.summary).toContain("1 child-item(s)");
  });

  it("creates a top-level (parentless) child-item when parent is omitted — discovery finding (2026-06-27 zero-findings fix)", async () => {
    // Research/discovery has no active work-item; its findings are roots.
    // Before the fix a required `parent` dropped every such finding.
    const stream = fakeStream({
      events: [
        { type: "child-item", kind: "finding", title: "Tenant leak in FileItem create", body: "b", priority: 1, source: "security#F-001" },
      ],
      diagnostics: [],
    });

    const result = await applyAgentEvents(
      "raw",
      { stream, source, registry },
      { date: "20260627" }, // no active work-item (singleton discovery stage)
      makeCtx(),
    );

    expect(source.created).toHaveLength(1);
    expect(source.created[0]).toMatchObject({
      kind: "finding", title: "Tenant leak in FileItem create", priority: 1, status: "pending",
    });
    expect(source.created[0].parentId).toBeUndefined();
    expect(source.created[0].id).toMatch(/^F20260627-/);
    expect(result.applied.childItems).toHaveLength(1);
    expect(result.verdict).toBe("approved");
  });

  it("respects an explicit child-item id and source field", async () => {
    const stream = fakeStream({
      events: [
        {
          type: "child-item", kind: "task", parent: "F20260508-0001",
          title: "x", body: "b", id: "T20260508-9999", source: "planner",
        },
      ],
      diagnostics: [],
    });
    const result = await applyAgentEvents(
      "raw", { stream, source, registry },
      { workItem: { id: "F20260508-0001", kind: "finding" } }, makeCtx(),
    );
    expect(source.created[0].id).toBe("T20260508-9999");
    expect(source.created[0].source).toBe("planner");
    expect(result.verdict).toBe("approved");
  });

  it("applies a status-update event with target=self", async () => {
    const stream = fakeStream({
      events: [
        { type: "status-update", target: "self", status: "in-progress", reason: "child tasks created" },
      ],
      diagnostics: [],
    });
    const result = await applyAgentEvents(
      "raw", { stream, source, registry },
      { workItem: { id: "F20260508-0001", kind: "finding" } }, makeCtx(),
    );
    expect(source.statusUpdates).toHaveLength(1);
    expect(source.statusUpdates[0]).toMatchObject({
      ref: { id: "F20260508-0001", kind: "finding" },
      status: "in-progress",
      reason: "child tasks created",
    });
    expect(result.applied.statusUpdates).toHaveLength(1);
  });

  it("applies a body-update event", async () => {
    const stream = fakeStream({
      events: [
        { type: "body-update", target: "self", body: "new body", mergeStrategy: "replace" },
      ],
      diagnostics: [],
    });
    const result = await applyAgentEvents(
      "raw", { stream, source, registry },
      { workItem: { id: "F20260508-0001", kind: "finding" } }, makeCtx(),
    );
    expect(source.bodyUpdates).toHaveLength(1);
    expect(source.bodyUpdates[0]).toMatchObject({
      body: "new body", mergeStrategy: "replace",
    });
    expect(result.applied.bodyUpdates).toHaveLength(1);
  });

  it("collects note events without applying them (caller forwards to PR / KV)", async () => {
    const stream = fakeStream({
      events: [
        { type: "note", target: "self", visibility: "pr-comment", body: "looks good" },
        { type: "note", target: "self", visibility: "internal", body: "internal log" },
      ],
      diagnostics: [],
    });
    const result = await applyAgentEvents(
      "raw", { stream, source, registry },
      { workItem: { id: "F20260508-0001", kind: "finding" } }, makeCtx(),
    );
    expect(result.notes).toHaveLength(2);
    expect(source.created).toHaveLength(0);
    expect(source.statusUpdates).toHaveLength(0);
  });

  it("collects comment-reply events without applying them (caller posts + resolves threads)", async () => {
    const stream = fakeStream({
      events: [
        { type: "comment-reply", thread: "12345", disposition: "fixed", note: "added the guard" },
        { type: "comment-reply", thread: "67890", disposition: "not-applicable", note: "value is non-null by caller contract" },
      ],
      diagnostics: [],
    });
    const result = await applyAgentEvents(
      "raw", { stream, source, registry },
      { workItem: { id: "F20260508-0001", kind: "finding" } }, makeCtx(),
    );
    expect(result.commentReplies).toHaveLength(2);
    expect(result.commentReplies[0]).toMatchObject({ thread: "12345", disposition: "fixed" });
    expect(result.summary).toContain("comment-reply(ies)");
    expect(source.created).toHaveLength(0);
    expect(source.statusUpdates).toHaveLength(0);
  });

  it("forces verdict=failed when an error event is non-recoverable", async () => {
    const stream = fakeStream({
      events: [
        { type: "child-item", kind: "task", parent: "self", title: "x", body: "" },
        { type: "error", code: "VERIFY_FAILED", message: "build broke", recoverable: false },
        { type: "verdict", value: "approved", summary: "should not stick" },
      ],
      diagnostics: [],
    });
    const result = await applyAgentEvents(
      "raw", { stream, source, registry },
      { workItem: { id: "F20260508-0001", kind: "finding" } }, makeCtx(),
    );
    expect(result.verdict).toBe("failed");
    expect(result.summary).toContain("VERIFY_FAILED");
    expect(source.created).toHaveLength(1); // child-item still applied — non-fatal
  });

  it("keeps verdict=approved when the error event is recoverable and verdict event is approved", async () => {
    const stream = fakeStream({
      events: [
        { type: "error", code: "RETRY", message: "transient", recoverable: true },
        { type: "verdict", value: "approved", summary: "ok" },
      ],
      diagnostics: [],
    });
    const result = await applyAgentEvents(
      "raw", { stream, source, registry },
      { workItem: { id: "F20260508-0001", kind: "finding" } }, makeCtx(),
    );
    expect(result.verdict).toBe("approved");
    expect(result.errors).toHaveLength(1);
  });

  it("returns the verdict from an EMIT verdict event", async () => {
    const stream = fakeStream({
      events: [{ type: "verdict", value: "rejected", summary: "finding invalid" }],
      diagnostics: [],
    });
    const result = await applyAgentEvents(
      "raw", { stream, source, registry },
      { workItem: { id: "F20260508-0001", kind: "finding" } }, makeCtx(),
    );
    expect(result.verdict).toBe("rejected");
    expect(result.summary).toBe("finding invalid");
  });

  it("logs a per-record ERROR for a dropped validation-failed child-item — parse diagnostics are no longer an invisible aggregate count", async () => {
    const log = fakeLogger();
    const validationMessage = "EMIT child-item validation failed — missing required field: title";
    const stream = fakeStream({
      events: [],
      diagnostics: [
        {
          severity: "error",
          code: "validation-failed",
          line: 42,
          emitType: "child-item",
          message: validationMessage,
        },
      ],
    });

    const result = await applyAgentEvents(
      "raw",
      { stream, source, registry, log },
      { workItem: { id: "F20260508-0001", kind: "finding" } },
      makeCtx(),
    );

    expect(result.verdict).toBe("failed");
    expect(log.error).toHaveBeenCalledTimes(1);
    expect(log.warn).not.toHaveBeenCalled();
    const [msg, payload] = (log.error as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(msg).toContain("validation-failed");
    expect(msg).toContain("child-item");
    expect(msg).toContain("42");
    expect(msg).toContain(validationMessage);
    expect(payload).toMatchObject({
      scope: "aop-applier",
      diagnosticCode: "validation-failed",
      emitType: "child-item",
      line: 42,
      message: validationMessage,
    });
  });

  it("routes warning-severity parse diagnostics to log.warn, not log.error", async () => {
    const log = fakeLogger();
    const stream = fakeStream({
      events: [],
      diagnostics: [
        {
          severity: "warning",
          code: "unknown-emit-type",
          line: 7,
          emitType: "future",
          message: "skipped unknown EMIT type",
        },
      ],
    });

    const result = await applyAgentEvents(
      "raw",
      { stream, source, registry, log },
      { workItem: { id: "F20260508-0001", kind: "finding" } },
      makeCtx(),
    );

    expect(result.verdict).toBe("approved");
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.error).not.toHaveBeenCalled();
    const [msg, payload] = (log.warn as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(msg).toContain("unknown-emit-type");
    expect(msg).toContain("future");
    expect(msg).toContain("7");
    expect(msg).toContain("skipped unknown EMIT type");
    expect(payload).toMatchObject({
      scope: "aop-applier",
      diagnosticCode: "unknown-emit-type",
      emitType: "future",
      line: 7,
      message: "skipped unknown EMIT type",
    });
  });

  it("returns verdict=failed when parse diagnostics include errors", async () => {
    const stream = fakeStream({
      events: [],
      diagnostics: [
        { severity: "error", code: "raw-frontmatter-leak", line: 12, message: "leak" },
      ],
    });
    const result = await applyAgentEvents(
      "raw", { stream, source, registry },
      { workItem: { id: "F20260508-0001", kind: "finding" } }, makeCtx(),
    );
    expect(result.verdict).toBe("failed");
    expect(result.summary).toContain("AOP parse: 1 error diagnostic(s)");
  });

  it("collects apply errors and flips verdict to failed when WorkItemSource.create throws", async () => {
    source.failNextCreate = true;
    const stream = fakeStream({
      events: [
        { type: "child-item", kind: "task", parent: "self", title: "x", body: "" },
        { type: "verdict", value: "approved" },
      ],
      diagnostics: [],
    });
    const result = await applyAgentEvents(
      "raw", { stream, source, registry },
      { workItem: { id: "F20260508-0001", kind: "finding" } }, makeCtx(),
    );
    expect(result.verdict).toBe("failed");
    expect(result.applyErrors).toHaveLength(1);
    expect(result.applyErrors[0].code).toBe("APPLY_FAILED");
    expect(result.applyErrors[0].message).toContain("fake create boom");
  });

  it("propagates the WI_NOT_FOUND error code from a WorkItemSource throw", async () => {
    source.failNextStatusUpdate = true;
    const stream = fakeStream({
      events: [{ type: "status-update", target: "self", status: "completed" }],
      diagnostics: [],
    });
    const result = await applyAgentEvents(
      "raw", { stream, source, registry },
      { workItem: { id: "F20260508-0001", kind: "finding" } }, makeCtx(),
    );
    expect(result.applyErrors).toHaveLength(1);
    expect(result.applyErrors[0].code).toBe("WI_NOT_FOUND");
  });

  it("rejects EMIT target=self when no active item is in scope", async () => {
    const stream = fakeStream({
      events: [{ type: "status-update", target: "self", status: "completed" }],
      diagnostics: [],
    });
    const result = await applyAgentEvents(
      "raw", { stream, source, registry },
      { /* no workItem */ }, makeCtx(),
    );
    expect(result.applyErrors).toHaveLength(1);
    expect(result.applyErrors[0].message).toContain("self");
  });

  it("collects recovery events for downstream queueing without applying them", async () => {
    const stream = fakeStream({
      events: [
        { type: "recovery", target: "F20260508-0001", action: "ci-rerun", context: "transient flake" },
      ],
      diagnostics: [],
    });
    const result = await applyAgentEvents(
      "raw", { stream, source, registry },
      { workItem: { id: "F20260508-0001", kind: "finding" } }, makeCtx(),
    );
    expect(result.recoveries).toHaveLength(1);
    expect(result.recoveries[0].action).toBe("ci-rerun");
    expect(result.verdict).toBe("approved");
  });

  it("continues applying later events when an earlier one fails", async () => {
    source.failNextCreate = true;
    const stream = fakeStream({
      events: [
        { type: "child-item", kind: "task", parent: "self", title: "broken", body: "" },
        { type: "child-item", kind: "task", parent: "self", title: "ok", body: "" },
      ],
      diagnostics: [],
    });
    const result = await applyAgentEvents(
      "raw", { stream, source, registry },
      { workItem: { id: "F20260508-0001", kind: "finding" }, date: "20260508" }, makeCtx(),
    );
    expect(result.applyErrors).toHaveLength(1);
    expect(source.created).toHaveLength(1);
    expect(source.created[0].title).toBe("ok");
    expect(result.verdict).toBe("failed");
  });

  it("returns approved with neutral summary when parser yields zero events and zero diagnostics", async () => {
    const stream = fakeStream({ events: [], diagnostics: [] });
    const result = await applyAgentEvents(
      "raw", { stream, source, registry },
      { workItem: { id: "F20260508-0001", kind: "finding" } }, makeCtx(),
    );
    expect(result.verdict).toBe("approved");
    expect(result.events).toHaveLength(0);
    expect(result.applied.childItems).toHaveLength(0);
  });

  it("logs warnings without failing the verdict when diagnostics are warning-only", async () => {
    const stream = fakeStream({
      events: [{ type: "verdict", value: "approved" }],
      diagnostics: [
        { severity: "warning", code: "unknown-emit-type", line: 1, emitType: "future", message: "skipped" },
      ],
    });
    const result = await applyAgentEvents(
      "raw", { stream, source, registry },
      { workItem: { id: "F20260508-0001", kind: "finding" } }, makeCtx(),
    );
    expect(result.verdict).toBe("approved");
    expect(result.diagnostics).toHaveLength(1);
  });

  it("uses today's date by default for child-item id generation when active.date is omitted", async () => {
    const generateId = vi.spyOn(registry, "generateId");
    const stream = fakeStream({
      events: [{ type: "child-item", kind: "task", parent: "self", title: "x", body: "" }],
      diagnostics: [],
    });
    await applyAgentEvents(
      "raw", { stream, source, registry },
      { workItem: { id: "F20260508-0001", kind: "finding" } /* no date */ }, makeCtx(),
    );
    // When date is omitted the registry receives `undefined` and falls back
    // to its internal todayYyyymmdd().
    expect(generateId).toHaveBeenCalledWith("task", undefined);
  });

  it("passes the active.date through to generateId for child-item id generation", async () => {
    const generateId = vi.spyOn(registry, "generateId");
    const stream = fakeStream({
      events: [{ type: "child-item", kind: "task", parent: "self", title: "x", body: "" }],
      diagnostics: [],
    });
    await applyAgentEvents(
      "raw", { stream, source, registry },
      { workItem: { id: "F20260508-0001", kind: "finding" }, date: "20260508" }, makeCtx(),
    );
    expect(generateId).toHaveBeenCalledWith("task", "20260508");
  });
});
