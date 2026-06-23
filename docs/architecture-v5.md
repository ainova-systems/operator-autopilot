# Operator Architecture V5 — Target

**Status: live — this document tracks the target shape of the engine.** Paired with `workflow.md` (behavior contract), `vision.md` (product direction), and `migration-v5.md` (the rebuild plan).

This document describes the target shape of the Operator after the v5 rebuild. Phase A (supervisor architecture) is partial — agent-side + applier-side live; engine-side stage-logic dissolution outstanding (see `migration-v5.md §9.7`). Every claim in this doc is the code's current shape — drift between this doc and `engine/` is a bug.

> **Stage names are per-repo demo config.** Names like `finding-plan`, `task-execute`, `research`, `retrospective`, `pr-review`, `supervisor` appearing throughout this document are sample `stages.yaml` entries used as concrete examples. The engine has **zero hardcoded stage names** in TypeScript code paths — adding a new stage is one YAML row + one prompt file, never a new TypeScript file. Treat every walkthrough that references a specific stage name as "sample demo config", not as an engine concept.

---

## 1. Top-level repository layout

Monorepo with npm workspaces. Three deployable things, three shared packages. Engine assets (prompts, templates, default seeds) live **inside** `engine/content/` and are bundled with the engine artifact. Only instance config (`config/repos.yaml`) and shared developer tooling (`docs/`, `intelligence/`, `dev/`) stay at root. `engine/` is flat — there is no `src/` subdirectory.

```
git-operator-autopilot/
├── engine/                          @operator/engine — the daemon (flat, no src/)
│   ├── entry.ts                        composition root
│   ├── cli.ts
│   ├── index.ts                        library re-exports + version constant
│   ├── daemon/                         scheduler, health, recovery
│   ├── engine/                         Engine.runOnce, runProject
│   ├── pipeline/
│   │   ├── run-stage.ts                THE generic stage loop (8 steps)
│   │   ├── cleanup.ts                  the one non-run stage
│   │   ├── types.ts                    StageDef, StageInput, AgentResult, Verdict
│   │   ├── primitives/                 ONE file per loop step (kind-driven, stage-name-agnostic)
│   │   │   ├── workspace-scope.ts
│   │   │   ├── item-selector.ts
│   │   │   ├── pr-feedback-selector.ts
│   │   │   ├── discovery-selector.ts
│   │   │   ├── singleton-selector.ts
│   │   │   ├── agent-invocation.ts
│   │   │   ├── persist-output.ts
│   │   │   ├── route-verdict.ts
│   │   │   ├── observe-status.ts       per-source status observations
│   │   │   ├── execution-history.ts    append-only executions/* writer
│   │   │   ├── execution-context.ts    prior-executions → agent prompt block
│   │   │   ├── agent-output-protocol.ts AOP text-block parser (F1) + raw-frontmatter-leak guard (F3.5)
│   │   │   ├── aop-applier.ts          generic applyAgentEvents (F4) — kind-agnostic
│   │   │   ├── pr-state-cache.ts       per-PR terminal-state cache (B-409)
│   │   │   ├── checks-context.ts       CI annotations → temp file for agent (D-503)
│   │   │   ├── execution-reconcile.ts  reconcile stuck executions + orphan labels on boot
│   │   │   └── parse-agent-output.ts   legacy parser modes (kept for non-AOP paths)
│   │   └── stage-logic/                ⏳ TRANSITIONAL — 6 stage-named files scheduled for
│   │       │                              dissolution into generic primitives (see
│   │       │                              `migration-v5.md §9.7`). Engine target state: no
│   │       │                              `stage-logic/` directory; per-stage hook config
│   │       │                              lives in `stages.yaml` only.
│   │       ├── supervisor.ts           (S1) — to be replaced by event-driven primitives
│   │       ├── finding-plan.ts         to be replaced by idempotency-scan + head-snapshot-contract
│   │       ├── task-execute.ts         to be replaced by conflict-filter + failure-reason-writer
│   │       ├── research.ts             to be replaced by analyzer-iteration primitive
│   │       ├── retrospective.ts        to be replaced by metrics-aggregator primitive
│   │       ├── rejection-handler.ts    folded into supervisor + closed-no-merge selector extension
│   │       ├── errors.ts               StageLogicError + codes (moves to engine/infra/errors)
│   │       └── _shared/
│   │           └── scratch.ts          per-invocation ScratchStore<T> (moves to primitives/)
│   ├── agents/                         AgentRuntime + prompt-builder + CLI provider
│   ├── work-items/                     work-items.ts (file ↔ KV sync + retrospective helpers)
│   ├── platforms/github/               GitHubVCS, GitHubTracker
│   ├── state/                          SQLiteStateManager
│   ├── storage/                        seed.ts + seed-sources.ts
│   ├── delivery/                       PRManager
│   ├── events/                         InMemoryEventBus
│   ├── config/                         loader.ts + schemas.ts
│   ├── infra/                          git.ts, workspace.ts, env.ts, content-path.ts, local/
│   ├── verification/                   pipeline.ts
│   ├── communication/                  NotificationRouter + GitHub/Telegram channels
│   ├── concurrency/                    ConcurrencyController
│   ├── logging/                        logger.ts + redact.ts
│   ├── test-helpers/                   TestVCSPlatform, TestStateManager, test-kind-registry
│   └── content/                        non-code engine assets — bundled with the engine
│       ├── prompts/                   LLM instructions (engine defaults)
│       │   ├── agents/                role prompts (analyst.md, creator.md, planner.md,
│       │   │                            improver.md, supervisor.md, verifier.md, scout.md,
│       │   │                            diagnoser.md — to fold into supervisor.md in F10)
│       │   │   └── verifier/          stage-scoped verifier criteria (renamed from
│       │   │                            reviewer/ in A1)
│       │   ├── context/               base.md, state.md
│       │   ├── stages.yaml            SAMPLE stage definitions (demo config — not
│       │   │                            engine-canonical; each managed repo defines its own)
│       │   └── kinds.yaml             work item kind definitions
│       ├── templates/                 PR body + format templates
│       └── defaults/
│           ├── defaults.yaml          schedules, labels, conventions
│           └── agents.yaml            provider + role defaults
│
├── app/                             @operator/app — Next.js console UI
│   ├── src/
│   │   ├── app/                        Next.js App Router (connections, work-items,
│   │   │                                  executions, config, audit, API routes)
│   │   ├── components/                 React components (connection list, JSON editor)
│   │   └── lib/                        client + server helpers (app-kv, connections,
│   │                                      kv-factory, kv-write, audit-log, baseline,
│   │                                      require-active-kv, env-paths, active-kv-registry)
│   ├── package.json                 @operator/app
│   ├── next.config.ts
│   └── tsconfig.json
│
├── packages/
│   ├── core/                        @operator/core — shared contracts (zero runtime
│   │   └── src/                        except error classes)
│   │       ├── types/                  WorkItem, CodeReview, OperationContext,
│   │       │                             WorkItemKind (open string), domain types
│   │       ├── interfaces/             KVStore, VCSPlatform, AgentProvider,
│   │       │                             IdempotencyGuard, RateLimiter, PromptSource,
│   │       │                             KindRegistry
│   │       ├── schemas/                Zod schemas per KV category (13 schemas)
│   │       ├── errors/                 OperatorError + AgentError + ConfigError
│   │       │                             + PlatformError + WorkspaceError
│   │       └── status-reconcile.ts     reconcileEffectiveStatus + computeDrift
│   └── adapters/                    @operator/adapters — interface implementations
│       └── src/
│           ├── kvstore-sqlite/         LocalStorageBundle: KV + Guard + RateLimiter
│           │                             over one SQLite file (WAL mode)
│           ├── kind-registry/          KVBackedKindRegistry (loads kv:work-item-kinds/*)
│           ├── work-item-source/       F2b FileBackedWorkItemSource + F9 VirtualWorkItemSource
│           │                             — kind-agnostic CRUD adapters
│           └── agent-event-stream/     F3a TextBlockEventStream wrapping the F1 AOP parser
│
│           # Future packages documented here for target shape — NOT in MVP code.
│           # Future:
│           #   kvstore-cloud         Cloud Storage API (KVStore impl)
│           #   guard-cloud           Cloud Shield API (IdempotencyGuard impl)
│           #   rate-limiter-cloud    Cloud Guard API (RateLimiter impl)
│
├── config/                          INSTANCE config — not engine code
│   ├── repos.yaml                      managed repos baseline (committed during MVP
│   │                                    for testing; gitignored once UI write path lands)
│   └── repos.yaml.example              committed template + documentation
│
├── intelligence/                    AI prompt framework for this repo (rules/agents/skills)
├── docs/                            architecture, migration, features, deployment
├── dev/                             repo tooling
├── scripts/                         CI helpers (`check-ts-prune.mjs`, `check-knip.mjs`)
├── state/                           runtime state (SQLite DB, workspaces, etc.)
│
├── package.json                     workspace root: { "workspaces": ["engine", "app", "packages/*"] }
├── tsconfig.base.json
├── eslint.config.js
└── README.md
```

Removed from repo root in v5: `agents/`, `templates/`, `config/defaults.yaml`, `config/agents.yaml`. They are engine assets, not project assets, and now live under `engine/content/`. Only `config/repos.yaml` (instance data) stays at root for the MVP testing window; it becomes gitignored once the UI write path is trusted.

Layers are enforced by ESLint `no-restricted-imports` (CI-blocking from Step 17 Phase 1), not by doc prose.

### 1.1 Primitives (by file)

`engine/pipeline/primitives/` is the only location where stage code may call `git.*` / `PRManager.*` / `VCSPlatform.*` / `AgentRuntime.*` / `KVStore.*`. Each primitive is ≤200 lines and has a colocated test at ≥95% coverage. All primitives are kind-driven and stage-name-agnostic — they accept `stageDef` config but never branch on a specific stage name.

