# Changelog

All notable changes to this project. 0.5.0 is the first public release of the v5 architecture rebuild.

## [Unreleased]

### Removed

- **The `deploy` job and the self-hosted-runner deployment path.** `Build Image` now builds and publishes to GHCR, and stops there — no workflow reaches into a running deployment. The job was added in the 0.6.0 cycle pinned to `runs-on: [self-hosted, operator-deploy]`, a runner that was never registered, so all 77 runs since went `build: success` → `deploy: queued` → cancelled by GitHub at the 24-hour mark. Publishing-only makes the deployment story identical for this project's own instance, a fork, and a customer VM, and removes a self-hosted runner from a public repository. `deployment/self-hosted-runner.md` is gone; `deployment/deploy.sh` stays as the manual rollout and rollback command.

### Changed

- **`deployment/README.md` gained a "Host setup for an always-on instance" section** carrying the parts of the deleted runbook that outlive the runner: where the runtime secrets file lives (`OPERATOR_ENV_FILE`, no root required), how to seed `repos.yaml` onto the state volume, and the pinned first rollout that doubles as the rollback command.
- **Watchtower is now the documented low-effort update path** rather than the fallback for hosts without a runner. It stays behind its opt-in profile — a host should choose to be updated without asking.

## [0.6.0] — 2026-09-04

The first release since Operator started managing its own repository. On 2026-07-04 the repo `operator` was registered as a managed project, and most of the engine work below was discovered, planned, implemented, and reviewed by the engine running against its own code — the closed loop's first real proof. The rest is the onboarding half: a guided setup screen, the UI in the Docker stack, and the documentation a public repository owes a first-time reader.

### Added

- **Self-managed operation** — `.operator/` registers this repository as a managed project with eight quality analyzers (`code-quality`, `consistency`, `orchestration-reliability`, `prompt-quality`, `resilience-boundaries`, `security`, `staleness`, `test-strategy`), per-area role contexts for `engine/`, `app/`, and `packages/`, and retrospective rules. The `staleness` analyzer specifically hunts obsolete data and behavior drift — documentation that describes code that no longer exists.
- **Queue-fill schedule** — research is driven by backlog depth rather than by the clock. The discovery selector refills the finding queue toward a target pending count and backs off exponentially after consecutive empty runs, so an exhausted analyzer set stops burning cycles instead of re-running hourly. A run skipped because another holds the lock is a full no-op and does not pollute the backoff counter.
- **Transient CI-failure detection** — a red pipeline is now classified before the review agent is engaged. Infrastructure-shaped failures (runner allocation, network, timeouts) re-run the pipeline; only a genuine test or gate failure spends an agent invocation on a fix.
- **Retrospective orphan reconciliation and rejection-driven learning** — the weekly retrospective stage reaps work items stranded by a closed or abandoned PR, and feeds rejected findings back into the analyzer prompt that produced them, so a false-positive class stops recurring instead of being re-filed every cycle.
- **Per-comment review-thread dispositions** — the supervisor now answers and resolves every inline review comment individually, with an explicit disposition per thread. Previously a review round could be reported handled while individual threads sat unanswered.
- **Self-hosted-runner push deploy** — `Build Image` publishes to GHCR and redeploys to the operator's own VM through a self-hosted runner, so every merge and every nightly CLI refresh lands on the running instance. Watchtower moved behind an opt-in Compose profile for deployments without a runner.
- **AOP parse diagnostics** — unknown `EMIT` keys stripped by the schema now surface as warning diagnostics with did-you-mean hints, and `applyAgentEvents` logs a diagnostic per record. An agent that misspells a field learns about it instead of silently losing the record.
- **Research analyzer output in execution logs** — each analyzer's agent output is captured through the history sink and visible on the execution timeline.
- **Guided setup screen (`/setup`) in `@operator/app`** — the instance-side half of onboarding, which until now meant hand-writing `config/repos.yaml` and `.env.local` and hoping the host had the right CLIs. Four re-openable steps: create or select the engine's SQLite state file (created on demand, so the screen works before the engine has ever booted); check this host for `git`, for every agent CLI the configured roles actually route to, and for a git-host token — including an optional one-shot verification against GitHub of a token that is never stored; register the managed repository through the existing validated `/api/kv/repos/{id}` write path; and start the first cycle. The required CLIs are derived from `agent-providers` / `agent-roles` (falling back to the shipped `agents.yaml` on an unseeded database), so a single-vendor deployment is asked for one CLI, not for whatever the default ships with. `POST /api/setup/preflight` is the one new endpoint; the screen adds no second write path.
- **`operator-app` service in `deployment/docker-compose.yml`** — the UI now runs in the Docker stack from the same image and the same state volume as the engine, published on `127.0.0.1:3000` (it edits engine configuration and has no authentication of its own; `OPERATOR_APP_BIND` opens it once a proxy is in front). `deployment/Dockerfile` pre-builds the app, and `deploy.sh` and the Watchtower label scope now cover both containers so the UI cannot drift behind the engine image.
- **`SECURITY.md`** — supported version line, GitHub private vulnerability reporting as the only channel, expected response times, and a scope note naming the engine's blast radius (repo-scoped token, external agent CLI, pushes confined to `config/repos.yaml`). No e-mail channel.
- **Issue and pull-request templates** under `.github/` — bug report, feature request, and a PR checklist carrying the three CI-blocking commands and the non-negotiable rules.
- **README safety section** — what Operator can reach before the first cycle, that every MVP stage ships `merge: gated`, and the advice to start against a non-critical repository. Plus License and Security sections.

