---
paths:
  - "engine/**"
  - "packages/*/src/**"
  - "app/src/**"
  - "package.json"
  - "packages/*/package.json"
  - "app/package.json"
  - "tsconfig.json"
  - "vitest.config.ts"
---

# Operator TypeScript Rules (v5 Target)

Code lives in `engine/` (flat, no `src/` sub-directory), plus `packages/core/src/`, `packages/adapters/src/`, and `app/src/`. Root `package.json` is the `@operator/engine` workspace itself; `packages/*` and `app/` are separate workspaces.

Paired with:
- `docs/architecture-v5.md` — target shape
- `docs/workflow.md` — behavior contract (8-step run loop)
- the v4 post-mortem (no longer in this repo) — what NOT to do

## FORBIDDEN

- **🚨 SUPER CRITICAL — Re-selecting a work-item whose authoring PR closed with a terminal disposition. 🚨** When the orchestrator's PR for a work-item closes (closed-without-merge), is rejected, cancelled, or marked duplicate, the work-item ITSELF transitions to `rejected` (or the kind-specific terminal). Selectors (`per-item`, `pr-feedback`, `discovery`, future) MUST filter terminal items out unconditionally — `kindRegistry.isTerminal(kind, status) === true` ⇒ skip. Applies to ALL kinds: `finding`, `task`, `request`, `retrospective-cycle`, `agent-improvement`, every future kind. There is no "retry on next cycle" path. Recovery is human-only: a human edits the work-item file or removes the rejection-ledger row, and only then can the selector re-pick. Code-side enforcement: every selector implementation has an explicit terminal-skip clause keyed on `kindRegistry.terminalStatusesFor(kind)`; CI test asserts no selector returns an item whose status is in its kind's terminal set. See `intelligence/rules/context.md`.
- **🚨 SUPER CRITICAL — Direct commits / pushes to `develop` / `master` / `main`. 🚨** Operator NEVER targets base branches as a push or PR-head ref. Forbidden API surfaces: `git.push("develop")`, `vcs.createCodeReview({headBranch: "develop" | "master" | "main"})`, any helper that opens a commit against those refs. Operator authors only `ai/<kind>/<id>` feature branches; merging to `develop` is a human or external-automation action. Do not surface this as an option even in design comparisons. See `intelligence/rules/context.md`.
- **Dead code.** Every exported symbol must be reachable from `engine/entry.ts` import closure or from a colocated test. `ts-prune` is your friend and CI gate. Examples that got deleted in v4: `BaseStage` abstract class with zero instantiations, `LocalStateStore` instantiated but never passed, `NoOpOutcomeMemory` instantiated but never passed. None of this lands in v5.
- **Direct `git.*` calls outside `engine/pipeline/primitives/`.** `WorkspaceScope` primitive is the only place that decides "create branch vs checkout existing." Violations caused the 2026-04-13 non-fast-forward incident.
- **Force-push in any form.** `git.push --force`, `git.push --force-with-lease`, any `+refspec` — all forbidden. Fast-forward only.
- **Direct `PRManager.*`, `VCSPlatform.*`, `AgentRuntime.*` calls outside `engine/pipeline/primitives/`.** Stages compose primitives, they do not reach past the boundary.
- **`switch (action)` block in `entry.ts`.** v5 engine iterates stages from KV and calls `runStage(stageDef)` — there is no action dispatch in the composition root.
  - **Migration exception**: until Step 12 merges, `entry.ts` retains a `switch (action)` block for the stages that have not yet migrated to `runStage` (`finding-*`, `task-*`, `pr-review`, `research`, `improver`). This is tracked and scheduled for removal. New migrations MUST reduce, never grow, the set of case blocks. From Step 12 onward the block is entirely gone and this rule returns to zero-tolerance.