| File | Role |
|---|---|
| `workspace-scope.ts` | `FileWorkspaceScope.prepare` — the only place that decides `checkoutExisting` vs `checkoutNewBranch` (non-fast-forward incident fix) |
| `item-selector.ts` | Selector registry + `bootstrap` + `per-item` strategies; enforces `MAX_ATTEMPTS_PER_ITEM = 2` bounded-iteration cap (A2) |
| `pr-feedback-selector.ts` | `pr-feedback` strategy — open AI PRs with unread comments since last bot footer |
| `discovery-selector.ts` | `discovery` strategy — iterate analyzer definition files matching glob |
| `singleton-selector.ts` | `singleton` strategy — one input per cron fire window |
| `agent-invocation.ts` | `FileAgentInvocation.invoke` — wraps `AgentRuntime.run`, parses `## Verdict` / `## Execution Summary` |
| `agent-output-protocol.ts` | F1 — AOP text-block parser (`parseAgentOutput`) + F3.5 `raw-frontmatter-leak` diagnostic guard |
| `aop-applier.ts` | F4 — generic `applyAgentEvents` kind-agnostic apply path; routes `EMIT child-item` / `status-update` / `body-update` through the injected `WorkItemSource` |
| `parse-agent-output.ts` | Legacy parser modes (`single-document` / `multi-document` / `code-changes` / `structured-report`) kept for non-AOP paths |
| `persist-output.ts` | `FileOutputAdapter.persist` — frozen signature; addAll → commitIfChanged → push → upsertPR → markX; B-417 empty-diff post-push guard |
| `route-verdict.ts` | `FileVerdictRouter.route` — pipeline events + terminal-sticky reconcile; increments `attemptCount` on terminal failures (A2) |
| `observe-status.ts` | `readFrontmatterStatus`, `observeDevelopFile`, `observeFeatureBranchFile`, `observePRLabel`, `observeExecutionVerdict`, `observePRState`, `observeChecks` |
| `pr-state-cache.ts` | B-409 — per-PR terminal-state cache (`kv:pr-states/{prNumber}`); `recordTerminalPRStates` + `readCachedPRState` |
| `checks-context.ts` | D-503 — CI annotations to temp file for agent consumption via `Read` tool |
| `execution-history.ts` | `ExecutionHistoryWriter` — `kv:executions/{id}` + events + log-ring-buffer finalize |
| `execution-context.ts` | `buildExecutionHistoryBlock` — prior-execution summaries → agent prompt |
| `execution-reconcile.ts` | `reconcileStuckExecutions` + `revertOrphanProcessingLabels` — boot-time cleanup |

### 1.2 Stage-logic — TRANSITIONAL, to be dissolved (F10)

`engine/pipeline/stage-logic/` currently holds 6 stage-named TypeScript files. These violate the v5 architecture invariant ("stages are configuration, not code" — §3 of `workflow.md`, §1 binding principle 3 of `migration-v5.md`). They exist as a transitional state from the Phase A migration; the F10 step extracts their hook logic into kind-driven generic primitives and deletes the directory entirely.

**Target state**: this section does not exist. There is no per-stage TypeScript file anywhere under `engine/`. Adding a new stage = one row in `stages.yaml` + one prompt file. Hooks come from the primitive list in §1.1, composed by `runStage` from declarative `stageDef.hooks` config.

**Current state (transitional, scheduled for F10)** — sample demo-config stage names used as concrete examples below:

| File | Hook logic to extract | Becomes (primitive name) |
|---|---|---|
| `finding-plan.ts` | Idempotency-via-`parent_id` scan; HEAD-snapshot read-only contract; symmetric `pending → in-progress` status flip on approved | `idempotency-scan`, `head-snapshot-contract`, `status-forward-flow` |
| `task-execute.ts` | Failed-state recovery (reset to pending); domain-conflict + unmet-deps perItemFilter; failure_reason frontmatter side-channel | `failed-state-recovery`, `conflict-filter`, `failure-reason-writer` (or `WorkItemSource` extra-field channel) |
| `research.ts` | Per-analyzer iteration loop with markKnownItem dedup; aggregate verdict from sub-runs; failure sentinel marker | `analyzer-iteration` primitive driven by `stageDef.inputSource.iterate` config |
| `retrospective.ts` | Weekly metrics aggregation (task stats + finding queue + PR feedback); `{week}.md` report write; supplementary `applyAgentEvents` | `metrics-aggregator` primitive driven by `stageDef.inputSource.preAgentPrimitive` config |
| `rejection-handler.ts` | Closed-no-merge PR enumeration; `/cancel` / `/duplicate` literal parsing; diagnoser agent invocation; reopen vs manual-issue routing | Absorbed by supervisor system stage with extended pr-feedback selector returning closed-no-merge events; `diagnoser.md` folded into `supervisor.md` |
| `supervisor.ts` | PR-event handling hooks (attempt cap, applier invocation, bot-comment shaping) | Generic `event-driven-stage-hooks` primitive driven by `stageDef.hooks` + `stageDef.selector` config |
| `errors.ts` | `StageLogicError extends OperatorError` with codes `STAGE_SCRATCH_MISSING`, `INVALID_STAGE_INPUT`, `HEAD_CHANGED` | Moves to `engine/infra/errors.ts` |
| `_shared/scratch.ts` | `createScratchStore<T>()` — per-invocation store with `clear` for `finally`-block leak prevention | Moves to `engine/pipeline/primitives/scratch-store.ts` (kept as a primitive helper, no stage names) |

---

## 2. Package boundaries (non-negotiable)

```
@operator/core        → imports: nothing external except type-only `node:` modules
                        exports: types, interfaces, error classes
                        zero runtime code beyond error class constructors

@operator/adapters    → imports: @operator/core, external packages (better-sqlite3,
                        @octokit/rest, fetch)
                        exports: concrete implementations of core interfaces
                        never imported by @operator/core

@operator/engine      → imports: @operator/core, @operator/adapters, Node built-ins
                        exports: daemon binary, CLI entry point
                        never imports @operator/app

@operator/app         → imports: @operator/core (types), @operator/adapters
                        (SQLiteKVStore read-only)
                        never imports @operator/engine
                        runs in Next.js server environment only for DB access
```

Rules:
- `core` has zero runtime dependencies. If something needs a constructor, it lives in `adapters`.
- `adapters` implements interfaces from `core`. One adapter per file per concrete implementation.
- `engine` composes adapters into a running daemon. `entry.ts` is the only place that instantiates cross-layer classes (composition root rule).
- `app` is a consumer of the same adapters `engine` uses, but only for read. Writing to storage from the UI happens through HTTP mutations that land in `engine` (future — MVP has no UI-initiated writes).

### 2.1 Adapter implementations

`@operator/adapters/src/` carries the concrete implementations the engine wires through composition root. Each subpath is exported as its own subpath in `package.json` so consumers import only what they need.

| Subpath | Implements | Notes |
|---|---|---|
| `kvstore-sqlite/` | `KVStore` + `IdempotencyGuard` + `RateLimiter` | `LocalStorageBundle` — single SQLite file, three interfaces. Wired in `entry.ts`. |
| `kind-registry/` | `KindRegistry` | `KVBackedKindRegistry.fromKV(storageBundle, ctx)` — reads `kv:work-item-kinds/*` rows seeded from `engine/content/prompts/kinds.yaml`. |
| `work-item-source/` | `WorkItemSource` | Phase 5.0 F2b shipped `FileBackedWorkItemSource` (workspace files); F9 shipped `VirtualWorkItemSource` (KV `work-items-virtual` category). Gated until F4+ stage migrations consume them through a `WorkItemSourceRouter`. |
| `agent-event-stream/` | `AgentEventStream` | Phase 5.0 F3a shipped `TextBlockEventStream` wrapping the F1 fenced-block parser. F3b will add `MCPEventStream` (MCP transport). Gated until F4+. |

ESLint enforces the import graph. Violation → build fails. No "temporary cross-import" comments.

---

## 3. The `run` stage — eight steps, one file

`engine/pipeline/run-stage.ts` is the single implementation of the generic stage loop. It is ~150 lines and delegates every step to a primitive.

```typescript
// Frozen signature — Step 8b MUST implement this shape.
export async function runStage(
  stageDef: StageDef,
  deps: StageDeps,
  ctx: OperationContext,
): Promise<StageRunResult> {
  const scopeKey = resolveScopeKey(stageDef, ctx);

  // 1. acquireLock
  const lock = await deps.guard.acquire(
    `stage:${stageDef.name}:${scopeKey}`,
    stageDef.lockTtlMs ?? DEFAULT_TTL,
    ctx,
  );
  if (!lock) return { status: "skipped", reason: "locked" };

  try {
    // 2. selectInput
    const input = await selectInput(stageDef, deps, ctx);
    if (!input) return { status: "skipped", reason: "no-input" };

    // 3. initWorkspace (WorkspaceScope primitive, existing)
    const workspace = await deps.workspace.prepare(stageDef, input, deps.baseBranch, deps.git, ctx);

    // 4. buildContext (includes per-item execution history)
    const context = await buildContext(stageDef, input, deps, ctx);

    // 5. buildPrompt
    const prompt = await buildPrompt(stageDef, input, context, deps);

    // 6. invokeAgent (internal retry + verifier + verdict inside — see §3.1.1 retry contract)
    const agentResult = await invokeAgent(stageDef, prompt, workspace, deps, ctx);

    // 7. persistOutput (FileOutputAdapter — commit + push + PR + maybe enable auto-merge)
    const persistResult = await deps.persistOutput.persist(
      stageDef, input, agentResult, workspace, ctx,
    );

    // 8. routeVerdict
    await routeVerdict(
      stageDef, input, agentResult.verdict, persistResult, deps, ctx,
    );

    return { status: "completed", input, verdict: agentResult.verdict };
  } finally {
    await deps.guard.release(lock, ctx);
    await deps.workspace.resetToBase(stageDef.baseBranch);
  }
}
```

Each primitive lives in `pipeline/primitives/*.ts`, is ~100-200 lines, has its own unit test. `run-stage.ts` is not allowed to grow beyond ~150 lines — if it does, something inside a primitive is leaking out.

### 3.1.1 Frozen primitive signatures (for Step 8b)

These TypeScript signatures are locked. Step 8b must implement them exactly; Steps 9–12 extend selector strategies but do not change these signatures. Any change requires a doc revision in the same PR.

