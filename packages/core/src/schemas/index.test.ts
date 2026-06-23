import { describe, it, expect } from "vitest";
import { load as parseYaml } from "js-yaml";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  kvSchemas,
  promptSchema,
  templateSchema,
  agentRoleSchema,
  workflowStageSchema,
  workItemKindSchema,
  analyzerSchema,
  verifierCriteriaSchema,
  engineDefaultsSchema,
  agentProviderSchema,
  repoSchema,
  repoFeaturesSchema,
  metadataSchema,
} from "./index.js";

/** Resolve engine/content path relative to this test file. */
const contentDir = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "..",
  "engine",
  "content",
);

describe("kvSchemas registry", () => {
  it("exposes every category with a Zod schema", () => {
    expect(Object.keys(kvSchemas).sort()).toEqual([
      "agent-providers",
      "agent-roles",
      "analyzers",
      "engine-defaults",
      "execution-events",
      "execution-logs",
      "executions",
      "instances",
      "pr-states",
      "prompts",
      "repos",
      "templates",
      "verifier-criteria",
      "work-item-kinds",
      "work-items",
      "work-items-virtual",
      "workflow-stages",
      "workspace-init",
    ]);
    for (const schema of Object.values(kvSchemas)) {
      expect(typeof schema.parse).toBe("function");
    }
  });
});

describe("metadataSchema", () => {
  it("accepts content/yaml/ui source values", () => {
    for (const source of ["content", "yaml", "ui"] as const) {
      const parsed = metadataSchema.parse({ source, readonly: false });
      expect(parsed.source).toBe(source);
    }
  });

  it("rejects unknown source values", () => {
    expect(() => metadataSchema.parse({ source: "unknown", readonly: false })).toThrow();
  });

  it("allows optional modifiedFromBaseline and version", () => {
    const parsed = metadataSchema.parse({
      source: "content",
      readonly: false,
      modifiedFromBaseline: true,
      version: 3,
    });
    expect(parsed.version).toBe(3);
  });
});

describe("promptSchema", () => {
  it("validates a minimal prompt entry", () => {
    const parsed = promptSchema.parse({ topic: "agents/creator", body: "You are a creator." });
    expect(parsed.topic).toBe("agents/creator");
  });

  it("rejects empty topic", () => {
    expect(() => promptSchema.parse({ topic: "", body: "x" })).toThrow();
  });
});

describe("templateSchema", () => {
  it("validates a minimal template entry", () => {
    const parsed = templateSchema.parse({ name: "task-pr-body", body: "## Task {ID}" });
    expect(parsed.name).toBe("task-pr-body");
  });
});

describe("agentRoleSchema", () => {
  it("validates a full agent role from defaults/agents.yaml", () => {
    const parsed = agentRoleSchema.parse({
      name: "creator",
      provider: "claude",
      description: "Creates changes",
      instructions: "agents/creator.md",
      timeout: 3600,
      model: "opus",
      review: true,
      tools: "Read,Grep,Glob,Bash,Edit,Write",
      maxBudget: 15,
      context: ["base"],
    });
    expect(parsed.timeout).toBe(3600);
  });

  it("rejects non-positive timeout", () => {
    expect(() =>
      agentRoleSchema.parse({
        name: "creator",
        provider: "claude",
        instructions: "agents/creator.md",
        timeout: 0,
      }),
    ).toThrow();
  });
});