### Changed

- **`--help` reports the real version.** The CLI banner still carried retired `Operator V3` branding and a hardcoded version string; it is now derived from `package.json`.
- **The orphan reconciler reaps stuck tasks, not only findings.** Any kind stranded by a closed PR is reconciled, rather than tasks accumulating in a permanent in-progress state.
- **The `## Execution Summary` block is optional.** Reviewer agents were contractually required to emit it, and a missing block failed an otherwise successful stage; on success the supervisor's own AOP summary is used instead.
- **The init scout's verify gate must cover every modifiable stack**, not just the primary one — a polyglot repository whose secondary stack had no gate could ship unverified changes.
- **The analyst's dedup window is bounded to recent open findings.** Comparing each candidate against the entire historical corpus grew unbounded with the backlog.
- **Global context auto-detect order has a single source of truth** (`GLOBAL_CONTEXT_ORDER`). The order was previously restated in four bundled prompts, and they had already drifted from the code.
- **`LICENSE` copyright holder** is now the legal entity, `MB Ainova Systems`. The MIT body is unchanged and GitHub still detects the license as MIT.

### Removed

- **`dailyResearchHour` engine default.** Research moved to the queue-fill schedule; the key was read by nothing and implied a cadence the engine no longer had.
- **Directory-as-status convention in bundled content.** A work item's status lives in its frontmatter; the parallel convention of encoding it in the containing directory drifted, and merged findings never reached the queue.
- **`@anthropic-ai/sdk` dependency.** It was declared but imported nowhere — the engine is an orchestrator and reaches Claude through the `@anthropic-ai/claude-code` CLI it spawns, not through the SDK. Its entry in `knip.json`'s `ignoreDependencies` had been masking it from the dead-code gate; that entry is gone too, so the gate now watches the package if it ever returns.

### Fixed

