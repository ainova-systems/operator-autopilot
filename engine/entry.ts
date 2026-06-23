/**
 * Entry point — composition root for Operator v5.
 *
 * Creates all concrete instances and wires local infrastructure.
 * This file is the ONE place that uses `new` on cross-layer classes;
 * everything else receives dependencies through constructor injection.
 */

import { resolve, join } from "node:path";
import { parseArgs, printHelp } from "./cli.js";
import { loadOperatorConfig, loadAgentsConfig } from "./config/loader.js";
import { loadEnv } from "./infra/env.js";
import { KVPromptSource } from "./agents/kv-prompt-source.js";
import { KVTemplateSource } from "./agents/kv-template-source.js";
import { resolveContentPath } from "./infra/content-path.js";
import { createConsole, contextLogger } from "./logging/logger.js";
import { SQLiteStateManager } from "./state/sqlite.js";
import { LocalIdempotencyGuard } from "./infra/local/sqlite-guard.js";
import { LocalStorageBundle } from "@operator/adapters/kvstore-sqlite";
import { KVBackedKindRegistry } from "@operator/adapters/kind-registry";
import { seed } from "./storage/seed.js";
import { InMemoryEventBus } from "./events/bus.js";
import { createOctokit, parseRepoSlug } from "./platforms/github/auth.js";
import { GitHubVCS } from "./platforms/github/vcs.js";
import { GitHubTracker } from "./platforms/github/tracker.js";
import { CLIAgentProvider } from "./agents/providers/cli.js";
import { resolveProviderConfig } from "./agents/roles.js";
import { AgentRuntime } from "./agents/runtime.js";
import { Engine } from "./engine/engine.js";
import { buildStageDispatchRegistryFromKV } from "./engine/kv-dispatch-registry.js";
import { buildStageHandler, type StageHandlerSharedDeps } from "./engine/stage-handlers.js";
import { Daemon } from "./daemon/daemon.js";
import { workspaceEnsure, workspaceSync } from "./infra/workspace.js";
import { ensureWorkspaceInit } from "./infra/workspace-init.js";
import { InstanceHeartbeat } from "./infra/instance-heartbeat.js";
import type { WorkspaceRepoInfo } from "./infra/workspace.js";
import { WorkspaceGit } from "./infra/git.js";
import { PRManager } from "./delivery/pr-manager.js";
import { cleanupBranches } from "./pipeline/cleanup.js";
import { runPrLifecycle } from "./pipeline/pr-lifecycle.js";
import { reconcileStuckExecutions, revertOrphanProcessingLabels } from "./pipeline/primitives/execution-reconcile.js";
import { syncFilesToState, buildStateContext } from "./work-items/work-items.js";
import { NotificationRouter } from "./communication/router.js";
import { GitHubChannel } from "./communication/channels/github.js";
import type { ProjectConfig, LifecycleConfig, WorkflowStageEntry } from "@operator/core";
import type { VCSPlatform } from "@operator/core";
import type { OperationContext } from "@operator/core";
import type { ActionName, ActionResult } from "./engine/project-runner.js";
import { operatorEngineVersion } from "./index.js";

/**
 * Read `scripts.init` from `<automationDir>/project.yaml`. Returns
 * undefined when the file is absent, malformed, or omits the field.
 * Tolerant by design — a managed repo without an init script is a
 * legitimate configuration (no native deps, fully self-contained).
 */