describe("workflowStageSchema", () => {
  it("validates a gated stage with per-item selector and code-changes sink", () => {
    const parsed = workflowStageSchema.parse({
      name: "task-execute",
      agent: "creator",
      selector: "per-item",
      selectorConfig: { kind: "task", status: "pending" },
      merge: "gated",
      branchScope: "per-item",
      branchPrefix: "ai/tasks",
      maxActive: 2,
      schedule: "*/5 * * * *",
      enabled: true,
      inputSource: {
        kind: "task",
        status: "pending",
        recoveryPolicy: "reset-failed-to-pending",
        vars: { TASK_ID: "${item.id}" },
      },
      outputSink: {
        parser: "code-changes",
        commitMode: "code-changes",
        prTemplate: "task-pr-body.md",
      },
      reviewEnabled: true,
    });
    expect(parsed.merge).toBe("gated");
    expect(parsed.outputSink.parser).toBe("code-changes");
    expect(parsed.inputSource?.recoveryPolicy).toBe("reset-failed-to-pending");
  });

  it("accepts merge as explicit conditions object with multi-document sink", () => {
    const parsed = workflowStageSchema.parse({
      name: "research",
      agent: "analyst",
      selector: "discovery",
      merge: { requireHuman: false, requireCIGreen: true, requireVerifierApproval: true },
      branchScope: "singleton",
      schedule: "0 8 * * *",
      enabled: true,
      inputSource: { iterate: "analyzerItems" },
      outputSink: {
        kind: "finding",
        parser: "multi-document",
        commitMode: "work-item-files",
      },
      reviewEnabled: false,
    });
    expect(typeof parsed.merge).toBe("object");
    expect(parsed.outputSink.kind).toBe("finding");
    expect(parsed.reviewEnabled).toBe(false);
  });

  it("rejects unknown selector value", () => {
    expect(() =>
      workflowStageSchema.parse({
        name: "x",
        agent: "y",
        selector: "bogus",
        merge: "gated",
        branchScope: "per-item",
        schedule: "*/5 * * * *",
        enabled: true,
        outputSink: { parser: "code-changes", commitMode: "code-changes" },
        reviewEnabled: true,
      }),
    ).toThrow();
  });

  it("rejects unknown parser value on outputSink", () => {
    expect(() =>
      workflowStageSchema.parse({
        name: "x", agent: "y", selector: "per-item",
        merge: "gated", branchScope: "per-item",
        schedule: "*/5 * * * *", enabled: true,
        outputSink: { parser: "bogus", commitMode: "code-changes" },
        reviewEnabled: true,
      }),
    ).toThrow();
  });

  it("requires outputSink and reviewEnabled", () => {
    expect(() =>
      workflowStageSchema.parse({
        name: "x", agent: "y", selector: "per-item",
        merge: "gated", branchScope: "per-item",
        schedule: "*/5 * * * *", enabled: true,
      }),
    ).toThrow();
  });
});

describe("workItemKindSchema", () => {
  it("validates the finding kind", () => {
    const parsed = workItemKindSchema.parse({
      name: "finding",
      label: "Finding",
      idPrefix: "F",
      dataDir: "findings",
      branchPrefix: "ai/findings",
      prPrefix: "[AI:Finding]",
      terminalStatuses: ["completed", "failed", "rejected", "duplicate"],
    });
    expect(parsed.terminalStatuses).toContain("completed");
  });

  it("rejects empty terminalStatuses", () => {
    expect(() =>
      workItemKindSchema.parse({
        name: "finding",
        label: "Finding",
        idPrefix: "F",
        dataDir: "findings",
        branchPrefix: "ai/findings",
        prPrefix: "[AI:Finding]",
        terminalStatuses: [],
      }),
    ).toThrow();
  });
});

describe("analyzerSchema", () => {
  it("validates minimal analyzer", () => {
    const parsed = analyzerSchema.parse({ id: "security", title: "Security", body: "..." });
    expect(parsed.id).toBe("security");
  });
});

describe("verifierCriteriaSchema", () => {
  it("validates verifier criteria entry", () => {
    const parsed = verifierCriteriaSchema.parse({ stageName: "task-execute", body: "Check..." });
    expect(parsed.stageName).toBe("task-execute");
  });
});