```typescript
// Input selector — registry-backed, one strategy per file.
export interface InputSelector<TInput = unknown> {
  select(
    stageDef: StageDef,
    deps: SelectorDeps,
    ctx: OperationContext,
  ): Promise<TInput | null>;
}

// Workspace scope — already shipped in Step 7, kept here for completeness.
export interface WorkspaceScope {
  prepare(
    stageDef: StageDef,
    input: unknown,
    baseBranch: string,
    git: WorkspaceGit,
    ctx: OperationContext,
  ): Promise<WorkspaceHandle>;
  resetToBase(baseBranch: string): Promise<void>;
}

// Agent invocation — wraps AgentRuntime.run.
export interface AgentInvocation {
  invoke(
    stageDef: StageDef,
    prompt: BuiltPrompt,
    workspace: WorkspaceHandle,
    deps: AgentDeps,
    ctx: OperationContext,
  ): Promise<AgentResult>;
}

// Output adapter — commits, pushes, creates/finds PR, applies labels.
// Step 7 shipped a narrower signature; Step 8c refactored to the shape below.
// `stagePersistInput` carries the runtime-computed artefacts (commit message,
// PR title/body, onSuccess hint) the stage's buildPR closure produces.
export interface OutputAdapter {
  persist(
    stageDef: StageDef,
    input: StageInput,
    agentResult: AgentResult,
    workspace: WorkspaceHandle,
    stagePersistInput: StagePersistInput,
    deps: { git: WorkspaceGit; prManager: PRManager; vcs: VCSPlatform },
    ctx: OperationContext,
  ): Promise<PersistResult>;
}

export interface StagePersistInput {
  readonly commitMessage: string;
  readonly pr: { readonly title: string; readonly body: string; readonly draft: boolean };
  readonly onSuccess?: "completed" | "none";  // default "none"
}

// Verdict router — label transitions + notifications + work-item KV state.
export interface VerdictRouter {
  route(
    stageDef: StageDef,
    input: unknown,
    verdict: Verdict,
    persistResult: PersistResult,
    deps: RouterDeps,
    ctx: OperationContext,
  ): Promise<void>;
}

// Verdict type — frozen.
export type Verdict = "approved" | "retry" | "failed" | "cancelled" | "rejected";

// AgentResult — what invokeAgent returns. Carries verdict and the raw
// `## Execution Summary` block for Step 14's observability layer.
export interface AgentResult {
  readonly verdict: Verdict;
  readonly summary: string;          // extracted from verifier output
  readonly output: string;           // raw agent stdout
  readonly attempt: number;          // 1-based, final attempt that produced verdict
  readonly costUsd: number;
}

// PersistResult — what persistOutput returns. Input to routeVerdict.
export interface PersistResult {
  readonly committed: boolean;
  readonly sha: string | null;
  readonly prNumber: number | null;
  readonly branch: string;
  readonly prExisted: boolean;       // true if open PR was reused instead of created
}
```

### 3.1.2 Retry boundary — single budget in `AgentRuntime.run`

`AgentRuntime.run` (in `engine/agents/runtime.ts`) owns the entire retry loop:

- **CLI process failure** (timeout, non-zero exit, unparseable output) → retry
- **Verify command failure** (build/lint error) → retry with verify output attached
- **Verifier verdict = `retry`** (non-terminal review) → retry with verifier feedback attached

All three failure modes share one budget: `AgentRunInput.maxRetries` (default 2). When the budget is exhausted, the runtime throws `AgentError` with `phase` set to `"llm" | "verify" | "review"` — which `AgentInvocation.invoke` classifies as a `"failed"` verdict for `runStage`.

Terminal verifier verdicts (`failed`, `cancelled`, `rejected`) bypass the retry loop — they throw `AgentError` immediately with the corresponding `phase` (`"terminal-failed"`, etc.).

`AgentInvocation.invoke` is a pure translator: `AgentRunResult` → `{verdict: "approved"}`, known `AgentError` phases → the matching `Verdict`, unknown errors rethrow. It does NOT add a second retry layer; any future verdict-retry semantics must extend `AgentRuntime` or replace it via a new provider, not wrap it.

| Failure type | Retry within | Terminates via | Surfaced as |
|---|---|---|---|
| CLI process / verify / verifier-retry | `AgentRuntime.run` retry loop | `MAX_RETRIES_EXCEEDED` AgentError with `phase` | `Verdict.failed` |
| Reviewer terminal (`failed`/`cancelled`/`rejected`) | — (immediate) | `REVIEW_TERMINAL` AgentError with `phase` | matching `Verdict` |
| Infrastructure (`PROVIDER_NOT_FOUND`, etc.) | — | thrown through | rethrown as-is, NOT a verdict |

### 3.1.3 Sync contract (single reconciler — Step 8a compliance)

`syncFromFiles` (implementation: `engine/pipeline/stages/work-items.ts → syncFilesToState`) is called **exactly once per project per cycle** from `Engine.processProject`, immediately after `prepareWorkspace` and before any stage runs. This is enforced structurally via the `syncWorkspace` callback on `EngineDeps`. No stage code may call `syncFilesToState` directly.

### Step responsibilities (final)

| Step | File | Responsibility |
|---|---|---|
| 1 | `primitives/agent-invocation.ts` (uses guard from core) | Acquire stage lock scoped by `{stageName}:{strategyKey}`. Release on exit. |
| 2 | `primitives/item-selector.ts` | Pick input according to stage's strategy: `per-item`, `singleton`, `discovery`, `pr-event`. Returns typed input or null. |
| 3 | `primitives/workspace-scope.ts` | Ensure clean workspace on correct branch. Encapsulates the full create-vs-checkout-existing rule. Never force-pushes. Single place where git branch decisions live. |
| 4 | `primitives/context-builder.ts` (agent-invocation helper) | Load WorkItem, parent chain, per-item execution history from KV, related items, state vars. Same context for action and verifier. |
| 5 | `primitives/prompt-resolver.ts` | Layered prompt assembly via `PromptSource`. Topic routing by stage name + agent role. |
| 6 | `primitives/agent-invocation.ts` | Spawn agent CLI, run verify, run verifier, parse 5-verdict, loop retries, write execution summary. Uses AgentRuntime from core. |
| 7 | `primitives/persist-output.ts` | Single `FileOutputAdapter`: commit + push (fast-forward only) + upsert PR + apply labels + (if stage's `merge` conditions are met) request native VCS auto-merge. One code path; no virtual mode, no second adapter. |
| 8 | `primitives/route-verdict.ts` | Update work item KV state, apply PR label transitions (file mode), fire notification events (always on terminal failures). |

### 3.2 Lifecycle: from cron tick to runStage

Three layers sit above `runStage`. Each layer has one job and stays out of the others' lane.

```
LAYER 1: Daemon scheduler           engine/src/daemon/scheduler.ts
  Long-lived process. Wakes every N seconds (default 30s).
  Per tick → for each managed repo → invokes Engine.runOnce(repo).
  Knows: nothing about stages, kinds, agents. Just timing.

LAYER 2: Engine.runOnce             engine/src/engine/engine.ts
  Per repo, per cycle.
  Reads kv:workflow-stages/* (seeded from engine/content/prompts/stages.yaml).
  For each stage, evaluates trigger: cron schedule + enabled flag.
  If due → calls runStage(stageDef, deps, ctx). If not → skips.
  Knows: stage list and schedule semantics. Does NOT know how a stage works inside.

LAYER 3: runStage                   engine/src/pipeline/run-stage.ts
  The 8-step generic loop from §3.
  Knows: how to compose selector + agent + persistence + routing.
```

There is no other dispatcher. No event bus. No workflow engine. The whole "what runs when" is `cron + KV table of stages + 8-step loop`.

### 3.3 Walkthrough — concrete example: the sample `task-execute` stage

> The "task-execute" name is sample demo config. The engine treats it as an opaque `stageDef.name` string. A different repo's code-changing stage might be called `implement` or `code-task` — same engine code path.

Stage definition (loaded from `engine/content/prompts/stages.yaml`, seeded into `kv:workflow-stages/task-execute`):

```yaml
- name: task-execute
  agent: creator
  selector: per-item
  selectorConfig:
    kind: task
    status: pending
    orderBy: priority,createdAt
  outputKind: null              # produces code, not work items
  merge: gated                  # invariant in MVP — code stays human-reviewed
  branchScope: per-item
  branchPrefix: ai/tasks
  maxActive: 2
  schedule: "*/5 * * * *"
  review: true
```

Trace through one cycle:

```
T = 17:35:00 — daemon tick
  └─→ scheduler iterates managed repos: [<repo-id>]
        └─→ Engine.runOnce({ repoId: "<repo-id>" })
              ├─ load kv:workflow-stages/* (cached, 30s TTL)
              ├─ for each stage, eval trigger:
              │    cron "*/5 * * * *" matches 17:35 → due
              │    enabled: true → due
              └─→ runStage(taskExecuteDef, deps, ctx)

Inside runStage:

  1. acquireLock
       deps.guard.acquire("stage:task-execute:<repo-id>", ttl=600s) → token

  2. selectInput
       selector = registry.get("per-item")
       pick = await selector.pickOne(taskExecuteDef.selectorConfig, deps, ctx)
         → kv.list("work-items/", { where:{kind:"task", status:"pending"},
                                    orderBy:"priority,createdAt", limit: 1 })
         → returns { workItemId: "T20260414-0007", scopeKey: "T20260414-0007" }
       (returns null → release lock, return {status:"skipped", reason:"no-input"})

  3. initWorkspace
       workspace = workspaceScope.prepare(taskExecuteDef, pick, "develop", deps.git)
         → branch ai/tasks/T20260414-0007 doesn't exist on remote
         → checkoutNewBranch from develop
         → returns WorkspaceHandle { branch, baseSha }

  4. buildContext
       → load WorkItem T20260414-0007 from kv
       → load parent finding F20260414-0003 from kv (linked via parentId)
       → load execution history: kv.list("executions/",
           { where:{workItemId:"T20260414-0007"}, orderBy:"startedAt desc", limit: 5 })
       → state vars (project context, recent fixes, etc.)

  5. buildPrompt
       → six-layer prompt assembly via PromptSource
       → kv:prompts/agents/creator + .operator/agents/creator.md (overrides)
       → topic="task-execute" → verifier criteria from kv:verifier-criteria/task-execute

  6. invokeAgent
       result = agentRuntime.run({ role:"creator", systemPrompt, workspace }, ctx)
         → spawn `claude -p` CLI
         → claude reads task description, edits files
         → verifier agent runs against the diff
         → verdict parsed: approved | retry | failed | cancelled | rejected
         → returns { verdict:"approved", summary:"...", costUsd: 1.40 }

  7. persistOutput  (FileOutputAdapter)
       a) git.addAll()
       b) git.commitIfChanged("T20260414-0007: implement X")
       c) git.push("ai/tasks/T20260414-0007", { fastForwardOnly: true })
       d) prManager.upsertPR({ branch, title:"[AI:Task] T20260414-0007 ...",
                              body: render(task-pr-body.md, ctx) })
       e) prManager.applyLabels(["ai:processing"])
       → returns { prNumber: 891, branchSha: "def456" }

  8. routeVerdict
       → kv.put("work-items/T20260414-0007",
                 { ...current, status:"in-review", prNumber: 891 })
       → kv.put("work-item-history/T20260414-0007/{seq}", { transition, at: now })
       → kv.put("executions/{execId}", ExecutionEntry)
       → no notification (success)

  finally — release lock, reset workspace to develop