async function readProjectInitCommand(automationDir: string): Promise<string | undefined> {
  try {
    const { load } = await import("js-yaml");
    const { readFile } = await import("node:fs/promises");
    const text = await readFile(join(automationDir, "project.yaml"), "utf-8");
    const proj = load(text) as Record<string, unknown>;
    const scripts = proj.scripts as Record<string, string> | undefined;
    return scripts?.init;
  } catch {
    return undefined;
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);

  if (args.help) {
    console.log(printHelp());
    process.exit(0);
  }

  const env = loadEnv(resolve(args.configDir, ".."));
  // A fixed status footer is drawn only on an interactive TTY in long-lived
  // daemon mode. Every non-interactive run (CI, systemd, Docker, piped
  // stdout, --once) gets the unchanged JSON log stream and a no-op footer.
  const { logger, statusLine } = await createConsole({
    level: process.env.LOG_LEVEL === "debug" ? "debug" : "info",
    tty: process.stdout.isTTY === true,
    once: args.once,
    disableStatusLine: process.env.NO_STATUS_LINE === "1" || process.env.NO_STATUS_LINE === "true",
  });

  // Bound right after seed, when the KVStore is open. createCtx reads the
  // current id through closure so every ctx built after `start(...)` carries
  // the runner's `instanceId` for execution-row stamping.
  let heartbeat: InstanceHeartbeat | null = null;

  const createCtx = (): OperationContext => ({
    traceId: `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    repoId: args.repo || "*",
    action: args.force || "cycle",
    budget: { limitUsd: undefined, spentUsd: 0, add: () => {}, isExceeded: () => false },
    signal: AbortSignal.timeout(7_200_000),
    instanceId: heartbeat?.instanceId,
  });

  const ctx = createCtx();
  const log = contextLogger(logger, ctx);

  // Local infrastructure
  const { mkdirSync, rmSync } = await import("node:fs");
  const stateDir = resolve(env.operatorDir, "state");
  mkdirSync(stateDir, { recursive: true });

  // Shadow `node_modules` boundary at the workspace base. Stops Node module
  // resolution from walking up out of a managed clone into the operator's
  // own `node_modules/` (silent dependency shadowing if the managed repo's
  // own install is incomplete). The directory stays empty — it just blocks
  // the resolution walk-up.
  mkdirSync(resolve(env.workspaceBaseDir, "node_modules"), { recursive: true });

  log.info("Operator paths", {
    operatorDir: env.operatorDir,
    workspaceBaseDir: env.workspaceBaseDir,
    stateDir,
  });

  // Fresh DB: delete all SQLite files so DB is rebuilt from repo files
  if (args.freshDb) {
    for (const dbFile of ["operator.db", "operator.db-wal", "operator.db-shm", "guard.db", "guard.db-wal", "guard.db-shm"]) {
      try { rmSync(resolve(stateDir, dbFile)); } catch { /* file may not exist */ }
    }
    log.info("Fresh DB: deleted existing state files, will rebuild from repo data");
  }

  const state = new SQLiteStateManager(resolve(stateDir, "operator.db"));
  const guard = new LocalIdempotencyGuard(resolve(stateDir, "guard.db"));
  const storageBundle = new LocalStorageBundle({ dbPath: resolve(stateDir, "operator.db") });
  const seedResult = await seed(
    storageBundle,
    { configDir: args.configDir, reseedCategories: args.reseed },
    ctx,
    log,
  );
  log.info(
    `Seed complete: ${JSON.stringify(seedResult.seededOnce)} mirrored=${JSON.stringify(seedResult.mirrored)}`,
  );

  // Runtime config reads — always KV-backed after seed. `configDir` is the
  // seed-mirror baseline path only; loader ignores it for runtime reads.
  log.info("Loading configuration from KV...");
  const config = await loadOperatorConfig(ctx, args.configDir, storageBundle);
  const agentsConfig = await loadAgentsConfig(ctx, args.configDir, storageBundle);
  log.info(
    `Config loaded from KV: ${config.repos.length} repo(s), ${Object.keys(agentsConfig.agents).length} agent role(s), ${Object.keys(agentsConfig.providers).length} provider(s)`,
  );

  if (args.status) {
    console.log(JSON.stringify({ version: operatorEngineVersion, repos: config.repos.map((r) => r.id) }, null, 2));
    storageBundle.close();
    state.close();
    guard.close();
    process.exit(0);
  }

  // Register this run as a live `kv:instances/{id}` row only AFTER the
  // `--status` quick-exit branch, so query-mode invocations do not show
  // up as phantom runners in the App UI.
  heartbeat = new InstanceHeartbeat(storageBundle);
  await heartbeat.start({
    version: operatorEngineVersion,
    mode: args.once ? "once" : "daemon",
    repoFilter: args.repo,
    forceAction: args.force,
    operatorDir: env.operatorDir,
  }, ctx);
  log.info(`Instance ${heartbeat.instanceId} registered (mode=${args.once ? "once" : "daemon"})`);

  // Open kind registry — loaded from `kv:work-item-kinds/*` right after seed.
  // Throws at boot when the category is empty (architecture-v5.md §8.1).
  const kindRegistry = await KVBackedKindRegistry.fromKV(storageBundle, ctx);
  log.info(`Kind registry: ${kindRegistry.all.map((k) => k.name).join(", ")} (${kindRegistry.all.length} kind(s))`);

  // Drop every active (non-completed) lock left by a previous daemon
  // process. Agent locks have multi-hour TTLs (timeoutMs × maxRetries
  // ≈ 3h for creator), so a kill mid-acquire leaves rows that refuse
  // every new acquire until natural expiry. The current process holds
  // the only PID that could legitimately own any lock.
  const clearedLocks = await guard.clearActiveLocks(ctx);
  if (clearedLocks > 0) {
    log.warn(`Boot: cleared ${clearedLocks} stale lock(s) from prior daemon`, {
      cleared: clearedLocks,
    });
  } else {
    log.info(`Boot: lock table clean (no stale locks)`);
  }

  // Finalise any executions left in `status: running` by a previous
  // daemon process. At boot the current process holds the only PID
  // that could have been writing to this KV — any still-running row
  // is an orphan (crash / kill / ungraceful shutdown), so the
  // threshold is 0.
  const reconcileResult = await reconcileStuckExecutions(
    storageBundle, { stuckAfterMs: 0 }, ctx, log,
  );
  if (reconcileResult.reconciled > 0) {
    log.warn(`Boot: finalised ${reconcileResult.reconciled} orphaned execution(s) as timed-out`, {
      scanned: reconcileResult.scanned, reconciled: reconcileResult.reconciled,
    });
  } else {
    log.info(`Boot: execution-reconcile clean (scanned ${reconcileResult.scanned}, no orphans)`);
  }

  // Sweep open PRs whose `ai:processing` label survived a daemon kill.
  // The runStage `finally` block flips the label on cycle-internal
  // failures, but a forced process termination (Stop-Process / SIGKILL,
  // OOM, host reboot) skips it. At boot every `ai:processing` PR is by
  // definition orphaned because no cycle is in flight yet. One sweep
  // per repo, in parallel.
  await Promise.all(config.repos.map(async (project) => {
    const repoLog = log; // single root logger; per-repo binding lives inside primitive via ctx.repoId
    const token = process.env[project.vcs.tokenEnvVar] || "";
    const octokit = createOctokit(token, logger);
    const { owner, repo } = parseRepoSlug(project.vcs.repo);
    const repoVcs = new GitHubVCS(octokit, owner, repo);
    const repoCtx: OperationContext = { ...ctx, repoId: project.id, action: "boot-reconcile" };
    try {
      const r = await revertOrphanProcessingLabels(
        repoVcs, { conventions: config.conventions }, repoCtx, repoLog,
      );
      if (r.reverted === 0 && r.scanned === 0) {
        repoLog.info(`Boot: orphan-label clean for ${project.id} (no ai:processing PR)`);
      }
    } catch (err) {
      repoLog.warn(`Boot: orphan-label sweep failed for ${project.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }));

  const bus = new InMemoryEventBus();

  // Notification router — dispatches pipeline events to channels (GitHub comments, etc.)
  const notificationRouter = new NotificationRouter(bus);

  // Agent runtime
  const providers = new Map<string, CLIAgentProvider>();
  for (const [providerId] of Object.entries(agentsConfig.providers)) {
    const providerConfig = resolveProviderConfig(agentsConfig, providerId);
    providers.set(providerId, new CLIAgentProvider(providerId, providerConfig, logger));
  }
  const agentRuntime = new AgentRuntime(providers, guard, logger);

  // Pipeline primitives are constructed per-call inside `stage-handlers.ts`
  // (Phase B Part 3, 2026-05-20). They're stateless so per-call allocation
  // is cheap and keeps the composition root focused on shared-state wiring.

  // Workspace override for local testing
  const workspaceOverride = args.workspace ? resolve(args.workspace)
    : process.env.WORKSPACE_OVERRIDE ? resolve(process.env.WORKSPACE_OVERRIDE)
    : undefined;

  if (workspaceOverride) {
    log.info(`Workspace override: ${workspaceOverride}`);
  }

  // Helper: build WorkspaceRepoInfo from ProjectConfig
  const toRepoInfo = (project: ProjectConfig): WorkspaceRepoInfo => ({
    id: project.id,
    repo: project.vcs.repo,
    branch: project.vcs.branch,
    tokenEnvVar: project.vcs.tokenEnvVar,
  });

  // Phase B Part 2 (2026-05-20): dispatch registry is now KV-driven —
  // each workflow-stage row in `kv:workflow-stages/*` carries its own
  // `dispatch` block (order + featureFlags + schedule). Adding a new
  // stage is one YAML row + one prompt file; no TS dispatch table.
  //
  // Housekeeping actions that are NOT workflow stages (no agent / no
  // selector / no PR output) still live as composition-root extras
  // here. Their dispatch metadata has nowhere else to belong — they're
  // not stages in the run-stage sense, just periodic side-effects.
  const schedules = config.defaults.schedules;
  const dispatchRegistry = await buildStageDispatchRegistryFromKV(
    storageBundle,
    config.defaults,
    [
      {
        action: "branch-cleanup",
        order: 20,
        schedule: { kind: "interval", intervalMinutes: schedules.prReviewMinutes, stateKey: "cleanup" },
        isEnabled: () => true,
      },
      {
        action: "pr-lifecycle",
        order: 30,
        schedule: { kind: "interval", intervalMinutes: schedules.prLifecycleMinutes, stateKey: "prLifecycle" },
        isEnabled: () => true,
      },
    ],
  );

  // Phase B Part 3 (2026-05-20): build a name → row map of every
  // workflow stage so `executeAction` can dispatch by composer without
  // hardcoding stage names. Loaded once at boot; new stages take effect
  // on the next engine restart (`overwriteContentOnBoot: true` on the
  // seed re-mirrors the YAML into KV before this lookup runs).
  const stageRows = await storageBundle.list("workflow-stages");
  const stageByName = new Map<string, WorkflowStageEntry>();
  for (const row of stageRows) {
    const value = row.value as WorkflowStageEntry;
    if (value?.name) stageByName.set(value.name, value);
  }

  const engine = new Engine({
    config,
    state,
    bus,
    log,
    kv: storageBundle,
    dispatchRegistry,
    enumerateRepos: async (): Promise<readonly ProjectConfig[]> => {
      const entries = await storageBundle.list("repos");
      return entries.map((e) => e.value as ProjectConfig);
    },
    createVCS: (project: ProjectConfig): VCSPlatform => {
      const token = process.env[project.vcs.tokenEnvVar] || "";
      const octokit = createOctokit(token, logger);
      const { owner, repo } = parseRepoSlug(project.vcs.repo);
      return new GitHubVCS(octokit, owner, repo);
    },
    resolveWorkspace: (project: ProjectConfig): string => {
      if (workspaceOverride) return workspaceOverride;
      return resolve(env.workspaceBaseDir, project.id);
    },
    prepareWorkspace: async (project, workspacePath, prepCtx): Promise<void> => {
      const repoInfo = toRepoInfo(project);
      const git = new WorkspaceGit(workspacePath);
      if (workspaceOverride) {
        // Safety: refuse to run on dirty workspace (protect user's uncommitted work)
        const isClean = await git.isClean();
        if (!isClean) {
          throw new Error(`Workspace has uncommitted changes at ${workspacePath} — commit or stash first`);
        }
        return;
      }
      await workspaceEnsure(env.workspaceBaseDir, repoInfo, env.gitIdentity, prepCtx);
      await workspaceSync(env.workspaceBaseDir, repoInfo, prepCtx);
      // Run the project's `scripts.init` (npm ci / bundle install /
      // dotnet restore — whatever the repo declares) when the install
      // inputs (lock files + the command itself) have changed since
      // the last successful run. Cached in `kv:workspace-init/{repoId}`
      // so a clean cycle pays nothing. Without this, `verify` (which
      // depends on installed deps) fails on a freshly-synced workspace
      // whenever a feature branch updates its lock files — root cause
      // of T20260416-000202 where backend tasks tripped on the
      // frontend's missing tiptap modules.
      const automationDir = resolve(workspacePath, ".operator");
      const initCommand = await readProjectInitCommand(automationDir);
      await ensureWorkspaceInit({
        repoId: project.id,
        workspacePath,
        initCommand,
        kv: storageBundle,
        ctx: prepCtx,
        log: contextLogger(logger, prepCtx),
      });
    },
    syncWorkspace: async (project, workspacePath, syncCtx): Promise<void> => {
      const git = new WorkspaceGit(workspacePath);
      const token = process.env[project.vcs.tokenEnvVar] || "";
      const octokit = createOctokit(token, logger);
      const { owner, repo } = parseRepoSlug(project.vcs.repo);
      const vcs = new GitHubVCS(octokit, owner, repo);
      const prManager = new PRManager(vcs, config.conventions);
      // syncFilesToState resolves per-kind directories via
      // `join(workspacePath, kindDef.dataDir)`. `dataDir` carries the
      // full workspace-relative prefix (`.operator/data/{kind}`) since
      // d16d88b, so passing the workspace root is correct — adding a
      // `.operator/data` segment here would double-prefix the path and
      // make sync see zero files (the 2026-05-20 regression).
      const counts = await syncFilesToState(kindRegistry, workspacePath, state, syncCtx, {
        kv: storageBundle,
        git,
        prManager,
        vcs,
        workspacePath,
        branchPrefixFor: (kind) => kindRegistry.branchPrefixFor(kind) ?? null,
      });
      const syncLog = contextLogger(logger, syncCtx);
      const summary = Object.entries(counts).map(([k, n]) => `${n} ${k}`).join(", ");
      syncLog.info(`Synced ${summary} to DB + observed statusSources`);
    },
    executeAction: async (
      action: ActionName,
      project: ProjectConfig,
      vcs: VCSPlatform,
      workspacePath: string,
      actionCtx: OperationContext,
    ): Promise<ActionResult> => {
      const actionLog = contextLogger(logger, actionCtx);
      statusLine.set({ operation: action, repo: project.id, startedAt: Date.now() });
      actionLog.info(`Executing ${action} for ${project.id}`);

      if (args.dryRun) {
        actionLog.info(`[DRY RUN] Would execute ${action} for ${project.id}`);
        return { action, status: "skipped", message: `[dry-run] ${action}` };
      }

      const repoInfo = toRepoInfo(project);
      const automationDir = join(workspacePath, ".operator");
      // Single source of truth for per-kind data directories: the kind
      // registry (seeded from `engine/content/prompts/kinds.yaml`). Both
      // the read-side (idempotency scanner, conflict filter, syncFromFiles)
      // and the write-side (FileBackedWorkItemSource.create via the AOP
      // applier) must resolve the same `{workspacePath}/{kind.dataDir}`
      // path or new child files land where the scanner cannot see them —
      // the 2026-05-14 PR-871 / PR-872 wrong-location bug. `dataDir` is
      // declared with the full `.operator/data/{kind}` prefix in kinds.yaml.
      const findingsDir = join(workspacePath, kindRegistry.dataDirFor("finding"));
      const tasksDir = join(workspacePath, kindRegistry.dataDirFor("task"));
      // Retrospectives are not yet a registered kind — kept under the
      // legacy hardcoded path; migrates to the registry alongside the
      // kind definition when that lands.
      const retrospectivesDir = join(automationDir, "data", "retrospectives");
      const templatesDir = resolveContentPath("templates");
      const baseBranch = repoInfo.branch;

      const git = new WorkspaceGit(workspacePath);
      const templates = new KVTemplateSource(storageBundle);
      const prManager = new PRManager(vcs, config.conventions, templates);
      const promptSource = new KVPromptSource(storageBundle, automationDir, actionLog);

      // Register GitHub notification channel for this project
      const ghChannel = new GitHubChannel(vcs, config.conventions.commentMarker);
      notificationRouter.register(ghChannel);

      try {
        // Workspace prep + file→state sync run once per project per cycle
        // inside Engine.processProject before any action reaches this callback
        // (the `syncFromFiles` reconciler contract, docs/architecture-v5.md §6.3).
        // Stages see a populated workspace and reconciled state from the first call.

        // Build state context once per action — cached for all agent invocations (V1 behavior)
        const stateVars = await buildStateContext(state, kindRegistry, actionCtx);

        // Phase B Part 3 (2026-05-20): handler dispatch is now driven by
        // the `composer` field on `kv:workflow-stages/*` rows. Two
        // hand-rolled `extras` cover housekeeping actions that are NOT
        // workflow stages (no agent, no selector, no PR output sink) —
        // they live here in the composition root because the dispatch
        // registry treats them as extras and there's no row to hang
        // their wiring off.
        const extras: Record<ActionName, () => Promise<ActionResult>> = {
          "branch-cleanup": async () => {
            const deleted = await cleanupBranches(vcs, config.conventions, actionLog);
            actionLog.info(`Cleaned up ${deleted} branches`);
            return {
              action,
              status: "completed",
              message: `Deleted ${deleted} branches`,
            };
          },

          "pr-lifecycle": async () => {
            const itemLifecycle = mergeLifecycleConfig(config.defaults.lifecycle, project.lifecycle);
            const result = await runPrLifecycle({
              vcs, prManager, conventions: config.conventions,
              lifecycle: itemLifecycle,
              ignoredBotLogins: config.defaults.review.ignoredBotLogins,
              workspacePath, kindRegistry,
              log: actionLog,
            });
            return {
              action,
              status: "completed",
              message: `pr-lifecycle: promoted=${result.promoted}, merged=${result.merged}, closed=${result.closed}, skipped=${result.skipped}`,
            };
          },
        };

        // Dispatch: extras (housekeeping non-stage actions) win first, then
        // fall back to the composer-driven handler built from the matching
        // workflow-stage row's `composer` field.
        let handler: (() => Promise<ActionResult>) | undefined = extras[action];
        if (!handler) {
          const stageRow = stageByName.get(action);
          if (stageRow) {
            const sharedDeps: StageHandlerSharedDeps = {
              config, project,
              tracker: createTracker(project, actionLog),
              vcs, prManager, git, state, kv: storageBundle, guard,
              bus, agentRuntime, kindRegistry, agentsConfig, promptSource,
              templates, stateVars, log: actionLog,
              workspacePath, automationDir,
              findingsDir, tasksDir, retrospectivesDir, templatesDir,
              baseBranch, actionCtx, action,
            };
            handler = buildStageHandler(stageRow, sharedDeps);
          }
        }
        if (!handler) {
          return { action, status: "skipped", message: `Unknown action: ${action}` };
        }
        return await handler();
      } catch (err) {
        actionLog.error(`Action ${action} failed: ${err}`);
        return { action, status: "failed", message: String(err) };
      } finally {
        // Always reset workspace after action (ports workspace_reset in orchestrator.sh)
        await git.resetToBase(baseBranch);
      }
    },
  });

  // Subscribe notification router to key pipeline events
  {
    const { TASK_COMPLETED, TASK_FAILED, FINDING_PLANNED, RESEARCH_COMPLETED, IMPROVER_COMPLETED, ENGINE_STOPPED } = await import("./events/types.js");
    notificationRouter.subscribe([TASK_COMPLETED, TASK_FAILED, FINDING_PLANNED, RESEARCH_COMPLETED, IMPROVER_COMPLETED]);
    bus.on(ENGINE_STOPPED, async () => {
      await heartbeat?.recordCycle();
      return { action: "continue" };
    });
  }

  const daemon = new Daemon(engine, {
    cycleIntervalMs: config.defaults.schedules.prReviewMinutes * 60_000,
    once: args.once,
    repoFilter: args.repo,
    forceAction: args.force,
    dryRun: args.dryRun,
    version: operatorEngineVersion,
  }, createCtx, log, statusLine);

  let finalized = false;
  const finalize = async (reason: "graceful" | "once-complete" | "signal" | "error") => {
    if (finalized) return;
    finalized = true;
    statusLine.stop();
    try { await heartbeat?.stop(reason); } catch { /* best-effort */ }
    state.close();
    guard.close();
    storageBundle.close();
    process.exit(reason === "error" ? 1 : 0);
  };

  const shutdown = async () => {
    log.info("Shutting down...");
    await daemon.shutdown();
    await finalize("signal");
  };

  daemon.onSoftShutdown(() => { void finalize("graceful"); });

  // SIGTERM is what a container supervisor (Docker / Portainer / systemd)
  // sends on stop or redeploy. Drain the in-flight cycle first — agents are
  // never killed mid-PR-transition (see daemon.requestShutdown). A bounded
  // fallback forces a hard shutdown if the drain overruns SHUTDOWN_GRACE_MS,
  // and a second SIGTERM forces it immediately. The hard path is still safe:
  // boot reconciliation finalizes orphaned locks / labels / executions on the
  // next start.
  let draining = false;
  const gracefulShutdown = async () => {
    if (draining) {
      log.warn("Second SIGTERM — forcing immediate shutdown.");
      await shutdown();
      return;
    }
    draining = true;
    const graceMs = Number(process.env.SHUTDOWN_GRACE_MS) || 300_000;
    log.info(`SIGTERM received — draining current cycle (graceful, up to ${Math.round(graceMs / 1000)}s).`);
    const force = setTimeout(() => {
      log.warn(`Graceful drain exceeded ${graceMs}ms — forcing shutdown.`);
      void shutdown();
    }, graceMs);
    if (typeof force.unref === "function") force.unref();
    await daemon.requestShutdown();
  };

  // SIGINT (interactive Ctrl+C) stays an immediate hard abort.
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", gracefulShutdown);

  // ESC key → graceful soft shutdown (wait for current cycle, then exit).
  // Only wired in interactive TTY mode — background / CI / systemd runs
  // do not have a usable stdin and must rely on SIGTERM instead.
  if (!args.once && process.stdin.isTTY) {
    try {
      process.stdin.setRawMode(true);
      process.stdin.resume();
      process.stdin.setEncoding("utf8");
      statusLine.set({ hint: "ESC — quit · Ctrl+C — abort" });
      log.info("Press ESC for graceful shutdown (waits for current cycle). Ctrl+C for immediate abort.");
      process.stdin.on("data", (chunk: string) => {
        // ESC is the single byte 0x1B. Ctrl+C (0x03) is handled by the
        // default raw-mode behavior and reaches us as SIGINT separately.
        if (chunk === "\u001b") {
          void daemon.requestShutdown();
        } else if (chunk === "\u0003") {
          // Raw mode swallows Ctrl+C; emit SIGINT manually so `shutdown`
          // still fires for operators used to the shortcut.
          void shutdown();
        }
      });
    } catch (err) {
      log.warn(`ESC-shutdown not available (stdin raw mode failed): ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  log.info(`Operator v5 starting (version ${operatorEngineVersion}, mode: ${args.once ? "once" : "daemon"}${args.dryRun ? ", dry-run" : ""})`);
  await daemon.start();

  if (args.once) {
    const health = daemon.getHealth();
    log.info(`Cycle complete: ${health.lastCycleResult}`);
    // Exit with error code so GitHub Actions (and any other caller) marks the
    // job as failed when at least one pipeline action failed. Without this the
    // workflow always reports success even if a finding/task pipeline errored.
    await finalize(health.lastCycleResult === "failure" ? "error" : "once-complete");
  }
}

function createTracker(project: ProjectConfig, log?: import("./logging/logger.js").Logger) {
  if (!project.tracker) return undefined;
  const token = process.env[project.tracker.tokenEnvVar || project.vcs.tokenEnvVar] || "";
  const octokit = createOctokit(token, log);
  const { owner, repo } = parseRepoSlug(project.tracker.repo || project.vcs.repo);
  return new GitHubTracker(octokit, owner, repo);
}

/**
 * Merge engine-default + per-repo lifecycle config. Per-field semantics:
 *   - `undefined` on the per-repo side → inherit from defaults.
 *   - any concrete value on the per-repo side (including `null`) wins
 *     and overrides the default.
 * The result is the system+repo layer that `pr-lifecycle` then cascades
 * with per-work-item frontmatter overrides.
 */
function mergeLifecycleConfig(
  defaults: LifecycleConfig,
  override?: LifecycleConfig,
): LifecycleConfig {
  if (!override) return defaults;
  return {
    promoteToReadyAfterIdleHours:
      override.promoteToReadyAfterIdleHours !== undefined
        ? override.promoteToReadyAfterIdleHours
        : defaults.promoteToReadyAfterIdleHours,
    autoMergeReadyAfterHours:
      override.autoMergeReadyAfterHours !== undefined
        ? override.autoMergeReadyAfterHours
        : defaults.autoMergeReadyAfterHours,
    autoCloseStuckAfterHours:
      override.autoCloseStuckAfterHours !== undefined
        ? override.autoCloseStuckAfterHours
        : defaults.autoCloseStuckAfterHours,
  };
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