- **Agent spawns failed with `ENOENT` on Windows.** The `claude` CLI is installed as a shim; the engine now resolves it to its real executable before spawning.
- **CRLF frontmatter was parsed as garbage.** The work-item parser mishandled `\r\n` line endings and quoted values, so a checkout on Windows produced items with empty statuses. The same bug lived independently in the discovery selector's analyzer parser and is now pinned by a cross-boundary regression test.
- **Research findings were silently dropped.** Three independent AOP defects: a child item without a parent was rejected (research findings have no parent by construction); a block whose free-text field contained a colon failed to parse and now falls back to a lenient parse; and records that failed validation were discarded with no log line at all. `improver.md` also emitted un-fenced `EMIT` markers that never parsed.
- **A closed PR's stale label latched a work item's status.** A PR label is now honoured only while its PR is open, so a label left behind on a closed PR no longer overrides the terminal state.
- **Agent-authored commits were silently lost.** When an agent committed inside the workspace itself, `persist` did not detect the commit and never pushed it — a review fix could be made and then discarded.
- **A supervisor's in-place fix was rejected by its own red CI.** The red run belonged to the pre-fix commit; the stage now keeps the item in review instead of failing on stale check results.
- **CI check observation swallowed errors and truncated results.** `listForRef` and `getCheckRuns` were unpaginated, so a large PR's checks were cut off, and a failed fetch degraded to "no checks" with no warning. Both now paginate, `GitHubVCS` has a logger, and a degrade is reported at WARN.
- **Expected `404` existence probes were logged at ERROR.** Checking whether a label exists is control flow, not a failure; Octokit request-log errors carrying a `404` now route to DEBUG while real failures stay ERROR.
- **Primitive-layer KV write failures were swallowed** with no WARN and no logger in the dependency set — a lost write left no trace.
- **A failed stage did not advance the queue-fill backoff.** A stage error is never evidence of output, so it now advances the throttle and bumps the backoff counter like an empty run.
- **The init scout emitted POSIX `cd`-subshell chains** that fail on `cmd.exe`, so generated init and verify commands were unrunnable on Windows hosts.
- **A fresh Docker deployment could not write its own state volume.** The image drops to the unprivileged `operator` user but never created `/var/lib/operator`, so Docker initialised the named volume root-owned and the first start died on `EACCES: permission denied, mkdir '/var/lib/operator/state'` — `docker compose up` on a clean host had never worked. The image now creates the mount point owned by that user while still root, which is what Docker copies ownership from. An **existing** volume keeps its current ownership; fix one in place with `docker run --rm -v operator-state:/v alpine chown -R 10001:37 /v`.
- **A failed `LocalStorageBundle` open leaked its SQLite handle.** SQLite opens lazily, so `new Database(path)` succeeds for a path that is not a database and the failure only surfaces on the first statement — after which the handle had no owner to close it, holding a lock on the file for the rest of the process. Probing an arbitrary path is exactly what the app's connection test and the new setup preflight do, so the constructor now closes the handle before rethrowing.
- **Overlapping engine cycles corrupted the shared workspace.** `Daemon.start` registered the interval before awaiting the bootstrap cycle, and `IntervalScheduler`'s re-entrancy flag only saw cycles it launched itself — so the first tick started a second cycle alongside a bootstrap cycle that was still running an agent. Both cycles shared one git clone per repo, and `runStage`'s lock is keyed on the stage *name*, so a second cycle's `research` stage could check out its branch under a first cycle's running `creator`. The creator's commit then landed on the research branch, its own branch was pushed empty, and GitHub's `422 No commits between` was swallowed as an empty diff — the stage reported success with no PR. Three changes close it: `Daemon.runCycle` now owns the re-entrancy decision, `Engine.processProject` takes a `workspace:{repoId}` lock for the whole repo pass, and `persist` refuses to commit when HEAD has drifted off the branch the stage prepared (`WS_BRANCH_DRIFT`).
- **README pointed at a `sync.sh` that does not exist.** The Contributing section told readers to run `bash intelligence/scripts/sync.sh`; the script lives at `intelligence/sync/scripts/sync.sh`. The same stale path sat in a `.gitignore` comment. Every relative link in `README.md`, `CONTRIBUTING.md`, and `SECURITY.md` now resolves to a file in the tree.
- **The Kubernetes manifest in `docs/deployment.md` pinned an image tag that is never published.** `Build Image` pushes `:latest` and `:<commit-sha>` only; there is no version-numbered tag, and a copy-pasted `:0.5` would not pull.
- **README described a GitHub Actions workflow that was never committed.** The "Automation status" section documented an `orchestrator` workflow on a 5-minute cron, together with a `gh workflow run orchestrator.yml` command. No such workflow exists in `.github/workflows/`, in the git history, or on the remote. The section now describes what actually runs: Operator as an always-on daemon, with `Tests` and `Build Image` as the two CI workflows.