- **New files under `engine/pipeline/stages/`.** In v5 this directory does not exist. Stages are config in `agents/workflow/stages.yaml`, not code.
- **`WorkItemType` as closed union.** From step 12 onwards, `WorkItem.kind` is `string`, backed by the KV kind registry. Do not introduce new `"finding" | "task" | ...` unions.
- **`any` type, `@ts-ignore`, `as any` casts.**
- **Default exports.** Named exports only.
- **Cross-package upward imports.** `@operator/core` never imports `@operator/adapters`. `@operator/adapters` never imports `@operator/engine`. `@operator/app` never imports `@operator/engine` runtime (types only through `@operator/core`).
- **Cross-layer upward imports inside `engine/`.** `platforms/` never imports `agents/`, `storage/` never imports `pipeline/`, etc. See layer graph below.
- **Runtime code in `types/` or `packages/core/src/types/`.** Interfaces and type aliases only. Error class constructors are the single exception.
- **Files over 200 lines in `engine/pipeline/**`.** If it grows past 200, a primitive is leaking. Files over 300 elsewhere.
- **Agent code writing to KV.** Agents only write workspace files. Orchestrator primitives write KV. Never cross this line.
- **Platform-specific vocabulary in core.** `PullRequest`, `Issue`, `MergeRequest` only inside `engine/platforms/github/`. Core uses `CodeReview`, `WorkItem`.
- **`OperationContext`-less I/O functions.** Every function that hits state, git, VCS, or filesystem takes `ctx`.

## REQUIRED

- **Observability on every I/O function.** v5 is being rebuilt specifically to fix the "I can't see what the engine is doing" problem. Every primitive, every stage, every I/O path MUST log enough that a person reading the INFO stream can reconstruct what happened and why WITHOUT reaching for GitHub or a database. The discipline is non-negotiable:
  - **INFO** — every important action (agent invoked, commit created, PR upserted, label transitioned, stage skipped with reason, lock acquired/released, workspace prepared). Every DECISION with the reason (why was this PR picked, why was this selector null, why this verdict). Logs must include the PR number, commit SHA, branch, verdict, duration when relevant. If the engine did something externally visible (pushed a commit, posted a comment, flipped a label), there MUST be an INFO line for it — reading `git log` or `gh pr view` to understand an engine run is a bug, not a feature.
  - **DEBUG** — important data variables that don't belong on the default stream: prompt length, tool list, HTTP response shapes, intermediate computations, full payload dumps.
  - **WARN** — unexpected but non-fatal (template missing, non-critical API error caught, fallback path taken). Every catch-and-continue branch MUST warn with the reason.
  - **ERROR** — every failure, with full error including `.cause`. Never swallow a stack trace. Error logs include: the operation that failed, the inputs (redacted), what was attempted next (retry / abort / fall through).
  - **Silent success is a bug.** A code path that completes successfully without any log line cannot be audited — add at minimum one INFO summary at exit.
- **Line-count limits exclude logging, comments, and JSDoc.** The `engine/pipeline/**` ≤200 and `engine/**` ≤300 caps are about code complexity, not visibility. A file with 280 code lines + 100 log/comment lines is still 280 — do NOT trim logging or shorten JSDoc to fit a budget. If a file is legitimately over the code-only cap, split it; do not strip logs.
- **Named exports only.** Use `import type` for type-only imports.
- **Colocated `.test.ts`** for every implementation file. No orphan implementation files, no orphan tests. Exception: `entry.ts` (integration-tested end-to-end), `types/` (no runtime), Next.js pages (server components tested via integration).
- **`>=90%` coverage** on every file touched. `>=95%` for primitives in `engine/pipeline/primitives/`.
- **Mock at interface boundaries**, not internal functions. Prefer fake implementations (`TestVCSPlatform`, `TestStateManager`, `TestKVStore`) over `vi.fn()`.
- **Real temp directories** for filesystem tests via `fs.mkdtemp`. Never mock `fs`.
- **Zod validation at external boundaries.** Internal code trusts validated data — no defensive checks.
- **Typed errors** via `packages/core/src/errors/*.ts` (or `engine/infra/errors.ts` pre-step-3). Every error has a `code: string`. Never throw plain strings or generic `Error`.
- **Octokit pagination** for every GitHub API list call — use `.paginate()`, never assume single page.
- **Constructor injection.** Every class receives dependencies through its constructor.
- **`OperationContext`** threaded through every I/O function: `{ traceId, repoId, action, budget, signal }`.
- **Stages are config, not code.** If you need a new stage behavior, edit `agents/workflow/stages.yaml` and the relevant agent prompt file. If the existing `runStage` cannot express the behavior, the fix is extending `StageDef` config, not adding a new file under `pipeline/stages/`.
- **Workspace reset in `finally` blocks** that created branches.
- **Every bug fix ships with a regression test.** No exceptions for "trivial" / "obvious" / "one-line" fixes. The test MUST fail on the pre-fix code and pass on the fix; its name MUST describe the bug scenario (not just the function under test), so a future refactor that re-introduces the bug trips the same assertion. Schema / config / contract changes (renames, path-prefix shifts, frontmatter additions) need the same discipline — they look harmless but break across callsite boundaries. v5 carries an active example: the 2026-05-20 `syncFilesToState` double-prefix regression survived d16d88b because the read-side caller contract was changed without a test that pinned the prefixed `dataDir` convention end-to-end.

