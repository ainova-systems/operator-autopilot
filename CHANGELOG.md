# Changelog

All notable changes to this project. 0.5.0 is the first public release of the v5 architecture rebuild.

## [Unreleased]

### Added

- **`SECURITY.md`** — supported version line, GitHub private vulnerability reporting as the only channel, expected response times, and a scope note naming the engine's blast radius (repo-scoped token, external agent CLI, pushes confined to `config/repos.yaml`). No e-mail channel.
- **Issue and pull-request templates** under `.github/` — bug report, feature request, and a PR checklist carrying the three CI-blocking commands and the non-negotiable rules.
- **README safety section** — what Operator can reach before the first cycle, that every MVP stage ships `merge: gated`, and the advice to start against a non-critical repository. Plus License and Security sections.

### Changed

- **`LICENSE` copyright holder** is now the legal entity, `MB Ainova Systems`. The MIT body is unchanged and GitHub still detects the license as MIT.

### Removed

- **`@anthropic-ai/sdk` dependency.** It was declared but imported nowhere — the engine is an orchestrator and reaches Claude through the `@anthropic-ai/claude-code` CLI it spawns, not through the SDK. Its entry in `knip.json`'s `ignoreDependencies` had been masking it from the dead-code gate; that entry is gone too, so the gate now watches the package if it ever returns.

### Fixed

- **Overlapping engine cycles corrupted the shared workspace.** `Daemon.start` registered the interval before awaiting the bootstrap cycle, and `IntervalScheduler`'s re-entrancy flag only saw cycles it launched itself — so the first tick started a second cycle alongside a bootstrap cycle that was still running an agent. Both cycles shared one git clone per repo, and `runStage`'s lock is keyed on the stage *name*, so a second cycle's `research` stage could check out its branch under a first cycle's running `creator`. The creator's commit then landed on the research branch, its own branch was pushed empty, and GitHub's `422 No commits between` was swallowed as an empty diff — the stage reported success with no PR. Three changes close it: `Daemon.runCycle` now owns the re-entrancy decision, `Engine.processProject` takes a `workspace:{repoId}` lock for the whole repo pass, and `persist` refuses to commit when HEAD has drifted off the branch the stage prepared (`WS_BRANCH_DRIFT`).
- **README pointed at a `sync.sh` that does not exist.** The Contributing section told readers to run `bash intelligence/scripts/sync.sh`; the script lives at `intelligence/sync/scripts/sync.sh`. The same stale path sat in a `.gitignore` comment. Every relative link in `README.md`, `CONTRIBUTING.md`, and `SECURITY.md` now resolves to a file in the tree.
- **README described a GitHub Actions workflow that was never committed.** The "Automation status" section documented an `orchestrator` workflow on a 5-minute cron, together with a `gh workflow run orchestrator.yml` command. No such workflow exists in `.github/workflows/`, in the git history, or on the remote. The section now describes what actually runs: Operator as an always-on daemon, with `Tests` and `Build Image` as the two CI workflows.

### Security

- **Dependency alerts cleared to zero** (`npm audit`: 0, from 8 locally / 15 on the default branch). In-range upgrades cover `js-yaml` 4.1.1 → 4.3.1 (quadratic-complexity DoS via merge keys), `next` 15.5.15 → 15.5.23 (SSRF in rewrites and Server Actions, Server Function endpoint disclosure, cache confusion, image-optimization DoS), `brace-expansion`, and `vite`. Three transitive pins that no in-range upgrade could reach are handled by `overrides` in the root `package.json`: `esbuild` → `^0.28.1` (dev-server arbitrary file read on Windows), and, inside `next`, `postcss` → `^8.5.26` (source-map path traversal, XSS in stringify output) and `sharp` → `^0.35.3` (inherited libvips CVEs). The overrides keep the app on the `next` 15 line — upgrading to 16 was the only alternative npm offered and it is a breaking change for no security gain.

## 0.5.0 — 2026-06-23

First public release of the v5 architecture rebuild. The v4 line was abandoned mid-migration after accumulated dead code and duplicated stage plumbing made further iteration unsafe. v5 restarts with a single composition root, a generic stage loop, and an observability UI that ships from day one.

### Architecture

- **Monorepo layout** — `engine/`, `app/`, `packages/core`, `packages/adapters` split under npm workspaces. Code lives flat inside `engine/`; no `src/` subdir.
- **Composition root** — `engine/entry.ts` is the only file that instantiates cross-layer classes with `new`. No other file uses `new` on an interface-shaped dependency.
- **Generic stage loop** — `engine/pipeline/run-stage.ts` runs every stage through the same 8-step sequence. Stage-specific behavior lives in `engine/pipeline/stage-logic/<stage>.ts` hooks (`beforeAgent`, `buildRunInput`, `buildPR`, `afterAgent`, `synthesizeAgentResult`) and in `engine/content/prompts/stages.yaml`. `engine/pipeline/stages/` no longer exists.
- **Primitives boundary** — only `engine/pipeline/primitives/**` may call `git.*`, `PRManager.*`, `VCSPlatform.*`, `AgentRuntime.*`, or write to `KVStore`. Ten primitives cover workspace scope, item selection (bootstrap, per-item, pr-feedback, discovery, singleton), agent invocation, output persistence, verdict routing, status observation, and execution history.
- **KVStore model** — `packages/adapters/src/kvstore-sqlite/` ships `LocalStorageBundle` (KV + IdempotencyGuard + RateLimiter against one SQLite file with `kv` / `locks` / `rate_buckets` tables). Every runtime config category (prompts, templates, agent-roles, agent-providers, engine-defaults, workflow-stages, work-item-kinds, analyzers, reviewer-criteria) is KV-backed; `config/repos.yaml` is a seed-mirror source for `kv:repos/*`.
- **Open `WorkItemKind`** — `WorkItem.kind` is a `string`, backed by the KV kind registry. Adding a new kind is a yaml edit + reseed; no engine code changes.