```

### 3.4 Walkthrough — concrete example: the sample PR-feedback handling

> The sample repo originally ran a `pr-review` stage with the `creator` role. Phase A S1 replaced that with a `supervisor` system stage that consumes the `pr-feedback` selector + the `applyAgentEvents` primitive. The stage name "pr-review" is preserved in the sample `stages.yaml` for per-repo config compatibility (the agent role is now `supervisor`). The mechanics below describe the same 8-step loop with the supervisor role.

Same 8 steps as §3.3, different selector and different per-item scope. This is the stage that hooks PR comments back into the loop.

```yaml
- name: pr-review
  agent: creator
  selector: pr-feedback
  selectorConfig:
    branchPrefixes: [ai/tasks, ai/findings, ai/research, ai/retrospective]
    ignoreBots: [github-actions[bot]]
  outputKind: null
  merge: gated                  # human merges; bot only pushes amendments
  branchScope: pr               # scope key = PR number
  schedule: "*/5 * * * *"
  review: true
```

Trace:

```
T = 17:35:00 — daemon tick → Engine.runOnce("<repo-id>") → cron matches → runStage(prReviewDef)

  1. acquireLock
       Soft "selection lock" so two daemons don't both call vcs.getCodeReviews:
       deps.guard.acquire("stage:pr-review:selection:<repo-id>", ttl=60s)

  2. selectInput
       selector = registry.get("pr-feedback")
       pick = await selector.pickOne(prReviewDef.selectorConfig, deps, ctx)
         → vcs.getCodeReviews({ state:"open" })
         → filter by branch.startsWith(branchPrefixes)
         → for each PR:
              lastExec = kv.list("executions/",
                  { where:{stageName:"pr-review", prNumber: PR.number},
                    orderBy:"startedAt desc", limit: 1 })
              comments = vcs.getReviewComments(PR.number)
              fresh = comments.filter(c => !ignoreBots.includes(c.author)
                                            && c.createdAt > lastExec.startedAt)
              if fresh.length > 0 → return { prNumber: PR.number, comments: fresh }
         → returns { prNumber: 891, scopeKey:"891", comments: [...] }
       (release selection lock; acquire item-level lock next)

  1'. acquireLock per-PR
       deps.guard.acquire("stage:pr-review:891", ttl=600s)

  3. initWorkspace
       workspace = workspaceScope.prepare(prReviewDef, pick, "develop", deps.git)
         → branchScope=pr → branch ai/tasks/T20260414-0007 already exists on remote
         → checkoutExisting (NOT checkoutNew — the v4 bug we fixed)
         → fetch + fast-forward to capture out-of-band commits
         → returns WorkspaceHandle { branch }

  4. buildContext
       → load original WorkItem (T20260414-0007)
       → load fresh PR comments (already in pick.comments)
       → load execution history for prNumber=891
       → state vars

  5. buildPrompt
       → six-layer prompt
       → topic="pr-review" → verifier criteria from kv:verifier-criteria/supervisor (post-S1)
       → augment user layer with the fresh comments as "## Pending feedback"

  6. invokeAgent
       → claude reads comments, edits files, verifier checks, verdict

  7. persistOutput  (FileOutputAdapter)
       a) git.addAll()
       b) git.commitIfChanged("T20260414-0007: address review comments")
       c) git.push (fast-forward only — branch was checked out fresh)
       d) prManager.findOpenPR(branch) → existing PR#891 → no upsert needed
       e) prManager.postComment("Addressed review feedback (commit def456)")
       f) prManager.applyLabels(["ai:processing"])

  8. routeVerdict
       → kv.put("work-items/T20260414-0007", { ...current, lastReviewedAt: now })
       → kv.put("executions/{execId}", ExecutionEntry with prNumber: 891)
       → notification on failure / cancellation only

  finally — release per-PR lock, reset workspace
```

Two stages, same 8-step loop. The only differences: the selector in step 2 and the branch resolution in step 3 — both pluggable.

### 3.5 Agent-Orchestrator boundary — frontmatter ownership (HARD CONTRACT)

**Agents NEVER directly create / update / delete YAML frontmatter on
work-item files** (`.operator/data/findings/*.md`,
`.operator/data/tasks/*.md`, `.operator/data/retrospectives/*.md`).
Frontmatter is the orchestrator's exclusive responsibility — engine
primitives own every status flip, timestamp, parent linkage, lifecycle
field, and id assignment.

This boundary is non-negotiable. It enables:

- **Single applier code path.** File-backed (`FileBackedWorkItemSource`)
  and virtual (`VirtualWorkItemSource`) kinds share the same lifecycle
  semantics because both go through the orchestrator's primitives. If
  agents wrote frontmatter directly, virtual kinds would need a parallel
  applier — exactly the asymmetry §3.4 storage policy is designed to
  prevent.
- **Auditable lifecycle.** Every state transition has a primitive on
  the call stack — `runStage` → `applyEvents` → `updateStatusAndSync`.
  Diff-the-row in `kv:executions/*` shows who flipped which status when.
- **Deterministic tests.** No agent in the loop for status hygiene.
  Tests double the parser, drive primitives directly, assert exact
  state transitions.

#### How agents express intent

Through the **Agent-Orchestrator Protocol** (§3.3 of `migration-v5.md`):
typed `EMIT:` records the agent writes to stdout (text-block transport)
or sends as MCP tool calls (F3b transport). The orchestrator's parser
(`engine/pipeline/primitives/agent-output-protocol.ts`) reconstructs
typed `AgentEvent` records and the per-stage applier routes each one
to the right primitive.

```yaml
# Agent emits — orchestrator applies. Never the other way around.
=== EMIT child-item ===
kind: task
parent: F20260502-0001
title: "Add unit tests for hospitals search"
priority: 3
=== END EMIT ===

=== EMIT status-update ===
target: F20260502-0001
status: in-progress
reason: "children created"
=== END EMIT ===
```

#### Enforcement (F3.5)

The text-block parser carries a guard that **rejects** agent output
containing a raw `---` fence followed by a work-item frontmatter field
(`status:`, `id:`, `kind:`, `parent_id:`, `priority:`, `created_at:`,
`started_at:`, `completed_at:`, `depends_on:`) outside any EMIT block.
The diagnostic carries code `raw-frontmatter-leak`, severity `error`,
points at the offending line, and references this section. Stages
fail the run with that diagnostic so the agent's prompt — not silent
absorption — is what gets corrected.

Per-stage prompt rewrites landed across Phase A S1–S5 (see `migration-v5.md §1A`): planner.md (S2), analyst.md (S4), supervisor.md (S1), improver.md, creator.md AOP boundary clause (S3). All AOP-bearing prompts now emit `EMIT child-item` / `EMIT verdict` records consumed by the F4 generic applier (`engine/pipeline/primitives/aop-applier.ts`). The parser guard in `agent-output-protocol.ts` rejects any raw frontmatter leak with the `raw-frontmatter-leak` diagnostic.

---

## 4. Stage configuration and seeding

### 4.1 Source of stage definitions

`engine/content/prompts/stages.yaml` ships with the engine as a **sample baseline** for demo use. **The engine has no hardcoded stage names.** Each managed repo can override / replace this sample with its own `stages.yaml` (or via the App UI write path post P-502) — new repos onboarding to the operator define their own stage names, agent roles, selector configs, and merge policies. The names below are the demo sample only:

```yaml
stages:
  - name: init
    agent: scout
    selector: singleton           # scopeKey = "bootstrap"
    outputKind: finding
    merge: gated
    branchScope: singleton
    branchPrefix: ai/init
    prTemplate: init-pr-body.md
    schedule: on-start
    review: false
    enabled: true

  - name: research
    agent: analyst
    selector: discovery
    selectorConfig:
      glob: ".operator/stages/research/*.md"
    outputKind: finding
    merge: gated
    branchScope: singleton          # scopeKey = current cron fire date
    branchPrefix: ai/research
    prTemplate: research-pr-body.md
    schedule: "0 8 * * *"
    review: false
    enabled: true

  - name: finding-plan
    agent: planner
    selector: per-item
    selectorConfig:
      kind: finding
      status: pending
      orderBy: priority,createdAt
    outputKind: task
    merge: gated
    branchScope: per-item
    branchPrefix: ai/findings
    prTemplate: finding-pr-body.md
    maxActive: 2
    schedule: "*/5 * * * *"
    review: true
    enabled: true

  - name: task-execute
    agent: creator
    selector: per-item
    selectorConfig:
      kind: task
      status: pending
      orderBy: priority,createdAt
    outputKind: null              # produces code, not new work items
    merge: gated                  # invariant — code stages stay gated in MVP
    branchScope: per-item
    branchPrefix: ai/tasks
    prTemplate: task-pr-body.md
    maxActive: 2
    schedule: "*/5 * * * *"
    review: true
    enabled: true

  - name: pr-review
    agent: creator
    selector: pr-feedback
    selectorConfig:
      branchPrefixes: [ai/tasks, ai/findings, ai/research, ai/retrospective]
      ignoreBots: [github-actions[bot]]
    outputKind: null
    merge: gated
    branchScope: pr               # reuse existing PR branch
    schedule: "*/5 * * * *"
    review: true
    enabled: true

  - name: retrospective
    agent: improver
    selector: singleton           # scopeKey = current cron fire ISO week
    outputKind: finding
    merge: gated                  # opt into `auto` once trust builds (§6.2 of workflow.md)
    branchScope: singleton
    branchPrefix: ai/retrospective
    prTemplate: retrospective-pr-body.md
    schedule: "0 9 * * 1"
    review: true
    enabled: true