describe("engineDefaultsSchema", () => {
  it("validates a full defaults document", () => {
    const parsed = engineDefaultsSchema.parse({
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
        inReview: "ai:in-review",
        readyToMerge: "ai:ready-to-merge",
        failed: "ai:failed",
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
    });
    expect(parsed.schedules.prReviewMinutes).toBe(5);
  });

  it("rejects out-of-range dailyResearchHour", () => {
    expect(() =>
      engineDefaultsSchema.parse({
        schedules: {
          prReviewMinutes: 5, taskSelectMinutes: 15, findingSelectMinutes: 30,
          dailyResearchHour: 25, improverDayOfWeek: 1, prLifecycleMinutes: 15,
        },
        limits: { maxReviewAttempts: 25 },
        review: { ignoredBotLogins: [] },
        lifecycle: { promoteToReadyAfterIdleHours: 1 },
        labels: { pending: "p", processing: "p", inReview: "ir", readyToMerge: "rtm", failed: "f" },
        conventions: {
          branches: { aiPrefix: "ai", init: "ai/init", tasks: "ai/tasks", findings: "ai/findings", research: "ai/research", improver: "ai/improver" },
          prPrefixes: { task: "t", finding: "f", research: "r", improver: "i", init: "n" },
          patterns: { taskId: "x", findingPrefix: "F" },
          commentMarker: "m",
        },
      }),
    ).toThrow();
  });
});

describe("agentProviderSchema", () => {
  it("validates a minimal provider", () => {
    const parsed = agentProviderSchema.parse({ id: "claude", command: "claude" });
    expect(parsed.id).toBe("claude");
  });

  it("rejects unknown outputMode", () => {
    expect(() => agentProviderSchema.parse({
      id: "x", command: "y", outputMode: "stream",
    })).toThrow();
  });
});

describe("repoSchema", () => {
  it("validates a flat-branch repo shape", () => {
    const parsed = repoSchema.parse({
      id: "sample",
      debug: true,
      vcs: {
        platform: "github",
        repo: "owner/sample",
        branch: "develop",
        tokenEnvVar: "MANAGED_REPO_GH_TOKEN",
      },
      features: { prReview: true, taskSelect: true, taskExecute: true },
      limits: { maxActiveTasks: 2, maxActiveFindings: 2 },
    });
    expect(parsed.vcs.repo).toBe("owner/sample");
    expect(parsed.vcs.branch).toBe("develop");
  });

  it("accepts any branch name (main, master, trunk, custom)", () => {
    for (const branch of ["main", "master", "trunk", "feature/long-running"]) {
      const parsed = repoSchema.parse({
        id: "r",
        vcs: { platform: "github", repo: "o/r", branch, tokenEnvVar: "T" },
      });
      expect(parsed.vcs.branch).toBe(branch);
    }
  });

  it("rejects empty branch name", () => {
    expect(() =>
      repoSchema.parse({
        id: "r",
        vcs: { platform: "github", repo: "o/r", branch: "", tokenEnvVar: "T" },
      }),
    ).toThrow();
  });

  it("rejects non-github platform", () => {
    expect(() =>
      repoSchema.parse({
        id: "x",
        vcs: { platform: "gitlab", repo: "x/x", branch: "main", tokenEnvVar: "T" },
      }),
    ).toThrow();
  });

  // Regression: `issueSync` was a dead feature flag — present in the schema,
  // type, and example config, but no stage's `dispatch.featureFlags` ever
  // gated on it. Removed 2026-06-18. It is no longer part of the features
  // contract, so the schema strips it (along with any other unknown flag)
  // instead of carrying it through — a persisted `kv:repos/*` row that still
  // holds the legacy key must validate, not crash boot.
  it("strips the removed issueSync feature flag", () => {
    const parsed = repoFeaturesSchema.parse({ prReview: true, issueSync: true });
    expect(parsed).not.toHaveProperty("issueSync");
    expect(parsed.prReview).toBe(true);
  });

  it("strips an unknown feature flag but keeps the known ones", () => {
    const parsed = repoFeaturesSchema.parse({ improver: true, bogusFeature: true });
    expect(parsed).not.toHaveProperty("bogusFeature");
    expect(parsed.improver).toBe(true);
  });

  it("accepts the known feature flags", () => {
    const parsed = repoFeaturesSchema.parse({
      prReview: true,
      taskSelect: false,
      taskExecute: true,
      dailyResearch: false,
      improver: true,
      findingSelect: true,
      findingExecute: false,
    });
    expect(parsed.prReview).toBe(true);
  });
});