### Features

- **Observability app** — `@operator/app` is a Next.js multi-instance shell. Users register SQLite connections in a per-user app database, switch between managed-operator instances, and browse work items, executions, audit log, and config categories. Read-only views land in Step 6 of the migration; the write path lands in Step 16.
- **Write path** — JSON editor for every KV category, with Zod-validated PUT/DELETE/reset through `/api/kv/*`. Every mutation writes an audit row under `kv:execution-events/config-edit/{seq}` with before/after/diff. Optimistic version check prevents lost updates.
- **Connection management** — left-rail CRUD on operator-instance connections. Each connection points at a SQLite file; the factory (`app/src/lib/kv-factory.ts`) is the single adapter choke point so future Cloud / Postgres backends plug in without UI rewrites.
- **Status observation layer** — every stage that touches a work item records per-source observations (develop file frontmatter, feature branch file, PR label, execution verdict). The app flags drift between sources for the user to investigate, with a "Resync from VCS" action when the fix is obvious.
- **Execution history** — `kv:executions/{id}`, `kv:execution-events/{id}/{seq}`, `kv:execution-logs/{id}` ring buffer captures every stage run. Reviewer agents emit an `## Execution Summary` block that the app surfaces on the work item timeline and feeds back into the next retry's agent prompt.
- **Kind registry** — `engine/content/prompts/kinds.yaml` declares the three shipped kinds (finding, task, request). Registry is loaded from KV on boot; unknown-kind lookups throw typed errors. Adding a `plan` / `spike` / custom kind is config-only.

### Rules locked in by CI

- `ts-prune` CI job fails the build on any unused export (`scripts/check-ts-prune.mjs`).
- ESLint is `error` severity inside `engine/**` for `no-restricted-imports`, `@typescript-eslint/no-explicit-any`, and `@typescript-eslint/no-unused-vars`.
- Package boundaries enforced: `@operator/core` never imports adapters, `@operator/adapters` never imports engine, `@operator/app` never imports engine runtime.
- Dead code is a blocker, not a warning — every PR ends with zero orphan exports.
- Fast-forward-only pushes. `git push --force*` of any kind is forbidden. `FileWorkspaceScope` is the only decision point for "create new branch vs checkout existing".
- Secret redaction (`engine/logging/redact.ts`) scrubs GitHub PATs, Anthropic keys, cloud-provider keys, and bearer tokens before every log write.

### Breaking changes from v4

The v5 rebuild is not upward-compatible with v4 state. The state directory can be wiped between the two versions — `engine/entry.ts --fresh-db` rebuilds the KV on first run from `engine/content/` + `config/repos.yaml`. Workspaces under `$WORKSPACE_BASE_DIR` are disposable and will be re-cloned.

- `WorkItemType` closed union removed; `WorkItem.kind` is now `string`.
- `WorkItem.type` field renamed to `WorkItem.kind` end-to-end.
- `engine/pipeline/stages/*.ts` directory removed; every stage is driven by `runStage` + config in `engine/content/prompts/stages.yaml` + per-stage hooks in `engine/pipeline/stage-logic/<stage>.ts`.
- `BaseStage` abstract class removed. Stages compose primitives; they do not inherit.
- `gitflow`-specific `branches: { main, develop }` struct removed; every managed repo declares a single `branch` field.
- `FilePromptSource` replaced by `KVPromptSource`; prompts are loaded from KV, with a workspace-file extension layer for per-project overrides.
- Force-push paths purged end-to-end. Any invocation would be a regression and must be reported as a bug.

### Deployment

- **Local-first** remains the primary runtime. SQLite + filesystem + one agent API key is enough to run the closed loop.
- **VM / systemd**, **Docker Compose**, and **Kubernetes** manifests documented in `docs/deployment.md`.
- Environment variables: `OPERATOR_DIR`, `WORKSPACE_BASE_DIR`, `OPERATOR_DB_PATH`, `OPERATOR_APP_DB_PATH`, `LOG_LEVEL`, per-repo `tokenEnvVar`, agent-provider API keys. Reference table in `docs/deployment.md`.

### Test suite

- 1173 tests, coverage 95.6% statements / 86.9% branches / 95% functions / 96% lines.
- Primitives in `engine/pipeline/primitives/**` sit at >=95% coverage (99% in practice).
- New `engine/smoke.test.ts` exercises seed → kind registry → Engine.runOnce end-to-end against a throwaway SQLite file; this replaces the v4 "tests pass while end-to-end is broken for days" regression class.

### Migration post-mortem

The v5 rebuild was executed as 17 numbered steps (plus 8a/8b/8c splits and a post-8a Step 18 readiness review), each landed as its own PR with a green test suite and zero dead code. The detailed step-by-step plan is kept internal; this release completes the migration.

## Pre-v5

Pre-v5 history (v1–v4) is not preserved in this repository — v5.0.0 is a fresh start.