## Architecture — Package Boundaries

```
@operator/core        imports: type-only from Node built-ins, nothing runtime
                      exports: types, interfaces, error classes (the only runtime)
                      consumers: adapters, engine, app
                      NEVER imports: adapters, engine, app

@operator/adapters    imports: @operator/core, npm runtime deps (better-sqlite3, @octokit/rest, etc.)
                      exports: concrete implementations of core interfaces
                      consumers: engine, app
                      NEVER imports: engine, app

@operator/engine      imports: @operator/core, @operator/adapters, Node built-ins
                      exports: daemon binary, CLI entry point
                      NEVER imports: @operator/app

@operator/app         imports: @operator/core (types only), @operator/adapters (read-only KVStore)
                      NEVER imports: @operator/engine runtime code
                      runs in Next.js server environment for DB access
```

Enforced by ESLint `no-restricted-imports`. Violation → CI failure.

## Architecture — Layer graph inside `engine/`

```
entry.ts              → daemon/, engine/, storage/, pipeline/, config/, logging/, @operator/adapters
daemon/               → engine/, logging/
engine/               → pipeline/, config/, logging/, @operator/core
pipeline/run-stage.ts → pipeline/primitives/*, @operator/core, @operator/adapters (through primitives only)
pipeline/primitives/  → agents/, platforms/, storage/, infra/, @operator/core
pipeline/cleanup.ts   → platforms/, logging/, @operator/core
agents/               → platforms/, events/, infra/, @operator/core
platforms/            → infra/, logging/, @operator/core
storage/              → @operator/core, @operator/adapters
communication/        → events/, logging/, @operator/core
events/               → logging/, @operator/core
infra/                → Node built-ins only
logging/              → nothing
```

## Architecture — Primitives boundary

`engine/pipeline/primitives/` is the only location where stage code may:

- Call `WorkspaceGit` / `git.*` operations
- Call `PRManager.*`
- Call `VCSPlatform.*` directly
- Call `AgentRuntime.run`
- Write to `KVStore` from within a stage execution

One file per primitive (`workspace-scope.ts`, `item-selector.ts`, `agent-invocation.ts`, `persist-output.ts`, `route-verdict.ts`, `recovery-journal.ts`). Each has a colocated test with >=95% coverage. Each stays under 200 lines.

`pipeline/run-stage.ts` composes primitives and is also capped at ~150 lines. If it grows, a primitive is leaking out.

## Architecture — Storage contracts

- KV categories follow `category/key: json` shape. See `docs/architecture-v5.md §5.4` for the full list.
- Runtime config categories (`prompts/*`, `templates/*`, `workflow-stages/*`, `work-item-kinds/*`) are seeded from repo files at startup. Seed never overwrites except explicit `--reseed {category}`.
- Work item state category (`work-items/*`) is reconciled once per cycle from `syncFromFiles` + open-PR labels.
- Execution history categories (`executions/*`, `execution-events/*`, `execution-logs/*`) are append-only, written by primitives during stage runs.

