import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OperatorConfig, ProjectConfig } from "@operator/core";
import { LocalStorageBundle } from "@operator/adapters/kvstore-sqlite";
import { KVBackedKindRegistry } from "@operator/adapters/kind-registry";
import { seed } from "./storage/seed.js";
import { Engine } from "./engine/engine.js";
import type { EngineDeps } from "./engine/engine.js";
import type { ActionResult } from "./engine/project-runner.js";
import { buildTestDispatchRegistry } from "./test-helpers/test-dispatch-registry.js";
import { TestIdempotencyGuard } from "./test-helpers/test-idempotency-guard.js";
import { createLogger } from "./logging/logger.js";
import { TestVCSPlatform } from "./test-helpers/test-vcs-platform.js";
import { TestStateManager } from "./test-helpers/test-state-manager.js";

/**
 * Step 18 smoke test — v5 regression baseline.
 *
 * Boots the full v5 composition against a throwaway SQLite file plus an
 * in-memory VCS + state fake. Exercises: seed.ts two-pass → KV populated,
 * KVBackedKindRegistry.fromKV → kinds loaded, Engine.runOnce → repos
 * enumerated from `kv:repos/*`, prepareWorkspace + syncWorkspace + one
 * action invocation. If any of the layers regresses (composition root,
 * seed schema drift, engine loop iteration, bundle close-after-seed),
 * this test fails immediately — the v4 "tests pass while end-to-end is
 * broken for days" pattern is now caught in CI.
 *
 * The agent runtime, git, and GitHub clients are deliberately excluded:
 * this is a structural smoke, not an integration test. End-to-end
 * coverage against a real repo runs via `npm run exec` (see deployment.md).
 */

let tmpRoot: string;
let bundle: LocalStorageBundle;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "operator-smoke-"));
  bundle = new LocalStorageBundle({ dbPath: join(tmpRoot, "operator.db") });
});

afterEach(() => {
  bundle.close();
  rmSync(tmpRoot, { recursive: true, force: true });
});

function smokeCtx() {
  return {
    traceId: "smoke-trace",
    repoId: "*",
    action: "cycle",
    budget: { spentUsd: 0, add: () => {}, isExceeded: () => false },
    signal: AbortSignal.timeout(30_000),
  };
}

