import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OperationContext, KindRegistry, WorkItemKind } from "@operator/core";
import { buildGenericHooks, resolveItemFilePath } from "./generic-stage.js";
import type { StageDef, StageInput, AgentResult } from "./types.js";

function makeCtx(): OperationContext {
  return {
    traceId: "test", repoId: "r",
    action: "cycle",
    budget: { spentUsd: 0, add: () => {}, isExceeded: () => false },
    signal: AbortSignal.timeout(30_000),
  };
}

function makeRegistry(): KindRegistry {
  return {
    all: [],
    get: () => null,
    isTerminal: () => false,
    generateId: async () => "GEN",
    labelFor: (k: WorkItemKind) => k,
    branchPrefixFor: (k: WorkItemKind) => `ai/${k}s`,
    dataDirFor: (k: WorkItemKind) => `${k}s`,
  };
}

function makeStageDef(overrides: Partial<StageDef> = {}): StageDef {
  return {
    name: "finding-plan",
    agent: "planner",
    selector: "per-item",
    merge: "gated",
    branchScope: "per-item",
    branchPrefix: "ai/findings",
    schedule: "*/5 * * * *",
    enabled: true,
    baseBranch: "develop",
    outputSink: {
      kind: "task",
      parser: "single-document",
      commitMode: "work-item-files",
    },
    reviewEnabled: true,
    ...overrides,
  };
}

function makeWorkspace() {
  return { branch: "ai/findings/F1", baseBranch: "develop" };
}

function makeAgentResult(output: string, verdict: AgentResult["verdict"] = "approved"): AgentResult {
  return { verdict, output, attempts: 1, summary: "done" };
}

describe("resolveItemFilePath", () => {
  it("composes the on-disk path from workspacePath + kind dataDir + id", () => {
    const gctx = { kindRegistry: makeRegistry(), workspacePath: "/ws" };
    const path = resolveItemFilePath(gctx, "finding", "F20260420-0001");
    expect(path.replace(/\\/g, "/")).toBe("/ws/.operator/data/findings/F20260420-0001.md");
  });
});