## Code Style

- File naming: `kebab-case.ts`
- Tests: colocated `{name}.test.ts`
- Interfaces: PascalCase, no `I` prefix (`VCSPlatform`, not `IVCSPlatform`)
- Classes: PascalCase (`GitHubVCS`, `SQLiteKVStore`, `FileOutputAdapter`)
- Functions: camelCase (`runStage`, `buildPrompt`, `persistOutput`)
- Constants: UPPER_SNAKE for true constants, camelCase for config
- Semicolons, double quotes
- Max 200 lines per file in `engine/pipeline/**`
- Max 300 lines elsewhere
- `entry.ts` must stay under 200 lines — **migration exception**: while the `switch (action)` block is still present (pre-Step-12), `entry.ts` is allowed to run ~600 lines. Target state after Step 12 merge: under 200 lines, no dispatch block, only composition-root wiring. The limit becomes hard from Step 12 onward.

## Dependency Security

- **Minimal dependencies** — prefer Node.js built-ins over npm packages.
- **Trusted publishers only** — Microsoft, GitHub, Anthropic, established OSS foundations, Node.js TSC members with multi-year track record.
- **No low-trust packages** — never add from unknown publishers, unmaintained projects (no commits in 12+ months), or packages with <1000 weekly downloads.
- **Audit before adding** — `npm audit` must be clean. Zero vulnerabilities policy.
- **Pin native bindings** to exact versions (`better-sqlite3`). `^` is fine for pure-JS.

### Approved runtime dependencies

| Package | Publisher | Role |
|---------|-----------|------|
| `typescript` | Microsoft | Build |
| `vitest`, `@vitest/*` | Vue.js team | Test |
| `@octokit/rest` | GitHub/Microsoft | VCS |
| `zod` | Colin McDonnell | Validation |
| `pino` | NearForm / Matteo Collina | Logging |
| `better-sqlite3` | Joshua Wise | State |
| `js-yaml` | Nodeca team | Config |
| `node-cron` | merencia | Scheduling |
| `tsx` | privatenumber | Dev runner |
| `next`, `react`, `react-dom` | Vercel / Meta | App (v5) |

## Build & Verify

```bash
npm install
npm run typecheck              # tsc --noEmit across all workspaces
npm test                        # vitest across all workspaces
npm test -- --coverage          # with coverage report
npm run lint                    # eslint + ts-prune
```

Manual one-off run:

```bash
npx tsx --env-file=.env.local engine/entry.ts --once --fresh-db --repo <repo-id>
```

## Examples (from the codebase)

- **Correct primitive usage**: `engine/pipeline/primitives/workspace-scope.ts` — the only place that calls `git.checkoutNewBranch` / `git.checkoutExisting`. Every stage goes through `WorkspaceScope.prepare(stageDef, input, baseBranch, git)`.
- **Correct `runStage` composition**: `engine/pipeline/run-stage.ts` — ~150 lines, composes 8 primitives, no stage-specific logic.
- **Correct KV interaction**: `engine/pipeline/primitives/persist-output.ts` — `FileOutputAdapter` reads from workspace, writes commit via `WorkspaceGit`, then writes execution entry to `kv:executions/*`. No direct KV calls from anywhere else in a stage's code path.
- **Correct agent invocation**: `engine/pipeline/primitives/agent-invocation.ts` — wraps existing `AgentRuntime.run` plus reviewer summary extraction. Every stage calls this one function.

## Footgun Warnings

- YAML config paths: resolve relative to `__dirname` or passed root, never `process.cwd()`.
- GitHub API: always paginate with `.paginate()`.
- Agent output parsing: always wrap in try/catch with typed `AgentError`.
- SQLite writes during app-reads: WAL mode handles this, but never hold a write transaction open across async boundaries.
- Next.js SQLite access: server components only, never `"use client"` files. Use API routes if you need data in a client component.