// ── Round-trip tests: shipped yaml must parse through its schema ────────

describe("round-trip — shipped content files parse through their schemas", () => {
  it("engine/content/defaults/agents.yaml → agentRoleSchema per entry", async () => {
    const body = await readFile(join(contentDir, "defaults", "agents.yaml"), "utf-8");
    const parsed = parseYaml(body) as { agents: Record<string, unknown> };
    expect(parsed.agents).toBeDefined();
    for (const [roleName, cfg] of Object.entries(parsed.agents)) {
      const entry = { name: roleName, ...(cfg as object) };
      expect(() => agentRoleSchema.parse(entry)).not.toThrow();
    }
  });

  it("engine/content/defaults/agents.yaml → agentProviderSchema per provider", async () => {
    const body = await readFile(join(contentDir, "defaults", "agents.yaml"), "utf-8");
    const parsed = parseYaml(body) as { providers: Record<string, unknown> };
    expect(parsed.providers).toBeDefined();
    for (const [id, cfg] of Object.entries(parsed.providers)) {
      const entry = { id, ...(cfg as object) };
      expect(() => agentProviderSchema.parse(entry)).not.toThrow();
    }
  });

  it("engine/content/defaults/defaults.yaml → engineDefaultsSchema", async () => {
    const body = await readFile(join(contentDir, "defaults", "defaults.yaml"), "utf-8");
    const parsed = parseYaml(body);
    expect(() => engineDefaultsSchema.parse(parsed)).not.toThrow();
  });

  it("engine/content/prompts/stages.yaml → workflowStageSchema per entry", async () => {
    const body = await readFile(join(contentDir, "prompts", "stages.yaml"), "utf-8");
    const parsed = parseYaml(body) as { stages: unknown[] };
    expect(parsed.stages).toBeInstanceOf(Array);
    for (const stage of parsed.stages) {
      expect(() => workflowStageSchema.parse(stage)).not.toThrow();
    }
  });

  // Phase B Part 2 + 3 (2026-05-20): every shipped stage must carry both
  // a `dispatch` block (for the project-runner cron loop) and a
  // `composer` value (for the handler-builder lookup). The schema marks
  // both fields optional during the migration window so partial seeds
  // validate, but the SHIPPED seed must be complete or the engine boots
  // with stages that auto-fire have no handler / handlers that no cron
  // ever fires.
  it("engine/content/prompts/stages.yaml — every seeded stage carries dispatch + composer", async () => {
    const body = await readFile(join(contentDir, "prompts", "stages.yaml"), "utf-8");
    const parsed = parseYaml(body) as { stages: Array<{ name: string; dispatch?: unknown; composer?: string }> };
    for (const stage of parsed.stages) {
      expect(stage.dispatch, `stage ${stage.name} missing dispatch`).toBeDefined();
      expect(stage.composer, `stage ${stage.name} missing composer`).toBeDefined();
    }
  });

  it("engine/content/prompts/kinds.yaml → workItemKindSchema per entry", async () => {
    const body = await readFile(join(contentDir, "prompts", "kinds.yaml"), "utf-8");
    const parsed = parseYaml(body) as { kinds: Record<string, unknown> };
    expect(parsed.kinds).toBeDefined();
    for (const [name, cfg] of Object.entries(parsed.kinds)) {
      const entry = { name, ...(cfg as object) };
      expect(() => workItemKindSchema.parse(entry)).not.toThrow();
    }
  });

  it("config/repos.yaml.example → repoSchema per entry", async () => {
    // The shipped/tracked file is the generic example — `config/repos.yaml`
    // is gitignored, local-only instance config (real repo slug), absent in
    // CI. Round-tripping the committed example keeps this green everywhere.
    const body = await readFile(
      resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "config", "repos.yaml.example"),
      "utf-8",
    );
    const parsed = parseYaml(body) as { repos: unknown[] };
    expect(parsed.repos).toBeInstanceOf(Array);
    for (const repo of parsed.repos) {
      expect(() => repoSchema.parse(repo)).not.toThrow();
    }
  });
});
