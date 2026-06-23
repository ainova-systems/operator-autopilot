import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OperationContext } from "@operator/core";
import { LocalStorageBundle } from "@operator/adapters/kvstore-sqlite";
import { seed } from "./seed.js";

function makeCtx(): OperationContext {
  return {
    traceId: "seed-test",
    repoId: "test",
    action: "seed",
    budget: { limitUsd: undefined, spentUsd: 0, add: () => {}, isExceeded: () => false },
    signal: AbortSignal.timeout(60_000),
  };
}

function silentLogger() {
  const messages: { level: string; msg: string }[] = [];
  const self = {
    messages,
    debug(msg: string) { messages.push({ level: "debug", msg }); },
    info(msg: string) { messages.push({ level: "info", msg }); },
    warn(msg: string) { messages.push({ level: "warn", msg }); },
    error(msg: string) { messages.push({ level: "error", msg }); },
    child() { return self; },
  };
  return self;
}

interface SeedHarness {
  readonly bundle: LocalStorageBundle;
  readonly configDir: string;
  readonly contentDir: string;
  readonly tmpRoot: string;
  cleanup(): void;
}

function createHarness(): SeedHarness {
  const tmpRoot = mkdtempSync(join(tmpdir(), "seed-"));
  const stateDir = join(tmpRoot, "state");
  const configDir = join(tmpRoot, "config");
  const contentDir = join(tmpRoot, "content");
  mkdirSync(stateDir);
  mkdirSync(configDir);
  mkdirSync(contentDir);
  process.env.OPERATOR_CONTENT_DIR = contentDir;
  const bundle = new LocalStorageBundle({ dbPath: join(stateDir, "kv.db") });
  return {
    bundle,
    configDir,
    contentDir,
    tmpRoot,
    cleanup() {
      bundle.close();
      delete process.env.OPERATOR_CONTENT_DIR;
      rmSync(tmpRoot, { recursive: true, force: true });
    },
  };
}

function writeFile(path: string, body: string): void {
  const dir = path.slice(0, Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")));
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, body, "utf-8");
}

function writeMinimumContent(contentDir: string): void {
  writeFile(join(contentDir, "prompts/agents/creator.md"), "# Creator prompt\nbody");
  writeFile(join(contentDir, "prompts/agents/context/base.md"), "# Base context");
  writeFile(join(contentDir, "prompts/agents/verifier/task.md"), "# Task review criteria");
  writeFile(join(contentDir, "templates/task-pr-body.md"), "# Task PR");
  writeFile(join(contentDir, "templates/formats/task.txt"), "task format");
  writeFile(
    join(contentDir, "defaults/agents.yaml"),
    [
      "version: '3.0'",
      "defaultProvider: claude",
      "providers:",
      "  claude:",
      "    command: claude",
      "    promptArg: '-p'",
      "agents:",
      "  creator:",
      "    provider: claude",
      "    instructions: agents/creator.md",
      "    timeout: 3600",
      "",
    ].join("\n"),
  );
  writeFile(
    join(contentDir, "defaults/defaults.yaml"),
    [
      "schedules:",
      "  prReviewMinutes: 5",
      "  taskSelectMinutes: 15",
      "  findingSelectMinutes: 30",
      "  dailyResearchHour: 8",
      "  improverDayOfWeek: 1",
      "  prLifecycleMinutes: 15",
      "limits:",
      "  maxReviewAttempts: 25",
      "review:",
      "  ignoredBotLogins: []",
      "lifecycle:",
      "  promoteToReadyAfterIdleHours: 1",
      "  autoMergeReadyAfterHours: null",
      "  autoCloseStuckAfterHours: null",
      "labels:",
      "  pending: ai:pending",
      "  processing: ai:processing",
      "  inReview: ai:in-review",
      "  readyToMerge: ai:ready-to-merge",
      "  failed: ai:failed",
      "conventions:",
      "  branches:",
      "    aiPrefix: ai",
      "    init: ai/init",
      "    tasks: ai/tasks",
      "    findings: ai/findings",
      "    research: ai/research",
      "    improver: ai/improver",
      "  prPrefixes:",
      "    task: '[AI:Task]'",
      "    finding: '[AI:Finding]'",
      "    research: '[AI:Research]'",
      "    improver: '[AI:Improver]'",
      "    init: '[AI:Init]'",
      "  patterns:",
      "    taskId: 'T[0-9]{8}-[0-9]{6}'",
      "    findingPrefix: F",
      "  commentMarker: '<!-- bot:operator -->'",
      "",
    ].join("\n"),
  );
  writeFile(
    join(contentDir, "prompts/stages.yaml"),
    [
      "stages:",
      "  - name: init",
      "    agent: scout",
      "    selector: singleton",
      "    merge: gated",
      "    branchScope: singleton",
      "    schedule: on-start",
      "    enabled: true",
      "    outputSink:",
      "      parser: code-changes",
      "      commitMode: code-changes",
      "    reviewEnabled: false",
      "",
    ].join("\n"),
  );
  writeFile(
    join(contentDir, "prompts/kinds.yaml"),
    [
      "kinds:",
      "  task:",
      "    label: Task",
      "    idPrefix: T",
      "    dataDir: tasks",
      "    branchPrefix: ai/tasks",
      "    prPrefix: '[AI:Task]'",
      "    terminalStatuses: [completed, failed]",
      "",
    ].join("\n"),
  );
}