describe("buildGenericHooks — afterAgent", () => {
  let ws: string;

  beforeEach(() => {
    ws = mkdtempSync(join(tmpdir(), "gs-"));
    mkdirSync(join(ws, ".operator", "data", "tasks"), { recursive: true });
    mkdirSync(join(ws, ".operator", "data", "findings"), { recursive: true });
  });
  afterEach(() => { rmSync(ws, { recursive: true, force: true }); });

  it("single-document → writes one file under the output kind's dataDir", async () => {
    const stageDef = makeStageDef();
    const hooks = buildGenericHooks(stageDef, {
      kindRegistry: makeRegistry(), workspacePath: ws,
    });
    const out = [
      "---", "id: T20260420-0001", "kind: task", "priority: 3", "---",
      "Task body paragraph.",
    ].join("\n");

    const result = await hooks.afterAgent(
      stageDef,
      { scopeKey: "F20260420-0001" } as StageInput,
      makeAgentResult(out),
      makeWorkspace(),
      makeCtx(),
    );

    const expectedPath = join(ws, ".operator", "data", "tasks", "T20260420-0001.md");
    expect(existsSync(expectedPath)).toBe(true);
    expect(readFileSync(expectedPath, "utf-8")).toContain("id: T20260420-0001");
    expect(readFileSync(expectedPath, "utf-8")).toContain("Task body paragraph.");
    expect(result).toEqual({
      summaryOverride: "Created 1 task(s): T20260420-0001",
    });
  });

  it("multi-document → writes N files and reports each id", async () => {
    const stageDef = makeStageDef({
      outputSink: { kind: "finding", parser: "multi-document", commitMode: "work-item-files" },
    });
    const hooks = buildGenericHooks(stageDef, {
      kindRegistry: makeRegistry(), workspacePath: ws,
    });
    const out = [
      "---", "id: F20260420-0001", "kind: finding", "---", "A body",
      "---", "id: F20260420-0002", "kind: finding", "---", "B body",
    ].join("\n");

    const result = await hooks.afterAgent(
      stageDef,
      { scopeKey: "20260420" } as StageInput,
      makeAgentResult(out),
      makeWorkspace(),
      makeCtx(),
    );

    expect(existsSync(join(ws, ".operator", "data", "findings", "F20260420-0001.md"))).toBe(true);
    expect(existsSync(join(ws, ".operator", "data", "findings", "F20260420-0002.md"))).toBe(true);
    expect(result).toEqual({
      summaryOverride: "Created 2 finding(s): F20260420-0001, F20260420-0002",
    });
  });

  it("code-changes → noop (persist primitive commits the diff)", async () => {
    const stageDef = makeStageDef({
      outputSink: { parser: "code-changes", commitMode: "code-changes" },
    });
    const hooks = buildGenericHooks(stageDef, {
      kindRegistry: makeRegistry(), workspacePath: ws,
    });

    const result = await hooks.afterAgent(
      stageDef,
      { scopeKey: "T1" } as StageInput,
      makeAgentResult("narrative text about file edits"),
      makeWorkspace(),
      makeCtx(),
    );

    expect(result).toBeUndefined();
  });

  it("non-approved verdict → returns without writing files", async () => {
    const stageDef = makeStageDef();
    const hooks = buildGenericHooks(stageDef, {
      kindRegistry: makeRegistry(), workspacePath: ws,
    });
    const out = ["---", "id: T1", "kind: task", "---", "body"].join("\n");

    await hooks.afterAgent(
      stageDef,
      { scopeKey: "F1" } as StageInput,
      makeAgentResult(out, "failed"),
      makeWorkspace(),
      makeCtx(),
    );

    expect(existsSync(join(ws, ".operator", "data", "tasks", "T1.md"))).toBe(false);
  });

  it("throws when output document is missing frontmatter.id", async () => {
    const stageDef = makeStageDef();
    const hooks = buildGenericHooks(stageDef, {
      kindRegistry: makeRegistry(), workspacePath: ws,
    });
    const out = ["---", "kind: task", "---", "body"].join("\n");

    await expect(hooks.afterAgent(
      stageDef,
      { scopeKey: "F1" } as StageInput,
      makeAgentResult(out),
      makeWorkspace(),
      makeCtx(),
    )).rejects.toThrow(/missing frontmatter.id/);
  });

  it("throws when output document kind mismatches outputSink.kind", async () => {
    const stageDef = makeStageDef();
    const hooks = buildGenericHooks(stageDef, {
      kindRegistry: makeRegistry(), workspacePath: ws,
    });
    const out = ["---", "id: F1", "kind: finding", "---", "body"].join("\n");

    await expect(hooks.afterAgent(
      stageDef,
      { scopeKey: "F1" } as StageInput,
      makeAgentResult(out),
      makeWorkspace(),
      makeCtx(),
    )).rejects.toThrow(/kind mismatch/);
  });

  it("throws when commitMode=work-item-files lacks outputSink.kind", async () => {
    const stageDef = makeStageDef({
      outputSink: { parser: "single-document", commitMode: "work-item-files" },
    });
    const hooks = buildGenericHooks(stageDef, {
      kindRegistry: makeRegistry(), workspacePath: ws,
    });
    const out = ["---", "id: X", "---", "body"].join("\n");

    await expect(hooks.afterAgent(
      stageDef,
      { scopeKey: "X" } as StageInput,
      makeAgentResult(out),
      makeWorkspace(),
      makeCtx(),
    )).rejects.toThrow(/requires outputSink.kind/);
  });

  it("renders array frontmatter values as YAML lists", async () => {
    const stageDef = makeStageDef();
    const hooks = buildGenericHooks(stageDef, {
      kindRegistry: makeRegistry(), workspacePath: ws,
    });
    const out = [
      "---",
      "id: T1",
      "kind: task",
      "dependsOn:",
      "  - A",
      "  - B",
      "---",
      "body",
    ].join("\n");

    await hooks.afterAgent(
      stageDef,
      { scopeKey: "F1" } as StageInput,
      makeAgentResult(out),
      makeWorkspace(),
      makeCtx(),
    );

    const written = readFileSync(join(ws, ".operator", "data", "tasks", "T1.md"), "utf-8");
    expect(written).toContain("dependsOn:\n  - A\n  - B");
  });
});