### Security

- **The agent subprocess inherited the operator's git-host token.** The environment denylist stripped four hardcoded GitHub variable names, so a repository configured with any other `tokenEnvVar` handed its token to every spawned agent CLI. The configured `tokenEnvVar` — for both the VCS and the tracker — is now stripped by name.
- **Structured log data was not redacted.** `redactValue` was applied to log messages but not to the structured fields beside them, so a token in a log object's payload reached the sink verbatim. It is now wired through `wrapPino`.
- **Dependency alerts cleared to zero** (`npm audit`: 0, from 8 locally / 15 on the default branch). In-range upgrades cover `js-yaml` 4.1.1 → 4.3.1 (quadratic-complexity DoS via merge keys), `next` 15.5.15 → 15.5.23 (SSRF in rewrites and Server Actions, Server Function endpoint disclosure, cache confusion, image-optimization DoS), `brace-expansion`, and `vite`. Four transitive pins that no in-range upgrade could reach are handled by `overrides` in the root `package.json`: `esbuild` → `^0.28.1` (dev-server arbitrary file read on Windows), `nanoid` → `^3.3.18` (unbounded loop when a custom generator is called with size zero — reached through the pinned `postcss`, whose own range still admits the vulnerable line), and, inside `next`, `postcss` → `^8.5.26` (source-map path traversal, XSS in stringify output) and `sharp` → `^0.35.3` (inherited libvips CVEs). The overrides keep the app on the `next` 15 line — upgrading to 16 was the only alternative npm offered and it is a breaking change for no security gain.

### Internal

- **`master` is protected for human and assistant development too.** Code reaches it through a feature branch and a PR; the single exception is a change whose diff is entirely documentation or `intelligence/` content. Recorded once in the project profile (`protected_branches`, `direct_push_paths`, `pr_flow`).
- **A long-term architect review gate over the operator's own open PRs.** Run under the owner's account, it fact-checks each change, squash-merges the ones that are clearly correct, and holds the rest by label. It never merges a protected surface, a change it cannot verify, or one carrying an unanswered human review thread.
- **Files over the 200-line cap in `engine/pipeline/**` split** — `run-stage.ts` and the AOP planner stage extracted their composers. The cap is documentation, not a CI gate, and the backlog behind it is larger than those two splits: 12 files under `engine/pipeline/**` are still over 200 code lines (`pr-feedback-supervisor-stage.ts` at 478 is the largest), `engine/entry.ts` sits at 477 against its own 200-line rule, and four further files in `engine/` plus four route components in `app/` are over the 300-line cap. Two splits are in open PRs (#38, #49); the rest are unclaimed.
- **The Docker AI Sandbox profile was added and then withdrawn** pending a settled runtime choice. It ships in no form in this release.

### Verification

- 1984 tests across 128 files (1 skipped), up from 1173 at 0.5.0.
- Coverage 92.69% statements / 84.4% branches / 92.4% functions / 93.5% lines, above the 90% gate.
- `npm run typecheck`, `npm run lint` (eslint + ts-prune + knip), and `npm test` all green on the release commit; `ts-prune` and `knip` both report zero orphans.

### Upgrading from 0.5.0

No state migration. `dailyResearchHour` may be dropped from any local `engine-defaults` override; leaving it in place is harmless, since the key is now ignored. An existing Docker state volume keeps its current ownership and is not repaired by the image fix — see the volume-permission entry above for the one-line `chown`.

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