describe("smoke: engine boot + one cycle", () => {
  it("seed populates every shipped category from engine/content", async () => {
    const log = createLogger("warn");

    // Seed-mirror reads `<configDir>/repos.yaml`. The real instance file is
    // gitignored (local-only), so the smoke test mirrors from the committed
    // `config/repos.yaml.example` copied into a temp config dir — this keeps
    // the assertion working on a fresh clone / CI checkout where no local
    // `config/repos.yaml` exists.
    const configDir = join(tmpRoot, "config");
    mkdirSync(configDir, { recursive: true });
    copyFileSync(
      join(process.cwd(), "config", "repos.yaml.example"),
      join(configDir, "repos.yaml"),
    );

    const result = await seed(bundle, { configDir }, smokeCtx(), log);

    // Every seed-once category emitted at least one row. This catches
    // silent seed-source loader breakage (empty directory, yaml parse
    // error caught and swallowed) before any stage code runs.
    expect(result.seededOnce["prompts"]).toBeGreaterThan(0);
    expect(result.seededOnce["templates"]).toBeGreaterThan(0);
    expect(result.seededOnce["workflow-stages"]).toBeGreaterThan(0);
    expect(result.seededOnce["work-item-kinds"]).toBeGreaterThan(0);
    expect(result.seededOnce["agent-roles"]).toBeGreaterThan(0);
    expect(result.seededOnce["agent-providers"]).toBeGreaterThan(0);
    expect(result.seededOnce["engine-defaults"]).toBeGreaterThan(0);
    expect(result.seededOnce["verifier-criteria"]).toBeGreaterThan(0);
    expect(result.seededOnce["analyzers"]).toBeGreaterThanOrEqual(0);

    // Seed-mirror mirrored the committed `config/repos.yaml.example`
    // template (copied to the temp config dir above) — it always has at
    // least one entry.
    expect(result.mirrored.upserted).toBeGreaterThan(0);
  });

  it("KindRegistry.fromKV loads every shipped kind after seed", async () => {
    const log = createLogger("warn");
    await seed(bundle, { configDir: join(process.cwd(), "config") }, smokeCtx(), log);

    const registry = await KVBackedKindRegistry.fromKV(bundle, smokeCtx());

    // The three shipped kinds must resolve end-to-end. A missing kind
    // here means the kinds.yaml seed path drifted from the schema.
    const names = registry.all.map((k) => k.name).sort();
    expect(names).toContain("finding");
    expect(names).toContain("task");
    expect(names).toContain("request");

    // Registry-driven ID generation actually works — not just the types.
    const taskId = await registry.generateId("task", "20260418");
    expect(taskId).toMatch(/^T20260418-[0-9A-F]{8}$/);
  });

  it("Engine.runOnce completes a cycle against the seeded KV", async () => {
    const log = createLogger("warn");
    await seed(bundle, { configDir: join(process.cwd(), "config") }, smokeCtx(), log);

    const vcs = new TestVCSPlatform();
    const state = new TestStateManager();
    const actionCalls: string[] = [];

    const smokeProject: ProjectConfig = {
      id: "smoke",
      vcs: { platform: "github", repo: "smoke/smoke", branch: "master", tokenEnvVar: "NONE" },
    };

    // Minimal OperatorConfig — every required slot, zero surprises. The
    // engine reads `repos` through `enumerateRepos` below, so the static
    // field is only used for `defaults` / `conventions`.
    const config: OperatorConfig = {
      defaults: {
        schedules: {
          prReviewMinutes: 5, taskSelectMinutes: 15, findingSelectMinutes: 30,
          improverDayOfWeek: 1,
        },
        limits: { maxReviewAttempts: 5 },
        review: { ignoredBotLogins: [] },
      },
      conventions: {
        labels: { pending: "ai:pending", processing: "ai:processing", inReview: "ai:in-review", readyToMerge: "ai:ready-to-merge", failed: "ai:failed" },
        branches: { aiPrefix: "ai", init: "ai/init", tasks: "ai/tasks", findings: "ai/findings", research: "ai/research", improver: "ai/improver" },
        prPrefixes: { task: "[AI:Task]", finding: "[AI:Finding]", research: "[AI:Research]", improver: "[AI:Improver]", init: "[AI:Init]" },
        patterns: { taskId: "T{DATE}-{SEQ}", findingPrefix: "F" },
        commentMarker: "<!-- bot:operator -->",
      },
      repos: [],
    };

    const deps: EngineDeps = {
      config,
      state,
      bus: { emit: async () => {}, on: () => {} },
      guard: new TestIdempotencyGuard(),
      createVCS: () => vcs,
      resolveWorkspace: () => join(tmpRoot, "workspace"),
      prepareWorkspace: async () => {},
      syncWorkspace: async () => {},
      enumerateRepos: async () => [smokeProject],
      dispatchRegistry: buildTestDispatchRegistry(config.defaults),
      executeAction: async (action): Promise<ActionResult> => {
        actionCalls.push(action);
        return { action, status: "skipped", message: "smoke: no-op" };
      },
    };

    const engine = new Engine(deps);
    const result = await engine.runOnce(smokeCtx());

    // Cycle must enumerate exactly the one repo we seeded through the
    // callback and record a ProjectRunResult for it.
    expect(result.projects).toHaveLength(1);
    expect(result.projects[0].projectId).toBe("smoke");

    // At least one action dispatch reached `executeAction` — otherwise
    // the cycle short-circuited before the run-loop and the assertion
    // caught the v4 "no stages ran this cycle" regression.
    expect(actionCalls.length).toBeGreaterThan(0);

    // All recorded actions are in a known status vocabulary. This
    // catches a malformed ActionResult that used to leak undefined.
    for (const action of result.projects[0].actions) {
      expect(["completed", "skipped", "failed"]).toContain(action.status);
    }
  });

  it("bundle close after seed leaves no locked handles", async () => {
    const log = createLogger("warn");
    await seed(bundle, { configDir: join(process.cwd(), "config") }, smokeCtx(), log);
    // Explicit close — on Windows this used to intermittently fail if the
    // WAL/SHM handles were still live. Mirrors the daemon shutdown path
    // in entry.ts. A throw here would surface as a flaky smoke.
    expect(() => bundle.close()).not.toThrow();
    // Re-open smoke — the DB file must be consumable by a second bundle
    // instance (proves no stale write lock).
    const reopened = new LocalStorageBundle({ dbPath: join(tmpRoot, "operator.db") });
    const rows = await reopened.list("work-item-kinds");
    expect(rows.length).toBeGreaterThan(0);
    reopened.close();
    // Rebind for the afterEach close — suppress double-close.
    bundle = new LocalStorageBundle({ dbPath: join(tmpRoot, "operator.db") });
  });
});
