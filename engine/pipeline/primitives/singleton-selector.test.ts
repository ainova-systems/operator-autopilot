import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OperationContext } from "@operator/core";
import { singletonSelect, formatWeek } from "./singleton-selector.js";
import type { StageDef } from "../types.js";

function makeCtx(): OperationContext {
  return {
    traceId: "t",
    repoId: "sample",
    action: "retrospective",
    budget: { limitUsd: undefined, spentUsd: 0, add: () => {}, isExceeded: () => false },
    signal: AbortSignal.timeout(10_000),
  };
}

function makeStageDef(overrides?: Partial<StageDef>): StageDef {
  return {
    name: "retrospective",
    agent: "improver",
    selector: "singleton",
    selectorConfig: { scopeKind: "week" },
    merge: "gated",
    branchScope: "per-item",
    branchPrefix: "ai/retrospective",
    schedule: "0 9 * * 1",
    review: true,
    enabled: true,
    baseBranch: "develop",
    ...overrides,
  };
}

describe("formatWeek", () => {
  it("returns YYYYWNN formatted string", () => {
    const week = formatWeek(new Date("2026-04-17T10:00:00Z"));
    expect(week).toMatch(/^2026W\d{2}$/);
  });

  it("zero-pads the week number below 10", () => {
    const week = formatWeek(new Date("2026-01-05T10:00:00Z"));
    expect(week).toMatch(/^2026W0\d$/);
  });
});

describe("singletonSelect", () => {
  let workspacePath: string;

  beforeEach(async () => {
    workspacePath = await mkdtemp(join(tmpdir(), "op-singleton-"));
  });

  afterEach(async () => {
    await rm(workspacePath, { recursive: true, force: true });
  });

  it("emits the current ISO week when scopeKind=week", async () => {
    const vcs = { getCodeReviews: vi.fn().mockResolvedValue([]) };
    const result = await singletonSelect(
      makeStageDef({ selectorConfig: { scopeKind: "week" } }),
      { vcs, workspacePath },
      makeCtx(),
    );

    expect(result).not.toBeNull();
    expect(result?.scopeKey).toMatch(/^\d{4}W\d{2}$/);
    expect(result?.data).toMatchObject({ scopeKind: "week" });
    expect(result?.reason).toContain("week=");
  });

  it("emits today's date when scopeKind=date", async () => {
    const vcs = { getCodeReviews: vi.fn().mockResolvedValue([]) };
    const result = await singletonSelect(
      makeStageDef({ selectorConfig: { scopeKind: "date" } }),
      { vcs, workspacePath },
      makeCtx(),
    );

    expect(result).not.toBeNull();
    expect(result?.scopeKey).toMatch(/^\d{8}$/);
    expect(result?.data).toMatchObject({ scopeKind: "date" });
  });

  it("emits the literal scopeKey when scopeKind=literal", async () => {
    const vcs = { getCodeReviews: vi.fn().mockResolvedValue([]) };
    const result = await singletonSelect(
      makeStageDef({
        selectorConfig: { scopeKind: "literal", scopeKey: "manual-run-1" },
      }),
      { vcs, workspacePath },
      makeCtx(),
    );

    expect(result?.scopeKey).toBe("manual-run-1");
  });

  it("defaults to scopeKind=literal when config is empty and scopeKey provided", async () => {
    const vcs = { getCodeReviews: vi.fn().mockResolvedValue([]) };
    const result = await singletonSelect(
      makeStageDef({ selectorConfig: { scopeKey: "once" } }),
      { vcs, workspacePath },
      makeCtx(),
    );
    expect(result?.scopeKey).toBe("once");
  });

  it("throws when scopeKind=literal but scopeKey is missing", async () => {
    const vcs = { getCodeReviews: vi.fn() };
    await expect(
      singletonSelect(
        makeStageDef({ selectorConfig: { scopeKind: "literal" } }),
        { vcs, workspacePath },
        makeCtx(),
      ),
    ).rejects.toThrow(/requires selectorConfig\.scopeKey/);
  });

  it("throws on unknown scopeKind", async () => {
    const vcs = { getCodeReviews: vi.fn() };
    await expect(
      singletonSelect(
        makeStageDef({ selectorConfig: { scopeKind: "fortnight" } as unknown as StageDef["selectorConfig"] }),
        { vcs, workspacePath },
        makeCtx(),
      ),
    ).rejects.toThrow(/unknown scopeKind/);
  });

  it("returns null when the requiredFileTemplate resolves to an existing file", async () => {
    const vcs = { getCodeReviews: vi.fn() };
    const stage = makeStageDef({
      selectorConfig: {
        scopeKind: "literal",
        scopeKey: "2026W16",
        requiredFileTemplate: ".operator/data/retrospectives/{scopeKey}.md",
      },
    });
    await mkdir(join(workspacePath, ".operator", "data", "retrospectives"), { recursive: true });
    await writeFile(join(workspacePath, ".operator", "data", "retrospectives", "2026W16.md"), "# retro");

    const result = await singletonSelect(stage, { vcs, workspacePath }, makeCtx());
    expect(result).toBeNull();
  });

  it("proceeds when requiredFileTemplate file does NOT exist", async () => {
    const vcs = { getCodeReviews: vi.fn() };
    const stage = makeStageDef({
      selectorConfig: {
        scopeKind: "literal",
        scopeKey: "2026W16",
        requiredFileTemplate: ".operator/data/retrospectives/{scopeKey}.md",
      },
    });

    const result = await singletonSelect(stage, { vcs, workspacePath }, makeCtx());
    expect(result?.scopeKey).toBe("2026W16");
  });

  it("ignores requiredFileTemplate when not a string", async () => {
    const vcs = { getCodeReviews: vi.fn() };
    const stage = makeStageDef({
      selectorConfig: {
        scopeKind: "literal",
        scopeKey: "2026W16",
        requiredFileTemplate: 42 as unknown as string,
      },
    });
    const result = await singletonSelect(stage, { vcs, workspacePath }, makeCtx());
    expect(result?.scopeKey).toBe("2026W16");
  });

  it("logs INFO lines for proceed + skip decisions", async () => {
    const vcs = { getCodeReviews: vi.fn() };
    const info = vi.fn();
    const log = { info, debug: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn() } as unknown as import("../../logging/logger.js").Logger;

    // Proceed branch.
    await singletonSelect(
      makeStageDef({ selectorConfig: { scopeKind: "literal", scopeKey: "x" } }),
      { vcs, workspacePath, log },
      makeCtx(),
    );
    expect(info.mock.calls.some((c) => String(c[0]).includes("selected scopeKey=x"))).toBe(true);

    // Skip branch.
    await mkdir(join(workspacePath, "rel"), { recursive: true });
    await writeFile(join(workspacePath, "rel", "x.txt"), "");
    info.mockClear();
    const skipResult = await singletonSelect(
      makeStageDef({
        selectorConfig: {
          scopeKind: "literal", scopeKey: "x",
          requiredFileTemplate: "rel/{scopeKey}.txt",
        },
      }),
      { vcs, workspacePath, log },
      makeCtx(),
    );
    expect(skipResult).toBeNull();
    expect(info.mock.calls.some((c) => String(c[0]).includes("will skip"))).toBe(true);
  });
});