```

`cleanup` is **not** in this list. It is a cron task (`engine/src/cron/cleanup.ts`) called at the end of each `Engine.runOnce` cycle — pure orchestration code with no LLM, not a stage.

### 4.2 Seeding into KV

On every engine startup, `storage/seed.ts` runs **two** deterministic seed passes — one per mode (§4.4).

**Pass 1 — `seed-once`** over `engine/content/`:

```
sources (seed-once):
  prompts            ← engine/content/prompts/agents/*.md + context/*.md
  verifier-criteria  ← engine/content/prompts/agents/verifier/*.md  (renamed from reviewer/ in A1)
  templates          ← engine/content/templates/*.md + formats/*.txt
  agent-roles        ← engine/content/defaults/agents.yaml (one entry per role)
  workflow-stages    ← engine/content/prompts/stages.yaml
  work-item-kinds    ← engine/content/prompts/kinds.yaml
  analyzers          ← engine/content/prompts/analyzers/*.md

for each category:
  for each entry in source:
    if KV[category/key] does not exist:
      validate against Zod schema
      put KV[category/key] = parsed file contents
    else:
      leave KV alone (user edits win)
      if shipped hash differs from KV hash:
        mark KV row metadata.modifiedFromBaseline = true   # UI shows badge
```

**Pass 2 — `seed-mirror`** over `config/repos.yaml`:

```
yamlRepos = parseYaml("config/repos.yaml")?.repos ?? []
yamlIds = set of yamlRepos[*].id

# Upsert every yaml entry into KV with readonly flag
for each repo in yamlRepos:
  validate against Zod schema
  put KV["repos", repo.id] = {
    ...repo,
    metadata: { source: "yaml", readonly: true }
  }

# Remove KV repos that came from yaml but disappeared from yaml
for each kvRepo in kv.list("repos"):
  if kvRepo.metadata.source == "yaml" and kvRepo.id not in yamlIds:
    kv.delete("repos", kvRepo.id)

# UI-added repos (no readonly flag) are untouched
```

Path resolution goes through a single helper `resolveContentPath(category, name?)` so that bundled vs dev-mode lookup is in one place — engine code never hard-codes `engine/content/...` paths. Same with `resolveConfigPath("repos.yaml")` for the merge-mirror source.

Rules:

1. **Seed never overwrites.** If the user edited the prompt through the UI, it stays edited. Version mismatch with shipped → warning in log + UI indicator, no silent overwrite.
2. **Explicit reseed**: `--reseed prompts` CLI flag forces overwrite for that category. `--reseed all` for everything.
3. **Runs every startup**: first-launch and subsequent startups run the same pass. If KV is complete, the pass is a fast no-op (just presence checks). If categories are empty (fresh DB or `--reseed`), they are repopulated.
4. **Reseed from KV baseline**: on `--reseed`, the engine reads the shipped file, parses it, and writes to KV. The repo file is the baseline.

### 4.3 Why seed at every startup

Two reasons: (a) new categories added in the Operator repo automatically populate on upgrade without requiring explicit reseed, (b) corruption or missing rows are self-healing on restart. User's hot edit wins because the "already exists" check short-circuits.

### 4.4 Two seed modes: seed-once and seed-mirror

**Single rule for the engine:** runtime code reads everything from KV. The file system is touched only by `seed.ts` at startup. There are two modes for how `seed.ts` keeps KV in sync with the bundled / config files.

**Mode A — `seed-once` (default for `engine/content/*`):** prompts, templates, agent-roles, stage-defs, kind-defs, analyzers, verifier-criteria.

- Source: bundled with the engine in `engine/content/`
- Lifecycle: copied to KV **only if the row does not already exist**. Once a row is in KV, the file is never consulted again at runtime.
- User edits via UI: persist forever; never overwritten by upgrades.
- Upgrade behavior: new categories or new keys auto-populate; existing rows stay as the user left them. Mismatch between shipped file and KV row surfaces as a "modified from baseline" badge in the UI, no silent overwrite.
- Reseed: explicit `--reseed <category>` CLI flag pulls shipped baselines back over user edits in that category.
- Conceptually: shipped files are **bootstrap defaults / templates**. After first boot they are functionally inert — the engine no longer reads them. Future post-MVP work can add a "templates entity" so the user can pick from several shipped variants and reapply, but that is not in scope now.

**Mode B — `seed-mirror` (only for `config/repos.yaml`):** managed repos.

- Source: `config/repos.yaml` at repo root (committed during MVP for testing convenience, gitignored once UI write path lands and users provision repos through the app).
- Lifecycle: on every engine startup, `seed.ts` walks the yaml and **upserts** each entry into `kv:repos/{id}` with a `readonly: true` flag plus `source: "yaml"`. Repos in KV with `readonly: true` that are no longer in yaml are **deleted** from KV. The yaml file is the source of truth for everything tagged readonly.
- UI behavior: rows with `readonly: true` are shown but the editor is disabled — yaml manages them. Rows added through the UI come without the flag and are fully editable.
- Removing a repo: delete the line in yaml + restart, OR if it was UI-added, delete it from KV through the UI.
- Updating a repo: edit the line in yaml + restart, OR if it was UI-added, edit through the UI.
- Conflict rule: yaml-sourced rows always win on restart (the UI cannot override a readonly row — it would have to be removed from yaml first).
- Why this is special: `repos.yaml` is how an operator-as-service ships a "known set of managed repos" as predeployment config (Docker image, Kubernetes config map). Such config has to behave like static infrastructure, not like a user setting that survives across reboots. The rest of the categories (prompts, agents, stages, ...) are **user content** — once tuned, they should never be reset by yaml drift.

**Result:** runtime engine never branches on "where did this row come from." It always queries KV. The `readonly` flag is metadata the UI uses to gate edits — it has no effect on engine read paths. Two categories of seed behavior, one read path, no `ConfigSource` merge layer at runtime.

---

## 5. Storage — KVStore + Guard + RateLimiter as separate interfaces

Three interfaces in `@operator/core`. Local implementation in `@operator/adapters/kvstore-sqlite` can serve all three from one SQLite file. Cloud implementations are three separate adapters.

### 5.1 Interfaces

```typescript
// @operator/core/interfaces/kv-store.ts
export interface KVStore {
  get(category: string, key: string): Promise<unknown | null>;
  put(category: string, key: string, value: unknown, opts?: { ttlMs?: number }): Promise<void>;
  delete(category: string, key: string): Promise<void>;
  list(category: string, filter?: KVListFilter): Promise<Array<{ key: string; value: unknown }>>;
  close(): void;
}

export interface KVListFilter {
  readonly keyPrefix?: string;
  readonly where?: Record<string, unknown>;    // JSON field match
  readonly orderBy?: string;
  readonly order?: "asc" | "desc";
  readonly limit?: number;
  readonly offset?: number;
}

// @operator/core/interfaces/idempotency-guard.ts
export interface IdempotencyGuard {
  acquire(key: string, ttlMs: number, ctx: OperationContext): Promise<LockHandle | null>;
  complete(handle: LockHandle, ctx: OperationContext): Promise<void>;
  release(handle: LockHandle, ctx: OperationContext): Promise<void>;
}

// @operator/core/interfaces/rate-limiter.ts
export interface RateLimiter {
  allow(key: string, cost: number, ctx: OperationContext): Promise<{ allowed: boolean; retryAfterMs?: number }>;
  reset(key: string): Promise<void>;
}
```

### 5.2 Local SQLite implementation — one DB, three interfaces

`@operator/adapters/kvstore-sqlite` ships a single `LocalStorageBundle` that implements all three interfaces against one `operator.db` file with three tables:

```sql
-- Generic KV
CREATE TABLE kv (
  category TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,                -- JSON
  updated_at TEXT NOT NULL,
  expires_at TEXT,
  PRIMARY KEY (category, key)
);
CREATE INDEX idx_kv_category ON kv(category);

-- Idempotency locks (could live in kv, separated for clarity + TTL semantics)
CREATE TABLE locks (
  lock_key TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  acquired_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

-- Rate limit counters
CREATE TABLE rate_buckets (
  bucket_key TEXT PRIMARY KEY,
  tokens REAL NOT NULL,
  updated_at TEXT NOT NULL,
  limit_per_window REAL NOT NULL,
  window_ms INTEGER NOT NULL
);
```

Single file, WAL mode, one shared connection pool. User runs Operator and the UI app against the same `state/operator.db` — app opens in read-only mode, engine in read-write.

### 5.3 Cloud implementations (post-MVP)

Three separate adapter packages, each maps to a different Cloud API:

| Interface | Cloud API | Adapter |
|---|---|---|
| `KVStore` | Storage (`/api/v1/storage/*`) | `@operator/adapters/kvstore-cloud` |
| `IdempotencyGuard` | Shield (`/api/v1/shield/*`) | `@operator/adapters/guard-cloud` |
| `RateLimiter` | Guard (`/api/v1/guard/*`) | `@operator/adapters/rate-limiter-cloud` |

Swap at composition root via `CLOUD_API_KEY` env var. Swap is independent per interface — user can take Cloud Storage while keeping local locks.

### 5.4 KV categories used by the engine

```
# Work state (rebuildable from files on syncFromFiles)
work-items/{id}                              current WorkItem state (synced from files)
work-item-history/{id}/{seq}                 state transitions per item

# Execution history (KV only — derived)
executions/{executionId}                     execution metadata
execution-events/{executionId}/{seq}         per-step events within an execution
execution-logs/{executionId}                 attached log blob

# Scheduling / dedup (KV only)
schedule/{repoId}/{stageName}                last-run timestamp
known-items/{repoId}/{sourceKey}             dedup
outcomes/{workItemId}                        post-delivery observations
recovery/{id}                                interrupted-run queue
notifications/{id}                           sent notification log

# Runtime config — seed-once mode (UI editable, file is bootstrap baseline only)
prompts/{topic}                              layer 5-6 prompts
verifier-criteria/{stageName}                stage-scoped verifier criteria (renamed from reviewer-criteria in A1)
templates/{name}                             PR body templates
agent-roles/{roleName}                       agent configuration
analyzers/{stageName}/{analyzerId}           analyzer definitions
workflow-stages/{stageName}                  stage configuration
work-item-kinds/{kindName}                   kind definitions

# Runtime config — seed-mirror mode (yaml is source of truth for readonly rows)
repos/{id}                                   managed repo entries
                                             metadata.source = "yaml" | "ui"
                                             metadata.readonly = true if source=="yaml"

# Infrastructure (not through KVStore — separate tables under same DB)
locks table                                  IdempotencyGuard backing
rate_buckets table                           RateLimiter backing
```

Engine **always** queries `kv:repos/*` for the managed repo list — there is no special "look at the yaml file" code path at runtime. The yaml is a seed input, not a runtime input. UI write paths gate on `metadata.readonly` to disable editing for yaml-sourced rows.

---

## 6. Sync contract — who writes what, when

The rule the v4 code never stated clearly. Final v5 rule:

### 6.1 Agents only write to workspace files

An agent run produces changes in the managed repo's working directory. Agents never touch the KV store. Period.

### 6.2 Orchestrator owns KV writes

Only primitives inside `run-stage.ts` write to KV. That means:

- `persist-output.ts` writes new execution entries, updates work item state, records outputs.
- `route-verdict.ts` writes final status and notification events.
- `recovery-journal.ts` writes per-step events.
- `syncFromFiles` (runs at cycle start) writes work item state from file frontmatter.
- `seed.ts` (runs at startup) writes runtime config baselines.

No other code writes to KV. No stage-specific logic writes to KV. No agent handler writes to KV.

### 6.3 syncFromFiles resolves drift

At the start of every cycle, before any stage runs:

```
1. workspaceEnsure + workspaceSync         # pull latest base branch
2. read .operator/data/{findings,tasks,retrospectives}/*.md
3. parse frontmatter → WorkItem records
4. for each parsed item:
     if KV[work-items/{id}] exists AND is in terminal state AND file != terminal:
       log warning, do nothing (terminal state is sticky)
     else if KV has open PR reference AND file is still pending:
       KV state dominates (open PR in-flight — agent hasn't committed the file update yet)
     else:
       KV[work-items/{id}] = file state
5. for each open AI PR on VCS:
     refresh KV[work-items/{id}].status from PR label
```

This mean: **merged files win over KV defaults**, **in-flight PRs win over file state**, **terminal state is sticky**. One reconciler at one place.

### 6.4 Agent modifies file → persistOutput commits → KV updated

Full write path in a stage run:

```
invokeAgent                       agent modifies workspace files
                                  ↓
persistOutput (FileOutputAdapter)
  1. git add -A                   stage the changes
  2. git commit                   commit with generated message
  3. git push                     fast-forward only
  4. upsert PR                    create or update via VCS
  5. apply labels                 via PRManager
  6. kv.put("work-items/{id}")    set status to in-review
  7. kv.put("executions/{id}")    add execution entry
                                  ↓
routeVerdict
  8. kv.put("work-item-history")  append transition
  9. fire notifications           if terminal failure
```

No agent code writes to KV. No orchestrator code writes to workspace files (except `initWorkspace` which checks out branches and `persistOutput` which commits).

---

## 7. Execution history — MVP minimal schema

Designed around user's observability needs: "entry point is task ID or PR ID, drill into executions, drill into events, see full logs."

### 7.1 Categories

```
executions/{executionId}                 metadata: stage, agent, started, finished, verdict, cost
execution-events/{executionId}/{seq}     per-step events: timestamp, type, payload
execution-logs/{executionId}             full log blob (compressed JSON array)
```

### 7.2 Execution metadata entry

```typescript
interface ExecutionEntry {
  readonly id: string;                // UUID
  readonly traceId: string;
  readonly repoId: string;
  readonly stageName: string;
  readonly agent: string;
  readonly workItemId?: string;       // present for item-scoped stages
  readonly prNumber?: number;         // present after persistOutput in file mode
  readonly scopeKey: string;
  readonly startedAt: string;
  readonly finishedAt?: string;
  readonly durationMs?: number;
  readonly costUsd?: number;
  readonly attempts: number;
  readonly verdict?: "approved" | "failed" | "cancelled" | "rejected";
  readonly summary?: string;          // verifier's Execution Summary block
  readonly status: "running" | "completed" | "failed" | "interrupted";
  readonly error?: string;
}
```

### 7.3 Event entry

```typescript
interface ExecutionEvent {
  readonly seq: number;
  readonly timestamp: string;
  readonly type: EventType;           // discriminated union
  readonly message: string;           // short human-readable
  readonly payload?: unknown;         // type-specific details
}

type EventType =
  | "stage.started"
  | "input.selected"
  | "workspace.prepared"
  | "context.built"
  | "prompt.built"
  | "agent.spawned"
  | "agent.output"
  | "verify.started"
  | "verify.result"
  | "review.started"
  | "review.verdict"
  | "persist.started"
  | "persist.result"
  | "route.verdict"
  | "stage.completed"
  | "stage.failed";
```

Each primitive writes one or more events as it runs. Events are append-only within an execution — never rewritten.

### 7.4 Log blob

Raw agent stdout, verify output, verifier output — anything verbose. Stored as compressed JSON array under `execution-logs/{executionId}`. Retrieved only when UI drills into an event that references it.

### 7.5 Query patterns the UI needs

```
"Show me executions for work item T123"
   → kv.list("executions", { where: { workItemId: "T123" }, orderBy: "startedAt", order: "desc" })

"Show me executions touching PR #456"
   → kv.list("executions", { where: { prNumber: 456 }, orderBy: "startedAt" })

"Show me events for execution exec-abc"
   → kv.list("execution-events", { keyPrefix: "exec-abc/", orderBy: "seq" })

"Show me the log blob for execution exec-abc"
   → kv.get("execution-logs", "exec-abc")

"Show me all failed executions in the last 24h"
   → kv.list("executions", { where: { status: "failed" }, orderBy: "startedAt", order: "desc", limit: 100 })
```

Three-panel UI maps directly: left panel = category navigator, middle = list filtered by selected category, right = details for selected entry. No domain knowledge in the UI beyond "render JSON, group by categories."

### 7.6 Observability is grounded in PRs and KV together

Every stage produces a PR — there are no stages without one. Querying execution history by `prNumber` always works because every execution entry has it. Querying by `workItemId` works because every execution targeting an item has both `workItemId` and `prNumber`.

The user's frustration from v4 ("getting logs to see why and how executed") is addressed by the `execution-events/*` timeline: every step writes an event, the log blob carries the raw text, the UI renders both. The UI does not need a special path for "stages without PRs" because there are none.

---

## 8. Kind registry — open strings from day 1

### 8.1 No closed union

`WorkItem.kind` is `string`, not `"finding" | "task" | "request"`. Kind definitions live in `agents/workflow/kinds.yaml`:

```yaml
kinds:
  finding:
    label: Finding
    idPrefix: F
    dataDir: findings
    branchPrefix: ai/findings
    prPrefix: "[AI:Finding]"
    terminalStatuses: [completed, failed, rejected, duplicate]

  task:
    label: Task
    idPrefix: T
    dataDir: tasks
    branchPrefix: ai/tasks
    prPrefix: "[AI:Task]"
    terminalStatuses: [completed, failed, rejected, duplicate, cancelled]

  request:
    label: Request
    idPrefix: R
    dataDir: requests
    branchPrefix: ai/requests
    prPrefix: "[AI:Request]"
    terminalStatuses: [completed, rejected]
```

Seeded into KV category `work-item-kinds/{kindName}`. Engine queries kind registry through `kinds.get("finding")` / `kinds.list()` methods on a `KindRegistry` interface. Adding a new kind = editing kinds.yaml + reseeding (or editing via UI).

### 8.2 Pattern and terminal checks

No more `isFindingTerminal` / `isTaskTerminal`. One function:

```typescript
function isTerminal(kind: WorkItemKind, status: WorkItemStatus): boolean {
  return kind.terminalStatuses.includes(status);
}
```

### 8.3 ID generation

No more `generateFindingId` / `generateTaskId`. One function:

```typescript
async function generateItemId(
  kindName: string,
  kinds: KindRegistry,
  kv: KVStore,
  date: string,
): Promise<string> {
  const kind = await kinds.get(kindName);
  const seq = await nextSequence(kv, kind, date);
  return `${kind.idPrefix}${date}-${String(seq).padStart(4, "0")}`;
}
```

Task-parent-encoded IDs (`T20260413-000101` meaning "task under finding-0001") are dropped. Parent linkage lives in `WorkItem.parentId` field, not in the ID string.

---

## 9. Scope keys and locks

Every stage has a strategy that produces a `strategyKey`. Combined with the stage name, it forms a scope key. Scope key is used for locks and for event correlation.

| branchScope | strategyKey format | Example |
|---|---|---|
| `per-item` | `{workItemId}` | `T20260413-0001` |
| `singleton:day` | `{YYYY-MM-DD}` | `2026-04-13` |
| `singleton:week` | `{YYYYWnn}` | `2026W16` |
| `singleton:bootstrap` | `bootstrap` | `bootstrap` |
| `pr` | `{prNumber}` | `456` |
| `analyzer` | `{analyzerFileName}` | `security.md` |

Final scope key: `{stageName}:{strategyKey}`.
Lock key: `lock:{repoId}:stage:{stageName}:{strategyKey}`.

One consistent format. One place (`resolveScopeKey` in `item-selector.ts`) computes it. Stage config declares the branchScope, everything else follows.

---

## 10. Trigger model and input selectors

### 10.1 Schedule semantics (MVP)

Every stage has a `schedule` field (cron string). Triggering = "does the schedule say it is due right now?". `Engine.runOnce` iterates configured stages, checks each `schedule` against the current time, calls `runStage` for the ones that are due. Past-due stages don't queue up — if multiple ticks were missed, the stage runs once on the next due tick.

Cron resolution: minute precision. Per-second cron is intentionally not supported in MVP because the daemon's wake interval is the lower bound on dispatch latency.

PR-feedback-handling stages (e.g. the sample `pr-review` / supervisor) are not special — same `schedule + selector` shape as every other stage. The `pr-feedback` selector strategy filters open AI PRs by comment freshness; that is the entire dispatch logic.

### 10.2 Built-in selector strategies

A `selector` field on each stage names which input strategy to use. The MVP set is **four** strategies — no more:

| Strategy | Purpose | Selector config | Returns |
|---|---|---|---|
| `per-item` | Pick one pending work item from KV by kind+status | `{kind, status, orderBy, limit}` | `{ workItemId, scopeKey }` or null |
| `singleton` | Dedupe by current cron fire window. Period derives from the stage's `schedule`. For `schedule: on-start` (init), scopeKey = `"bootstrap"` and returns null after first success | none | `{ scopeKey }` or null |
| `discovery` | Iterate analyzer definition files matching glob, return one analyzer per call | `{ glob }` | `{ analyzerPath, scopeKey }` per match |
| `pr-feedback` | Iterate open AI PRs, return one with fresh human comments since last execution | `{ branchPrefixes, ignoreBots }` | `{ prNumber, scopeKey, comments }` or null |

`singleton` replaces the old `singleton:day` / `singleton:week` / `singleton:bootstrap` split — the cron expression already encodes the period (`0 8 * * *` is daily, `0 9 * * 1` is weekly), so the selector just computes "what is the most recent cron fire time?" and uses that as scopeKey. One strategy, every period.

`pr-feedback` replaces the old `unread-comments` name — channel-neutral framing. Future external sources (Jira issue comments, etc.) get their own per-source selectors in adapter packages, not configurable channels on a single generic selector.

Each strategy implements one interface:

```typescript
// @operator/core/interfaces/input-selector.ts
export interface InputSelector<TInput, TConfig> {
  readonly name: string;
  pickOne(
    config: TConfig,
    deps: SelectorDeps,
    ctx: OperationContext,
  ): Promise<TInput | null>;
}

export interface SelectorDeps {
  readonly kv: KVStore;
  readonly vcs: VCSPlatform;
  readonly tracker: Tracker;            // external work item source
  readonly clock: Clock;
}
```

### 10.3 Selector registry — open by design

Strategies are registered in `engine/src/pipeline/selectors/registry.ts`:

```typescript
import { perItemSelector } from "./per-item.js";
import { singletonSelector } from "./singleton.js";
import { discoverySelector } from "./discovery.js";
import { prFeedbackSelector } from "./pr-feedback.js";

const builtIn = new Map<string, InputSelector<unknown, unknown>>([
  ["per-item", perItemSelector],
  ["singleton", singletonSelector],
  ["discovery", discoverySelector],
  ["pr-feedback", prFeedbackSelector],
]);

export function createSelectorRegistry(
  custom: Map<string, InputSelector<unknown, unknown>> = new Map(),
): Map<string, InputSelector<unknown, unknown>> {
  return new Map([...builtIn, ...custom]);
}
```

`runStage` looks up the strategy by `stageDef.selector` and calls `pickOne`. No enum constraint — the string lands in the registry, returns the implementation, runs. Adding a strategy = writing one file + one registry entry.

The composition root (`entry.ts`) builds the registry. Adapter packages may ship additional selectors that the user wires in via composition. This is the only way the engine learns about input shapes.

### 10.4 How upstream stages feed downstream stages — example chain

The canonical "stage A produces work items consumed by stage B" pattern. It generalizes through one mechanism: **files in git + syncFromFiles + per-item selector**.

> Example below uses sample demo-config stage names (`research` → `finding-plan` → `task-execute`) as a concrete chain. A different repo's chain could be named anything — engine code does not care.

```
upstream stage (e.g. research)            planner stage (e.g. finding-plan)           executor stage (e.g. task-execute)
──────────────                            ──────────────────                          ──────────────────
selector: discovery                       selector: per-item                          selector: per-item
  iterates analyzer files                   config: {kind:finding,                     config: {kind:task,
                                              status:pending}                            status:pending}
agent: <analyst role>                     agent: <planner role>                       agent: <executor role>
  emits EMIT child-item kind=finding        emits EMIT child-item kind=task            edits files in repo
  applier writes .operator/data/            applier writes .operator/data/
  findings/F*.md files                      tasks/T*.md files
merge: gated                              merge: gated                                merge: gated
  PR per cycle                              PR per finding                              PR per task
```

The chain is wired through three things:

1. **File commits** — each stage commits markdown files under `.operator/data/{kind}/`. Files are the durable record visible in git history. The orchestrator (`WorkItemSource.create`) owns frontmatter authorship — agents emit `EMIT child-item` records, never raw frontmatter.
2. **`syncFromFiles`** at the start of every cycle — reads `.operator/data/**/*.md`, parses frontmatter, upserts `kv:work-items/{id}` entries. This is where "a new finding file appears on develop" turns into "a pending finding in KV".
3. **`per-item` selector with `kind` filter** — the planner stage selects `kind:finding, status:pending`; the executor stage selects `kind:task, status:pending`. Same selector code, different config.

There is no direct call from one stage to another. They are decoupled by the file system and KV. Consequences:

- A human can create a finding by hand (write the file, push, next cycle picks it up).
- A different stage can produce findings (any agent that writes to `.operator/data/findings/` and commits).
- The downstream stage does not care where its inputs came from.

### 10.5 External sources are cron tasks, not stages

If the user wants to source work from outside the repo (Jira, Linear, Sentry, CI failures, webhooks), the answer is **not** "write a special stage type" or "add a configurable selector channel." The answer is one cron task that creates a markdown file under `.operator/data/findings/` (or `tasks/`), commits it, pushes it. From that point on, the existing chain handles it as a normal finding.

```typescript
// engine/src/cron/jira-import.ts  (illustrative shape)
export async function jiraImportCron(deps: CronDeps, ctx: OperationContext) {
  const issues = await deps.jiraClient.search({
    jql: 'labels = "ai-ready" AND status = "To Do"',
  });
  for (const issue of issues) {
    const id = `F-jira-${issue.key}`;
    const filePath = `.operator/data/findings/${id}.md`;
    if (await deps.git.fileExists(filePath)) continue;        // dedup
    await deps.git.writeFile(filePath, renderJiraToFinding(issue));
    await deps.git.commit(`Import Jira ${issue.key}`);
    await deps.git.push("develop");                           // direct push, no PR
    // syncFromFiles next cycle puts it into kv:work-items/
    // finding-plan picks it up like any other finding
  }
}
```

Key properties:

- **No new agent.** No LLM in the import step. Cron tasks are pure code.
- **No new selector.** The downstream chain still uses `per-item`.
- **No new stage type.** This is a cron task, not a stage. Lives in `engine/src/cron/`.
- **No write-back to Jira from the engine.** If the user wants "post a comment to Jira when the task PR merges," that is **another** cron task watching for merged AI PRs and calling Jira. Each side is one direction.
- **Direct push to develop is allowed for cron tasks** because they are not LLM output — they are deterministic data ingestion. Cron tasks can never violate the "no force-push" rule because they only ever fast-forward push new files. They never overwrite history.

This is the test of whether the architecture holds: adding a new external source = one file in `engine/src/cron/` plus its registration in `Engine.runOnce`. No changes to `runStage`, no changes to selectors, no changes to `AgentRuntime`, no changes to KV schema. The downstream LLM pipeline is unaware that the source exists.

### 10.6 Post-MVP: event triggers

In MVP, every stage is cron-triggered. Latency is bounded by the daemon wake interval (30s) plus the stage's cron resolution.

Post-MVP, `Engine.runOnce` may additionally accept event payloads from external dispatchers (webhook receiver, message queue consumer). A stage with `trigger: "event:pr-comment"` runs immediately on receipt of the matching event instead of waiting for the next cron tick. The stage body and selector logic stay identical — the only change is the dispatcher's "is this stage due?" check.

The PR-feedback-handling stage (the sample supervisor or any equivalent in another repo) is the obvious first customer: instead of polling every 5 minutes, a GitHub webhook fires `pull_request_review_comment.created` and the dispatcher invokes `runStage(stageDef, { eventHint: { prNumber: N } })`. The `pr-feedback` selector accepts the optional `prNumber` hint to skip iteration. The rest of the loop is unchanged.

---

## 11. Agent runtime — preserved from current code

`engine/agents/runtime.ts` keeps its current shape:

- `AgentRuntime.run(input, ctx)` — spawns CLI, verifies, reviews, retries, parses verdict.
- 5-verdict vocabulary: `approved | retry | failed | cancelled | rejected`.
- Internal retry loop for LLM-level mistakes.
- Terminal verdicts throw `AgentError` with `phase` field.
- Error context truncation to avoid `spawn E2BIG`.
- Lock on `agent:{name}:{repoId}` via `IdempotencyGuard`.

One change: verifier prompts must now include `## Execution Summary` block alongside `## Verdict`, and `parseReviewVerdict` extracts both. When summary is missing (old prompt), a placeholder is generated from verdict + feedback. Backward-compatible.

