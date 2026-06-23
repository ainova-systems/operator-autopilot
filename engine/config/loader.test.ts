import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OperationContext } from "@operator/core";
import { ConfigError } from "@operator/core";
import { LocalStorageBundle } from "@operator/adapters/kvstore-sqlite";
import { loadOperatorConfig, loadAgentsConfig } from "./loader.js";

function makeCtx(): OperationContext {
  return {
    traceId: "test-trace",
    repoId: "test-repo",
    action: "config-load",
    budget: { spentUsd: 0, add: vi.fn(), isExceeded: () => false },
    signal: AbortSignal.timeout(30_000),
  };
}

let dbDir: string;
let bundle: LocalStorageBundle;

beforeEach(async () => {
  dbDir = await mkdtemp(join(tmpdir(), "config-loader-"));
  bundle = new LocalStorageBundle({ dbPath: join(dbDir, "kv.db") });
});

afterEach(async () => {
  bundle.close();
  await rm(dbDir, { recursive: true, force: true });
});

const VALID_DEFAULTS = {
  schedules: {
    prReviewMinutes: 5,
    taskSelectMinutes: 15,
    findingSelectMinutes: 30,
    dailyResearchHour: 8,
    improverDayOfWeek: 1,
    prLifecycleMinutes: 15,
  },
  limits: { maxReviewAttempts: 25 },
  review: { ignoredBotLogins: ["github-actions[bot]"] },
  lifecycle: {
    promoteToReadyAfterIdleHours: 1,
    autoMergeReadyAfterHours: null,
    autoCloseStuckAfterHours: null,
  },
  labels: {
    pending: "ai:pending",
    processing: "ai:processing",
    inReview: "ai:in-review", readyToMerge: "ai:ready-to-merge",
    failed: "ai:failed",
    manual: "ai:manual",
  },
  conventions: {
    branches: {
      aiPrefix: "ai", init: "ai/init", tasks: "ai/tasks",
      findings: "ai/findings", research: "ai/research", improver: "ai/improver",
    },
    prPrefixes: {
      task: "[AI:Task]", finding: "[AI:Finding]", research: "[AI:Research]",
      improver: "[AI:Improver]", init: "[AI:Init]",
    },
    patterns: { taskId: "T[0-9]{8}-[0-9]{6}", findingPrefix: "F" },
    commentMarker: "<!-- bot:operator -->",
  },
};

async function seedValidDefaults(): Promise<void> {
  await bundle.put("engine-defaults", "global", VALID_DEFAULTS, {
    metadata: { source: "content", readonly: false },
  });
}

async function seedValidRepo(): Promise<void> {
  await bundle.put("repos", "sample", {
    id: "sample",
    vcs: { platform: "github", repo: "owner/sample", branch: "develop", tokenEnvVar: "GH_TOKEN" },
    features: { prReview: true, taskSelect: true },
    limits: { maxActiveTasks: 2 },
  }, { metadata: { source: "yaml", readonly: true } });
}

async function seedValidAgents(): Promise<void> {
  await bundle.put("agent-providers", "claude", {
    id: "claude",
    command: "claude",
    defaultArgs: ["--dangerously-skip-permissions"],
    promptArg: "-p",
    outputMode: "stdout",
  });
  await bundle.put("agent-providers", "_default", {
    id: "claude",
    command: "claude",
  });
  await bundle.put("agent-roles", "creator", {
    name: "creator",
    provider: "claude",
    instructions: "agents/creator.md",
    timeout: 3600,
    model: "opus",
    maxBudget: 15.0,
  });
}