function writeRepos(configDir: string, ids: readonly string[]): void {
  const repos = ids.map((id) => [
    `  - id: ${id}`,
    `    vcs:`,
    `      platform: github`,
    `      repo: owner/${id}`,
    `      branch: main`,
    `      tokenEnvVar: GH_TOKEN`,
  ].join("\n")).join("\n");
  writeFile(join(configDir, "repos.yaml"), `repos:\n${repos}\n`);
}

describe("seed", () => {
  let h: SeedHarness;

  beforeEach(() => { h = createHarness(); });
  afterEach(() => { h.cleanup(); });

  it("seeds every content category on first run", async () => {
    writeMinimumContent(h.contentDir);
    writeRepos(h.configDir, ["sample"]);

    const result = await seed(
      h.bundle,
      { configDir: h.configDir },
      makeCtx(),
      silentLogger(),
    );

    expect(result.seededOnce.prompts).toBe(2); // creator + context/base
    expect(result.seededOnce["verifier-criteria"]).toBe(1);
    expect(result.seededOnce.templates).toBe(2);
    expect(result.seededOnce["agent-roles"]).toBe(1);
    expect(result.seededOnce["agent-providers"]).toBe(2); // claude + _default
    expect(result.seededOnce["engine-defaults"]).toBe(1); // global
    expect(result.seededOnce["workflow-stages"]).toBe(1);
    expect(result.seededOnce["work-item-kinds"]).toBe(1);
    expect(result.seededOnce.analyzers).toBe(0);
    expect(result.mirrored.upserted).toBe(1);
    expect(result.mirrored.deleted).toBe(0);

    const creator = await h.bundle.get("prompts", "creator");
    expect(creator?.metadata).toEqual({ source: "content", readonly: false });
    expect((creator?.value as { body: string }).body).toContain("Creator prompt");

    const contextBase = await h.bundle.get("prompts", "context/base");
    expect(contextBase).not.toBeNull();

    const verifierTask = await h.bundle.get("verifier-criteria", "task");
    expect(verifierTask?.metadata).toEqual({ source: "content", readonly: false });

    const stage = await h.bundle.get("workflow-stages", "init");
    expect((stage?.value as { agent: string }).agent).toBe("scout");

    const repo = await h.bundle.get("repos", "sample");
    // 2026-05-20: yaml-sourced rows are now editable from the UI; the
    // seed mirror writes `readonly: false` so the App can override
    // without restarting the engine. Source stays `yaml` until the
    // first UI edit flips it to `ui` (per `buildNextMetadata`).
    expect(repo?.metadata).toEqual({ source: "yaml", readonly: false });

    const defaultsRow = await h.bundle.get("engine-defaults", "global");
    expect(defaultsRow?.metadata).toEqual({ source: "content", readonly: false });
    expect((defaultsRow?.value as { schedules: { prReviewMinutes: number } }).schedules.prReviewMinutes).toBe(5);

    const providerRow = await h.bundle.get("agent-providers", "claude");
    expect((providerRow?.value as { command: string }).command).toBe("claude");

    const providerDefault = await h.bundle.get("agent-providers", "_default");
    expect((providerDefault?.value as { id: string }).id).toBe("claude");
  });

  it("preserves source:ui edits on second run while refreshing source:content baselines", async () => {
    writeMinimumContent(h.contentDir);
    writeRepos(h.configDir, ["sample"]);
    await seed(h.bundle, { configDir: h.configDir }, makeCtx(), silentLogger());

    // User-edited row (source: ui) must never be clobbered.
    await h.bundle.put("prompts", "creator", { topic: "creator", body: "edited body" }, {
      metadata: { source: "ui", readonly: false },
    });

    await seed(h.bundle, { configDir: h.configDir }, makeCtx(), silentLogger());

    // User row preserved verbatim.
    const creator = await h.bundle.get("prompts", "creator");
    expect((creator?.value as { body: string }).body).toBe("edited body");
    expect(creator?.metadata).toEqual({ source: "ui", readonly: false });

    // Source:content baseline refreshes from the shipped md on boot so
    // shipped prompt edits propagate without a manual --reseed.
    const contextBase = await h.bundle.get("prompts", "context/base");
    expect(contextBase?.metadata?.source).toBe("content");
    expect((contextBase?.value as { body: string }).body).toContain("Base context");
  });

  it("force-overwrites categories named in reseedCategories", async () => {
    writeMinimumContent(h.contentDir);
    writeRepos(h.configDir, ["sample"]);
    await seed(h.bundle, { configDir: h.configDir }, makeCtx(), silentLogger());

    await h.bundle.put("prompts", "creator", { topic: "creator", body: "edited" }, {
      metadata: { source: "ui", readonly: false },
    });

    const result = await seed(
      h.bundle,
      { configDir: h.configDir, reseedCategories: new Set(["prompts"]) },
      makeCtx(),
      silentLogger(),
    );

    expect(result.seededOnce.prompts).toBe(2);
    const creator = await h.bundle.get("prompts", "creator");
    expect((creator?.value as { body: string }).body).toContain("Creator prompt");
    expect(creator?.metadata).toEqual({ source: "content", readonly: false });
  });

  it("refreshes overwriteContentOnBoot categories on each boot", async () => {
    writeMinimumContent(h.contentDir);
    writeRepos(h.configDir, ["sample"]);
    await seed(h.bundle, { configDir: h.configDir }, makeCtx(), silentLogger());

    const before = await h.bundle.get("agent-providers", "claude");
    expect((before?.value as { promptFromStdin?: boolean }).promptFromStdin).toBeUndefined();

    // Simulate a yaml update on disk that introduces a new provider field.
    const providersPath = join(h.contentDir, "defaults", "agents.yaml");
    const patched = readFileSync(providersPath, "utf-8").replace(
      "    command: claude",
      "    command: claude\n    promptFromStdin: true",
    );
    writeFileSync(providersPath, patched);

    await seed(h.bundle, { configDir: h.configDir }, makeCtx(), silentLogger());

    const after = await h.bundle.get("agent-providers", "claude");
    expect((after?.value as { promptFromStdin?: boolean }).promptFromStdin).toBe(true);
    expect(after?.metadata?.source).toBe("content");
  });

  it("overwriteContentOnBoot does not clobber source:ui rows", async () => {
    writeMinimumContent(h.contentDir);
    writeRepos(h.configDir, ["sample"]);
    await seed(h.bundle, { configDir: h.configDir }, makeCtx(), silentLogger());

    // User edited the provider row through the UI (Step 16 write path).
    await h.bundle.put("agent-providers", "claude", {
      id: "claude", command: "claude-user-custom",
    }, { metadata: { source: "ui", readonly: false } });

    await seed(h.bundle, { configDir: h.configDir }, makeCtx(), silentLogger());

    const row = await h.bundle.get("agent-providers", "claude");
    expect((row?.value as { command: string }).command).toBe("claude-user-custom");
    expect(row?.metadata?.source).toBe("ui");
  });

  it("reseedCategories with 'all' overwrites every seed-once category", async () => {
    writeMinimumContent(h.contentDir);
    writeRepos(h.configDir, ["sample"]);
    await seed(h.bundle, { configDir: h.configDir }, makeCtx(), silentLogger());

    const result = await seed(
      h.bundle,
      { configDir: h.configDir, reseedCategories: new Set(["all"]) },
      makeCtx(),
      silentLogger(),
    );

    expect(result.seededOnce.prompts).toBeGreaterThan(0);
    expect(result.seededOnce["agent-roles"]).toBeGreaterThan(0);
  });

  it("removes yaml-sourced repos that disappeared from yaml (seed-mirror delete)", async () => {
    writeMinimumContent(h.contentDir);
    writeRepos(h.configDir, ["sample", "alpha"]);
    await seed(h.bundle, { configDir: h.configDir }, makeCtx(), silentLogger());
    expect((await h.bundle.list("repos")).map((r) => r.key).sort()).toEqual(["alpha", "sample"]);

    writeRepos(h.configDir, ["sample"]);
    const result = await seed(h.bundle, { configDir: h.configDir }, makeCtx(), silentLogger());
    expect(result.mirrored.deleted).toBe(1);
    expect((await h.bundle.list("repos")).map((r) => r.key)).toEqual(["sample"]);
  });

  it("preserves UI-sourced repos during seed-mirror reconciliation", async () => {
    writeMinimumContent(h.contentDir);
    writeRepos(h.configDir, ["sample"]);
    await seed(h.bundle, { configDir: h.configDir }, makeCtx(), silentLogger());

    await h.bundle.put("repos", "ui-managed", {
      id: "ui-managed",
      vcs: { platform: "github", repo: "x/y", branch: "main", tokenEnvVar: "T" },
    }, { metadata: { source: "ui", readonly: false } });

    await seed(h.bundle, { configDir: h.configDir }, makeCtx(), silentLogger());
    const rows = await h.bundle.list("repos");
    expect(rows.map((r) => r.key).sort()).toEqual(["sample", "ui-managed"]);
    const ui = rows.find((r) => r.key === "ui-managed");
    expect(ui?.metadata).toEqual({ source: "ui", readonly: false });
  });

  it("throws SEED_VALIDATION on invalid stages.yaml", async () => {
    writeMinimumContent(h.contentDir);
    writeFile(
      join(h.contentDir, "prompts/stages.yaml"),
      "stages:\n  - name: broken\n    # missing required fields\n",
    );
    writeRepos(h.configDir, ["sample"]);

    await expect(seed(h.bundle, { configDir: h.configDir }, makeCtx(), silentLogger())).rejects.toThrow(
      /SEED_VALIDATION|Seed validation failed/,
    );
  });

  it("skips seed-mirror when repos.yaml is missing", async () => {
    writeMinimumContent(h.contentDir);

    const log = silentLogger();
    const result = await seed(h.bundle, { configDir: h.configDir }, makeCtx(), log);
    expect(result.mirrored).toEqual({ upserted: 0, deleted: 0 });
    expect(log.messages.some((m) => m.level === "warn" && m.msg.includes("missing"))).toBe(true);
  });

  // 2026-05-20 (Phase 5 P-502 partial): once a yaml-sourced row is
  // edited via the UI, its `source` flips to `ui` and the seed mirror
  // must leave it alone on subsequent boots — otherwise the App's
  // edits get clobbered every time the engine restarts.
  it("preserves UI-owned repos rows on re-mirror (UI takes ownership)", async () => {
    writeMinimumContent(h.contentDir);
    writeRepos(h.configDir, ["sample"]);

    // First seed run lands the yaml row.
    await seed(h.bundle, { configDir: h.configDir }, makeCtx(), silentLogger());

    // Simulate a UI edit: rewrite the row with `source: ui` and a
    // different value (mimics what `applyPut` would do).
    await h.bundle.put("repos", "sample", {
      id: "sample", debug: true,
      vcs: { platform: "github", repo: "owner/repo", branch: "main", tokenEnvVar: "T" },
      features: { prReview: false }, // user disabled pr-review via UI
    }, {
      metadata: { source: "ui", readonly: false, version: 2 },
    });

    // Second seed pass — yaml still says prReview-enabled, but the
    // UI-owned row must win.
    await seed(h.bundle, { configDir: h.configDir }, makeCtx(), silentLogger());

    const repo = await h.bundle.get("repos", "sample");
    expect(repo?.metadata?.source).toBe("ui");
    expect((repo?.value as { features: { prReview: boolean } }).features.prReview).toBe(false);
  });
});
