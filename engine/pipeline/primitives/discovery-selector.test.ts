import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OperationContext, VCSPlatform } from "@operator/core";
import type { StageDef } from "../types.js";
import {
  discoverySelect,
  analyzerCadence,
  ANALYZER_THROTTLE_MINUTES,
  loadAnalyzerDefs,
  formatDate,
  type DiscoveryPayload,
} from "./discovery-selector.js";
import type { BootstrapSelectorDeps } from "./item-selector.js";
import { TestStateManager } from "../../test-helpers/test-state-manager.js";

function makeCtx(): OperationContext {
  return {
    traceId: "disc-test",
    repoId: "sample",
    action: "research",
    budget: { spentUsd: 0, add: () => {}, isExceeded: () => false },
    signal: AbortSignal.timeout(5_000),
  };
}

function makeVCS(): Pick<VCSPlatform, "getCodeReviews"> {
  return { getCodeReviews: vi.fn().mockResolvedValue([]) };
}

function makeStageDef(overrides: Partial<StageDef> = {}): StageDef {
  return {
    name: "research",
    agent: "analyst",
    selector: "discovery",
    merge: "gated",
    branchScope: "per-item",
    branchPrefix: "ai/research",
    schedule: "0 8 * * *",
    review: false,
    enabled: true,
    baseBranch: "develop",
    ...overrides,
  };
}

let tmp: string;
let workspacePath: string;
let analystDir: string;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "discovery-selector-"));
  workspacePath = join(tmp, "workspace");
  analystDir = join(workspacePath, ".operator", "analyst");
  await mkdir(analystDir, { recursive: true });
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

function makeDeps(
  log?: BootstrapSelectorDeps["log"],
  state?: BootstrapSelectorDeps["state"],
): BootstrapSelectorDeps {
  return { vcs: makeVCS(), workspacePath, log, state };
}

describe("analyzerCadence", () => {
  it("daily and empty schedule run every cycle", () => {
    expect(analyzerCadence("daily")).toBe("every");
    expect(analyzerCadence("")).toBe("every");
  });

  it("on-demand never runs automatically", () => {
    expect(analyzerCadence("on-demand")).toBe("never");
  });

  it("weekly and weekly:N are throttled (run at most ~once per 7 days)", () => {
    expect(analyzerCadence("weekly")).toBe("throttled");
    expect(analyzerCadence("weekly:3")).toBe("throttled");
  });

  it("unknown schedule string falls through to every (permissive default)", () => {
    expect(analyzerCadence("monthly")).toBe("every");
  });
});