describe("loadOperatorConfig", () => {
  it("loads defaults + repos from KV", async () => {
    await seedValidDefaults();
    await seedValidRepo();

    const config = await loadOperatorConfig(makeCtx(), "ignored", bundle);

    expect(config.defaults.schedules.prReviewMinutes).toBe(5);
    expect(config.defaults.limits.maxReviewAttempts).toBe(25);
    expect(config.conventions.labels.pending).toBe("ai:pending");
    expect(config.conventions.branches.aiPrefix).toBe("ai");
    expect(config.conventions.commentMarker).toBe("<!-- bot:operator -->");
    expect(config.repos).toHaveLength(1);
    expect(config.repos[0].id).toBe("sample");
    expect(config.repos[0].vcs.repo).toBe("owner/sample");
  });

  it("propagates the per-repo debug flag from KV to ProjectConfig", async () => {
    await seedValidDefaults();
    await bundle.put("repos", "sample", {
      id: "sample", debug: true,
      vcs: { platform: "github", repo: "owner/sample", branch: "develop", tokenEnvVar: "GH_TOKEN" },
    }, { metadata: { source: "yaml", readonly: true } });
    await bundle.put("repos", "plain", {
      id: "plain",
      vcs: { platform: "github", repo: "owner/plain", branch: "main", tokenEnvVar: "GH_TOKEN" },
    }, { metadata: { source: "yaml", readonly: true } });

    const config = await loadOperatorConfig(makeCtx(), "ignored", bundle);

    const sample = config.repos.find((r) => r.id === "sample");
    const plain = config.repos.find((r) => r.id === "plain");
    expect(sample?.debug).toBe(true);
    expect(plain?.debug).toBeUndefined();
  });

  it("throws ConfigError when engine-defaults/global is missing", async () => {
    await seedValidRepo();
    await expect(loadOperatorConfig(makeCtx(), "ignored", bundle))
      .rejects.toThrow(ConfigError);
  });

  it("returns an empty repos list when no repos are seeded", async () => {
    await seedValidDefaults();
    const config = await loadOperatorConfig(makeCtx(), "ignored", bundle);
    expect(config.repos).toEqual([]);
  });

  it("preserves optional tracker config", async () => {
    await seedValidDefaults();
    await bundle.put("repos", "test", {
      id: "test",
      vcs: { platform: "github", repo: "owner/test", branch: "main", tokenEnvVar: "TOKEN" },
      tracker: { platform: "jira", project: "TEST" },
    }, { metadata: { source: "yaml", readonly: true } });

    const config = await loadOperatorConfig(makeCtx(), "ignored", bundle);
    expect(config.repos[0].tracker?.platform).toBe("jira");
    expect(config.repos[0].tracker?.project).toBe("TEST");
  });
});

describe("loadAgentsConfig", () => {
  it("materialises the agents document from KV rows", async () => {
    await seedValidAgents();

    const config = await loadAgentsConfig(makeCtx(), "ignored", bundle);
    expect(config.defaultProvider).toBe("claude");
    expect(config.providers["claude"].command).toBe("claude");
    expect(config.agents["creator"].timeout).toBe(3600);
    expect(config.agents["creator"].maxBudget).toBe(15.0);
  });

  it("falls back to the 'claude' default provider when no _default row is seeded", async () => {
    await bundle.put("agent-providers", "claude", { id: "claude", command: "claude" });
    await bundle.put("agent-roles", "creator", {
      name: "creator", provider: "claude", instructions: "agents/creator.md", timeout: 600,
    });

    const config = await loadAgentsConfig(makeCtx(), "ignored", bundle);
    expect(config.defaultProvider).toBe("claude");
  });

  it("throws ConfigError when KV rows fail validation", async () => {
    // Seed a provider without `command` via raw kv.put to bypass seed validation.
    await bundle.put("agent-providers", "broken", { id: "broken" });
    await bundle.put("agent-roles", "creator", {
      name: "creator", provider: "broken", instructions: "agents/creator.md", timeout: 600,
    });

    await expect(loadAgentsConfig(makeCtx(), "ignored", bundle))
      .rejects.toThrow(ConfigError);
  });

  it("throws ConfigError with KV_ROW_INVALID code for a corrupted agent-roles row", async () => {
    // Missing required `provider` — simulates a user edit that bypassed the API.
    await bundle.put("agent-providers", "claude", { id: "claude", command: "claude" });
    await bundle.put("agent-roles", "creator", {
      name: "creator",
      instructions: "agents/creator.md",
    });

    await expect(loadAgentsConfig(makeCtx(), "ignored", bundle))
      .rejects.toThrow(/agent-roles\/creator/);
  });
});

describe("loadOperatorConfig read-boundary validation", () => {
  it("throws ConfigError when engine-defaults/global is malformed", async () => {
    await bundle.put("engine-defaults", "global", { schedules: {} });
    await expect(loadOperatorConfig(makeCtx(), "ignored", bundle))
      .rejects.toThrow(/engine-defaults\/global/);
  });

  it("throws ConfigError when a repos row is malformed", async () => {
    await seedValidDefaults();
    await bundle.put("repos", "broken", { id: "broken" /* missing vcs block */ });
    await expect(loadOperatorConfig(makeCtx(), "ignored", bundle))
      .rejects.toThrow(/repos\/broken/);
  });
});