---

## 12. Prompt system — 6 layers through PromptSource

Same contract as current code:

```
1. Global context          .claude/rules/CLAUDE.md            file read
2. Bundled base            prompts/context/{name}             KV lookup
3. Project context         .operator/context/*.md             file read
4. Role rules              .operator/{role}/*.md              file read
5. Phase rules             .operator/{rulesFrom}/*.md         file read
6. Agent instructions      prompts/{role}                     KV lookup
                         + .operator/agents/{role}.md         file read (appends)
7. Verifier criteria       verifier-criteria/{stageName}      KV lookup (renamed from
                                                              reviewer in A1)
                         + .operator/agents/verifier/{stg}.md file read (appends)
```

Layers 2, 6, 7 go through `PromptSource.loadChain(topic)`. The KV-backed implementation queries `prompts/{topic}` as the system layer and appends the filesystem user layer.

Implementation: `KVPromptSource` in `@operator/engine/agents/kv-prompt-source.ts` — wraps a `KVStore` instance plus an `automationDir` for file reads. Replaces current `FilePromptSource` (which becomes a bootstrap-only helper used by `seed.ts` to import prompts into KV on first run).

---

## 13. Communication and notifications

### 13.1 Channels

```typescript
interface NotificationChannel {
  readonly id: string;
  send(event: NotificationEvent, ctx: OperationContext): Promise<void>;
}
```

