# Operator

Closed-loop SDLC engine that autonomously discovers issues, plans fixes, implements code, verifies, delivers, observes, and learns. **Orchestrator, not agent** — schedules work and invokes external agent CLIs (Claude Code, OpenCode, …) through a single generic stage loop.

**Status: 0.5.0 — first public release.** The v5 architecture rebuild is complete and running; this is the first public cut. See [CHANGELOG.md](CHANGELOG.md) for release notes. The v4 implementation was abandoned mid-migration — v5 collapses all pipeline work into `runStage` + 10 primitives, puts state in a pluggable KV model, and ships an observability UI from day one.

## Documentation (read in this order)

1. **[docs/vision.md](docs/vision.md)** — product direction, invariants, non-goals, refused directions
2. **[docs/workflow.md](docs/workflow.md)** — behavior contract: 8-step run loop, 3 persistence modes, 5 verdicts, MVP stage list
3. **[docs/architecture-v5.md](docs/architecture-v5.md)** — target shape: monorepo layout, primitives, KV model, package boundaries
4. **[docs/deployment.md](docs/deployment.md)** — local-first dev, VM/systemd, Docker Compose, Kubernetes

## Monorepo layout

```
git-operator-autopilot/
├── engine/            daemon source — @operator/engine (flat, no src/)
│   ├── entry.ts       composition root
│   ├── pipeline/      run-stage.ts + primitives/ + stage-logic/
│   ├── agents/, platforms/, state/, storage/, delivery/, work-items/, …
│   └── content/       bundled engine assets — prompts, templates, defaults
├── app/               Next.js observability + config-edit UI — @operator/app
├── packages/
│   ├── core/          shared types + interfaces + Zod schemas — @operator/core
│   └── adapters/      KVStore + kind-registry impls — @operator/adapters
├── config/            instance config (repos.yaml, seed-mirror source)
├── intelligence/      AI prompt framework (rules/agents/skills) — syncs to .claude, .cursor
├── docs/              canonical documentation
├── scripts/           CI helpers (check-ts-prune.mjs)
└── state/             runtime state — gitignored
```

## Getting started

**Prerequisites:** Node.js 24+, `git` 2.40+ on `$PATH`, one agent CLI (e.g. Claude Code) on `$PATH`, and a GitHub token with repo scope.

### Quick start (first run)

```bash
npm install                                        # install all workspaces

cp config/repos.yaml.example config/repos.yaml     # then edit: owner/repo, branch, tokenEnvVar
cp .env.local.example .env.local                   # then fill in your tokens (gitignored)

npm run exec                                        # one --once cycle over every repo in config/repos.yaml
# or target a single repo:
npx tsx --env-file=.env.local engine/entry.ts --once --repo <id>
```

Then open the observability UI (reads the same SQLite file the engine writes):

```bash
npm run dev --workspace @operator/app              # http://localhost:3000
```

### Developer checks

Every change must pass all three before merge (CI-blocking):

```bash
npm run typecheck                                  # tsc --noEmit across workspaces
npm test                                           # vitest — coverage gated
npm run lint                                       # eslint + ts-prune + knip (dead-code gates)

# Fresh-DB smoke test
npx tsx --env-file=.env.local engine/entry.ts --once --fresh-db --repo <id>
```

See [docs/deployment.md](docs/deployment.md) for systemd / Docker Compose / Kubernetes manifests and the environment-variable reference.

## Automation status

The `orchestrator` GitHub Actions workflow runs on its 5-minute cron and on manual dispatch (`gh workflow run orchestrator.yml`). The workflow builds the engine, runs one `--once` cycle against every repo in `config/repos.yaml`, and surfaces the summary in the Actions UI. Observability is through the `@operator/app` UI — point it at the same SQLite file the engine writes.

## Contributing

PRs follow the rules in `intelligence/rules/` (synced to `.claude/` and `.cursor/` via `bash intelligence/scripts/sync.sh`). The non-negotiable three:

1. **No dead code.** Every export is reachable from `engine/entry.ts` or a colocated test. `ts-prune` via `scripts/check-ts-prune.mjs` is CI-blocking.
2. **No force-push.** Every commit-push sequence is fast-forward-safe. `FileWorkspaceScope` is the only file that decides branch creation.
3. **One PR per migration step.** Never combine. Rollback is a single revert.

Commit message format: one line, capital letter, past tense, no prefixes (no `feat:`, `fix:`, etc.), no `Co-authored-by`, no `Signed-off-by`.