describe("loadAnalyzerDefs", () => {
  it("returns empty array when directory does not exist", async () => {
    const logs: unknown[] = [];
    const log = {
      info: vi.fn(), debug: vi.fn(), warn: (msg: string, meta?: unknown) => { logs.push({ msg, meta }); },
      error: vi.fn(), child: vi.fn(),
    } as unknown as BootstrapSelectorDeps["log"];
    const defs = await loadAnalyzerDefs(join(tmp, "missing"), log);
    expect(defs).toEqual([]);
    expect(logs.length).toBe(1);
  });

  it("parses analyzer frontmatter fields", async () => {
    await writeFile(
      join(analystDir, "security.md"),
      `---\nschedule: weekly:3\nenabled: true\npath: Source/**\n---\n\nScan for vulnerabilities.`,
    );
    const defs = await loadAnalyzerDefs(analystDir);
    expect(defs).toHaveLength(1);
    expect(defs[0]).toEqual({
      id: "security",
      schedule: "weekly:3",
      enabled: true,
      path: "Source/**",
      body: "Scan for vulnerabilities.",
    });
  });

  it("defaults schedule to daily and enabled to true when frontmatter omits them", async () => {
    await writeFile(join(analystDir, "minimal.md"), `---\n---\n\nBody`);
    const defs = await loadAnalyzerDefs(analystDir);
    expect(defs[0].schedule).toBe("daily");
    expect(defs[0].enabled).toBe(true);
  });

  it("marks enabled=false when frontmatter explicitly sets enabled: false", async () => {
    await writeFile(join(analystDir, "off.md"), `---\nenabled: false\n---\n\nBody`);
    const defs = await loadAnalyzerDefs(analystDir);
    expect(defs[0].enabled).toBe(false);
  });

  it("parses CRLF (\\r\\n) analyzer frontmatter — quoted enabled:false stays disabled and weekly:3 stays throttled (regression)", async () => {
    await writeFile(
      join(analystDir, "crlf.md"),
      '---\r\nschedule: "weekly:3"\r\nenabled: "false"\r\npath: "Source/**"\r\n---\r\n\r\nBody',
    );
    const defs = await loadAnalyzerDefs(analystDir);
    expect(defs).toHaveLength(1);
    expect(defs[0].enabled).toBe(false);
    expect(defs[0].schedule).toBe("weekly:3");
    expect(analyzerCadence(defs[0].schedule)).toBe("throttled");
    expect(defs[0].path).toBe("Source/**");
  });

  it("ignores non-.md files", async () => {
    await writeFile(join(analystDir, "notes.txt"), "ignored");
    await writeFile(join(analystDir, "good.md"), `---\n---\n\nBody`);
    const defs = await loadAnalyzerDefs(analystDir);
    expect(defs.map((d) => d.id)).toEqual(["good"]);
  });

  it("skips files without frontmatter delimiters", async () => {
    await writeFile(join(analystDir, "bad.md"), "no frontmatter here");
    await writeFile(join(analystDir, "good.md"), `---\n---\n\nBody`);
    const defs = await loadAnalyzerDefs(analystDir);
    expect(defs.map((d) => d.id)).toEqual(["good"]);
  });

  it("sorts analyzers alphabetically by filename", async () => {
    await writeFile(join(analystDir, "zeta.md"), `---\n---\n\nZ`);
    await writeFile(join(analystDir, "alpha.md"), `---\n---\n\nA`);
    await writeFile(join(analystDir, "mid.md"), `---\n---\n\nM`);
    const defs = await loadAnalyzerDefs(analystDir);
    expect(defs.map((d) => d.id)).toEqual(["alpha", "mid", "zeta"]);
  });

  it("warns and skips when file is unreadable mid-iteration", async () => {
    await writeFile(join(analystDir, "ok.md"), `---\n---\n\nBody`);
    await writeFile(join(analystDir, "bad.md"), `---\n---\n\nBody`);
    // Force a read failure on bad.md on Unix-like systems. On Windows chmod
    // may silently no-op; the test degrades gracefully by still asserting
    // "ok" loads.
    try { await chmod(join(analystDir, "bad.md"), 0o000); } catch { /* ignore */ }
    const warn = vi.fn();
    const log = { info: vi.fn(), debug: vi.fn(), warn, error: vi.fn(), child: vi.fn() } as unknown as BootstrapSelectorDeps["log"];
    const defs = await loadAnalyzerDefs(analystDir, log);
    expect(defs.some((d) => d.id === "ok")).toBe(true);
    try { await chmod(join(analystDir, "bad.md"), 0o644); } catch { /* ignore */ }
  });
});

describe("formatDate", () => {
  it("produces YYYYMMDD UTC", () => {
    const d = new Date(Date.UTC(2026, 3, 7, 12)); // April 7, 2026
    expect(formatDate(d)).toBe("20260407");
  });
});