MVP ships two channels:

- **GitHubChannel** — always registered. Posts PR comments for stages in file mode. Uses `PRManager.postBotComment`.
- **ConsoleChannel** — always registered. Writes terminal failures to stdout via pino at `warn` level. Free visibility fallback.

Post-MVP: `SlackChannel`, `TelegramChannel`, `WebhookChannel` as npm packages implementing the same interface.

### 13.2 Router

`NotificationRouter` subscribes to events on the EventBus. Per-event handlers decide which channels fire. Configuration per-project in `repos.yaml`:

```yaml
repos:
  - id: <repo-id>
    notifications:
      channels:
        - github
        - console
      events:
        terminal-failure: [github, console]
        task-completed: [github]
```

### 13.3 Mandatory visibility floor

Every stage produces a PR; every terminal failure leaves the PR open with an `ai:failed` label and an `executions/*` entry in KV. That is the always-on visibility floor — no extra channel needed for failures to be discoverable. External channels (Slack, Telegram, etc.) layer on top for low-latency push, not for "otherwise invisible" cases.

---

## 14. No dead code rule

Enforced at two levels:

1. **ESLint rule**: `no-unused-exports` plus custom rule that flags classes/functions not reachable from `engine/entry.ts`'s import closure. Runs in CI, blocks PR merges.
2. **Review rule**: every PR description answers "what did this PR delete." If nothing, the reviewer asks why there is still unused code.

Dead code scan is step 0 of the migration. Known dead code candidates that get deleted before any refactoring begins:

- `BaseStage` abstract class and all `*Stage extends BaseStage` subclasses (never instantiated)
- `LocalStateStore` (instantiated but never passed)
- `NoOpOutcomeMemory` (instantiated but never passed)
- `NoOpRateLimiter` (not instantiated at all)
- `ConcurrencyController` if not wired (pending verification)
- Any `test-helpers/` fake not used by any test

If something needs to come back later, the migration doc records *why* and *when* — but it does not live in the repo as unused code in the meantime.

---

## 15. Invariants — architectural rules that never bend

Beyond the behavioral invariants in `workflow.md §15` and product invariants in `vision.md §10`, the engine enforces these architectural rules:

1. **Layer import graph is enforced by ESLint.** Core does not import adapters. Adapters do not import engine. Engine does not import app. App does not import engine runtime.
2. **Composition root is `engine/entry.ts` and only `engine/entry.ts`.** No other file instantiates cross-layer classes.
3. **`OperationContext` threads through every I/O function.** Function without `ctx` parameter either takes no I/O or is a bug.
4. **No file in `pipeline/` exceeds 200 lines.** If it does, a primitive is leaking.
5. **`entry.ts` never contains stage-specific logic.** No case blocks. Only seed + composition + start.
6. **Every primitive has a unit test.** `pipeline/primitives/*.test.ts` is colocated, coverage >= 95%.
7. **No default exports.** Named exports only.
8. **`types/` in core contains zero runtime code.** Interfaces, type aliases, and error class declarations only.
9. **Agents only write workspace files.** KV writes come from primitives inside `run-stage.ts`.
10. **Seed functions never overwrite existing KV entries** unless explicitly invoked with `--reseed`.
11. **Every stage execution produces an `executions/*` KV entry**, even when it fails. The UI must always have something to show.
12. **No dead code.** Audited at every PR by ESLint + CI.
13. **No future-shaped code.** Architecture documents future packages and integrations openly (this document lists `kvstore-cloud`, `guard-cloud`, etc. with paths and intent). Code does not. There is no `if (backend === "cloud") throw new Error("not implemented")`, no closed-union with one variant marked "future", no dropdown option that is disabled, no commented-out import, no stub class with throwing methods. When a future package lands, it lands in **one PR** that adds the package, extends every consumer that needed to change, and ships working — never half-wired. Until that PR exists, the codebase has zero traces of it. The architecture document is the only place where the future is allowed to leak in.
14. **`@operator/app` uses KVStore via factory only.** `app/src/**` cannot import `@operator/adapters/kvstore-sqlite` (or any other adapter) directly — only through `app/src/lib/kv-factory.ts`. The factory is the single choke point for backend selection. ESLint enforces this with `no-restricted-imports`.

---

## 15a. App composition — multi-instance shell

The `@operator/app` is **not** a single-instance viewer. It is a shell that connects to one or more Operator instances and lets the user switch between them. Its own state — connection registry, active connection, UI preferences — lives in a separate KVStore at `${OPERATOR_APP_DB_PATH:-${appConfigDir}/operator-app/app.db}`.

```
App runtime
├─ App-internal KVStore         path: env-paths('operator-app').config + '/app.db'
│  └─ categories:
│       connections/{id}            saved connections (sqlite path, name, etc.)
│       app-state/last-active       last selected connection id
│       app-state/preferences       UI prefs (sidebar collapsed, theme)
│  Implementation: LocalStorageBundle (same adapter as engine/operator state)
│
└─ Active Operator KVStore     instantiated lazily per selected connection
   └─ categories: prompts, workflow-stages, work-items, executions, ...
   Implementation: chosen by createKVStoreForConnection(conn) factory
                   → MVP: only LocalStorageBundle
                   → Future: factory grows when a new adapter package lands
```

The same `LocalStorageBundle` adapter serves three contexts: engine runtime state (`state/operator.db`), app-internal state (`~/.config/operator-app/app.db`), and any connected SQLite Operator instance (arbitrary path). The adapter does not know what category of data it stores — it is just a `KVStore` on disk.

### 15a.1 Connection record (MVP, sqlite-only)

```typescript
// MVP shape — sqlite is the only backend, no discriminator
interface Connection {
  readonly id: string;                // UUID
  readonly name: string;              // display name, e.g. "sample-local"
  readonly dbPath: string;            // absolute path to operator state.db
  readonly createdAt: string;
  readonly lastUsedAt?: string;
}
```

When a future backend lands, this type **becomes** a discriminated union and the factory grows a switch — both in the same PR that ships the new adapter. There is no MVP-time discriminator with one variant.

### 15a.2 Factory

```typescript
// app/src/lib/kv-factory.ts (MVP)
import { LocalStorageBundle } from "@operator/adapters/kvstore-sqlite";
import type { Connection } from "./connection-types.js";
import type { KVStore } from "@operator/core";

export function createKVStoreForConnection(conn: Connection): KVStore {
  return new LocalStorageBundle({ dbPath: conn.dbPath });
}
```

That is the entire factory in MVP. One line. No switch, no future branches. When `kvstore-cloud` lands, that PR rewrites this function into a switch and rewrites `Connection` into a union — atomically.

### 15a.3 Two API surfaces in `app/src/app/api/`

```
/api/app/connections/*       app-internal CRUD on the connections registry
                             (writes to app.db via app-internal KVStore)
                             
/api/kv/[category]/[key]     CRUD on the currently active operator instance's KV
                             (writes to the active connection's KVStore via factory)
                             routed by header X-Operator-Connection-Id
```

The two surfaces are intentionally separate. `/api/app/*` never touches operator instance state. `/api/kv/*` never touches app-internal state. Crossing those wires would be a security and correctness hole — explicit boundary.

### 15a.4 Bootstrap behaviour

- **First run, no `app.db`** — created empty. UI shows empty state "Add your first connection."
- **Dev convenience** — if `OPERATOR_DB_PATH` env var is set AND `connections/*` is empty, app auto-creates a connection named `default` pointing at that path and selects it. This makes `npm run dev --workspace app` work against the local engine without manual setup.
- **App config dir** — `env-paths('operator-app').config` (cross-platform: `~/.config/...`, `~/Library/Application Support/...`, `%APPDATA%\...`). Override via `OPERATOR_APP_DB_PATH` env var.

### 15a.5 UI shape

Left rail with three icon buttons (Instances, Add, Settings) that expand to a wider sidebar showing the connection list with active indicator and "+ Add connection" entry. Selecting a connection mounts its KVStore (lazy, kept in a `Map<connectionId, KVStore>` for fast switching), updates `app-state/last-active`, and re-renders the per-instance views (Work Items, Executions, Prompts, Config) against the new active KV.

```
┌──┬──────────────────────────────────────────────┐
│⎘ │  active: sample-prod ▼                        │
│  │  ──────────────────────────────────────────── │
│✚ │  Work Items   Executions   Prompts   Config   │
│  │  ──────────────────────────────────────────── │
│⚙ │  [content of selected view, queries the      │
│  │   active operator instance's KVStore]         │
└──┴──────────────────────────────────────────────┘
```

---

## 16. What MVP ships, what comes later

### MVP (this rebuild)

- `@operator/engine` with `run-stage.ts` as the single stage code path
- All MVP stages from §4.1 as KV-seeded config
- `@operator/core` with all interfaces
- `@operator/adapters/kvstore-sqlite` (local default, serves KVStore + Guard + RateLimiter)
- `@operator/app` (Next.js) reading the KV store directly for observability
- GitHub VCS; two CLI agent providers behind the universal wrapper (Claude Code for analysis/review, Cursor Agent / Composer for code-writing roles)
- GitHub + Console notification channels
- Per-item execution history with verifier summary
- All stages produce PRs through `FileOutputAdapter` — no virtual mode, no second adapter
- Open kind registry (seeded from `engine/content/prompts/kinds.yaml`)

### Post-MVP (same engine, more config/adapters)

- Cloud adapters: `kvstore-cloud`, `guard-cloud`, `rate-limiter-cloud`
- Vector search for `OutcomeMemory` via Cloud Memory
- `SlackChannel`, `TelegramChannel`, `WebhookChannel`
- `merge: auto` adopted by non-code stages (e.g. the sample `retrospective` / `research`) once trust builds (per workflow.md §6.2)
- Additional agent providers (OpenCode, Kiro)
- Additional VCS platforms (GitLab, Bitbucket)
- Event-driven triggers (`trigger: "event:pr-comment"`)
- Control Plane HTTP API exposing KV data to external clients
- Multi-tenant hosted UI

---

## 17. Open questions still TBD (explicit non-decisions)

These are NOT blocked by this document — they can be decided during migration steps where they become relevant.

1. **Exact wire format for `execution-logs/*` blobs.** Compressed JSON vs plain text vs streaming. Decided when `invokeAgent` is refactored.
2. **`RateLimiter` usage in MVP.** Scaffold exists, unclear if any MVP stage actually rate-limits. Might be instantiated as pass-through until a real limit is needed.
3. **Recovery queue semantics.** Currently scaffolded, unused. Decided when first recovery scenario is exercised.
4. **UI ↔ engine write path.** MVP UI is read-only; "user edits prompt through UI" writes directly to KV (same SQLite file, WAL mode handles concurrent writes). Whether this needs a mutex or a thin API is decided when the first write flow lands.
5. **First stage to flip from `merge: gated` to `merge: auto`.** Almost certainly a non-code stage (e.g. the sample `retrospective`) once a few weeks of human approvals show low rejection rate. Decided per-project after trust builds (§6.2 of workflow.md).

---

## 18. Summary

v5 is not a rewrite — it is a **re-composition**. Every load-bearing module from the current code (`AgentRuntime`, `PromptSource`, `PRManager`, `WorkspaceGit`, `GitHubVCS`, `SQLiteStateManager`, `IdempotencyGuard`, `BaseStage`) survives in some form. What changes is:

1. **Packaging** — monorepo with clear layer boundaries enforced by ESLint.
2. **Primitives** — one step per file under `pipeline/primitives/`, composed by `run-stage.ts`.
3. **Storage** — `KVStore` as single generic abstraction, seeded from repo files at startup.
4. **Dispatch** — `runStage(stageDef)` called from a tight `entry.ts`, no `switch (action)`.
5. **History** — per-item execution timeline queryable from UI.
6. **Kinds** — open strings, config-driven, no closed unions.
7. **Dead code** — gone. Forever.

The result is a codebase where adding a new kind is a yaml edit, adding a new analyzer is dropping a file in `.operator/stages/{name}/`, and adding a new storage backend is one adapter package. None of those operations require touching `entry.ts` or `run-stage.ts`.
