# Operator

Closed-loop SDLC engine that autonomously discovers issues, plans fixes, implements code, verifies, delivers, observes, and learns. **Orchestrator, not agent** — schedules work and invokes external agent CLIs (Claude Code, OpenCode, …) through a single generic stage loop.

**Status: 0.5.0 — first public release.** The v5 architecture rebuild is complete and running; this is the first public cut. See [CHANGELOG.md](CHANGELOG.md) for release notes. The v4 implementation was abandoned mid-migration — v5 collapses all pipeline work into `runStage` + 10 primitives, puts state in a pluggable KV model, and ships an observability UI from day one.

## Before you run it — blast radius

Operator acts on real repositories without a human in the loop. Know what it can reach before the first cycle:

- It runs with a **git host token carrying repo scope**, and it invokes an **external agent CLI** that edits files in a local workspace.
- It **pushes branches and opens pull requests** on every repository you register — through the setup screen or in `config/repos.yaml` — and nothing outside that list.
- It **never pushes `master` / `main` / `develop`**. Every change arrives as a feature branch plus a pull request.
- Every MVP stage ships with `merge: gated` in [engine/content/prompts/stages.yaml](engine/content/prompts/stages.yaml) — **nothing lands without a human approving the pull request**.

Start against a **non-critical repository** — a scratch repo or a fork — until you have watched a few cycles end to end in the observability UI, and give the token access to that repository only.

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

**Prerequisites:** Node.js 24+, `git` 2.40+ on `$PATH`, the agent CLIs named in [engine/content/defaults/agents.yaml](engine/content/defaults/agents.yaml) on `$PATH`, and a GitHub token with repo scope for the repository you want managed. Docker covers all of that for you — see the second path below.

Both paths end in the same place: **`http://localhost:3000/setup`**, a four-step screen that
creates the engine's state database, checks this host (git, the agent CLIs, the token — with a
one-shot token verification against GitHub that stores nothing), registers the managed repository,
and tells you how to start the first cycle. Nothing has to be hand-edited to get there.

### Quick start — local

```bash
npm install                                        # install all workspaces
cp .env.local.example .env.local                   # then fill in your tokens (gitignored)

npm run dev --workspace @operator/app              # then open http://localhost:3000/setup
```

The setup screen checks the credentials it can see in its own process, and the root `.env.local`
belongs to the engine — copy the same values into `app/.env.local` (also gitignored) if you want
those checks to resolve rather than warn.

The dev server holds the terminal. Complete the setup screen, then run a cycle from a second
terminal against the repository you registered:

```bash
npx tsx --env-file=.env.local engine/entry.ts --once --repo <repo-id>
```

`npm run exec` does the same for every registered repository. Prefer a file to a screen? Copy
`config/repos.yaml.example` to `config/repos.yaml` and edit it instead — the engine mirrors that
file into its database on start, and the setup screen is simply the other way in.

### Quick start — Docker

The image bundles Node, git, `gh`, ripgrep, and the agent CLIs, so the host needs none of them.

```bash
cp deployment/.env.example deployment/.env         # then fill in the tokens
docker compose -f deployment/docker-compose.yml up -d --build

# open http://localhost:3000/setup
```

The engine daemon and the UI run from the same image against one shared state volume. The UI is
published on loopback only (it edits engine configuration and has no authentication of its own);
put it behind an authenticating reverse proxy before changing `OPERATOR_APP_BIND`.

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

Operator runs as an always-on daemon, not as a CI job — it schedules its own cycles over every repo in `config/repos.yaml`. See [docs/deployment.md](docs/deployment.md) for the systemd / Docker Compose / Kubernetes manifests, or use `npm run exec` for a single manual cycle.

Two GitHub Actions workflows back that: [Tests](.github/workflows/tests.yml) runs typecheck, tests, and lint on every push and pull request touching code, and [Build Image](.github/workflows/build-image.yml) publishes the engine image to GHCR on `master` and on a nightly schedule.

Observability is through the `@operator/app` UI — point it at the same SQLite file the engine writes.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for setup, the checks, and the full code standards. PRs follow the rules in `intelligence/rules/` (synced to `.claude/` and `.cursor/` via `bash intelligence/sync/scripts/sync.sh`). The non-negotiable three:

1. **No dead code.** Every export is reachable from `engine/entry.ts` or a colocated test. `ts-prune` via `scripts/check-ts-prune.mjs` is CI-blocking.
2. **No force-push.** Every commit-push sequence is fast-forward-safe. `FileWorkspaceScope` is the only file that decides branch creation.
3. **One PR per migration step.** Never combine. Rollback is a single revert.

Commit message format: one line, capital letter, past tense, no prefixes (no `feat:`, `fix:`, etc.), no `Co-authored-by`, no `Signed-off-by`.

## Security

Report vulnerabilities privately through the repository's Security tab — see [SECURITY.md](SECURITY.md). Please do not open a public issue for a suspected vulnerability.

## License

[MIT](LICENSE).