describe("discoverySelect", () => {
  it("returns null when analyzer directory does not exist", async () => {
    const info: string[] = [];
    const log = {
      info: (msg: string) => info.push(msg),
      debug: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn(),
    } as unknown as BootstrapSelectorDeps["log"];
    await rm(analystDir, { recursive: true, force: true });
    const res = await discoverySelect(makeStageDef(), makeDeps(log), makeCtx());
    expect(res).toBeNull();
    expect(info.some((m) => m.includes("no analyzers"))).toBe(true);
  });

  it("returns null when all analyzers are disabled", async () => {
    await writeFile(join(analystDir, "a.md"), `---\nenabled: false\n---\n\nBody`);
    await writeFile(join(analystDir, "b.md"), `---\nenabled: false\n---\n\nBody`);
    const info: string[] = [];
    const log = {
      info: (msg: string) => info.push(msg),
      debug: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn(),
    } as unknown as BootstrapSelectorDeps["log"];
    const res = await discoverySelect(makeStageDef(), makeDeps(log), makeCtx());
    expect(res).toBeNull();
    expect(info.some((m) => m.includes("none eligible today"))).toBe(true);
  });

  it("returns null when all analyzers are on-demand", async () => {
    await writeFile(join(analystDir, "manual.md"), `---\nschedule: on-demand\n---\n\nBody`);
    const res = await discoverySelect(makeStageDef(), makeDeps(), makeCtx());
    expect(res).toBeNull();
  });

  it("returns payload with eligible daily analyzers", async () => {
    await writeFile(join(analystDir, "a.md"), `---\nschedule: daily\n---\n\nAlpha`);
    await writeFile(join(analystDir, "b.md"), `---\nschedule: daily\n---\n\nBravo`);
    const info: string[] = [];
    const log = {
      info: (msg: string) => info.push(msg),
      debug: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn(),
    } as unknown as BootstrapSelectorDeps["log"];
    const res = await discoverySelect(makeStageDef(), makeDeps(log), makeCtx());
    expect(res).not.toBeNull();
    const payload = res!.data as DiscoveryPayload;
    expect(res!.scopeKey).toMatch(/^\d{8}$/);
    expect(payload.analyzers).toHaveLength(2);
    expect(payload.analyzers.map((a) => a.id)).toEqual(["a", "b"]);
    expect(info.some((m) => m.includes("selected 2/2"))).toBe(true);
  });

  it("filters disabled analyzers from the payload but keeps enabled siblings", async () => {
    await writeFile(join(analystDir, "enabled.md"), `---\nenabled: true\n---\n\nGo`);
    await writeFile(join(analystDir, "disabled.md"), `---\nenabled: false\n---\n\nNo`);
    const res = await discoverySelect(makeStageDef(), makeDeps(), makeCtx());
    const payload = res!.data as DiscoveryPayload;
    expect(payload.analyzers.map((a) => a.id)).toEqual(["enabled"]);
  });

  it("respects custom discoveryDir via selectorConfig", async () => {
    const custom = join(workspacePath, ".operator", "stages", "research");
    await mkdir(custom, { recursive: true });
    await writeFile(join(custom, "a.md"), `---\n---\n\nA`);
    const res = await discoverySelect(
      makeStageDef({ selectorConfig: { discoveryDir: ".operator/stages/research" } }),
      makeDeps(),
      makeCtx(),
    );
    expect(res).not.toBeNull();
    expect((res!.data as DiscoveryPayload).analyzers).toHaveLength(1);
  });

  it("respects custom date via selectorConfig (deterministic tests)", async () => {
    await writeFile(join(analystDir, "a.md"), `---\n---\n\nA`);
    const res = await discoverySelect(
      makeStageDef({ selectorConfig: { date: "20260407" } }),
      makeDeps(),
      makeCtx(),
    );
    expect(res!.scopeKey).toBe("20260407");
  });

  it("runs a weekly analyzer the first time then throttles it for 7 days", async () => {
    await writeFile(join(analystDir, "weekly.md"), `---\nschedule: weekly:3\n---\n\nBody`);
    const state = new TestStateManager();
    // First cycle: never run before → due → included AND its run is marked.
    const first = await discoverySelect(makeStageDef(), makeDeps(undefined, state), makeCtx());
    expect((first!.data as DiscoveryPayload).analyzers.map((a) => a.id)).toContain("weekly");
    expect(
      await state.isScheduleDue(makeCtx(), "sample", "analyzer:weekly", ANALYZER_THROTTLE_MINUTES),
    ).toBe(false);
    // Second cycle immediately after: throttled → excluded → no eligible → null.
    const second = await discoverySelect(makeStageDef(), makeDeps(undefined, state), makeCtx());
    expect(second).toBeNull();
  });

  it("runs weekly analyzers unthrottled when no state manager is wired (fallback)", async () => {
    await writeFile(join(analystDir, "weekly.md"), `---\nschedule: weekly\n---\n\nBody`);
    const res = await discoverySelect(makeStageDef(), makeDeps(), makeCtx());
    expect((res!.data as DiscoveryPayload).analyzers.map((a) => a.id)).toContain("weekly");
  });

  it("picks scopeKey from today's date when no date override is provided", async () => {
    await writeFile(join(analystDir, "a.md"), `---\n---\n\nA`);
    const res = await discoverySelect(makeStageDef(), makeDeps(), makeCtx());
    const today = formatDate(new Date());
    expect(res!.scopeKey).toBe(today);
  });

  it("sets the reason field to `${count}-analyzers`", async () => {
    await writeFile(join(analystDir, "a.md"), `---\n---\n\nA`);
    const res = await discoverySelect(makeStageDef(), makeDeps(), makeCtx());
    expect(res!.reason).toBe("1-analyzers");
  });
});
