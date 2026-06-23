# Contributing

Thanks for your interest in improving Operator. This guide covers local
setup, the checks every change must pass, and the conventions the codebase
enforces.

## Prerequisites

- **Node.js 24+** and **npm**.
- **git 2.40+** on `$PATH` (the engine shells out to `git` in managed workspaces).
- One **agent CLI** (e.g. Claude Code) on `$PATH` for end-to-end runs.
- A **GitHub token** with repo scope for runs against a real repository.

## Setup

```bash
npm install                                        # install all workspaces
cp config/repos.yaml.example config/repos.yaml     # then edit for your repo
cp .env.local.example .env.local                   # then fill in MANAGED_REPO_GH_TOKEN + agent key(s)
```

## Build, test, lint

Every change must pass all three before it is merged:

```bash
npm run typecheck     # tsc --noEmit across all workspaces
npm test              # vitest with coverage (>=90% on touched files)
npm run lint          # eslint + ts-prune + knip (dead-code gates)
```

One manual cycle against a configured repo:

```bash
npx tsx --env-file=.env.local engine/entry.ts --once --repo <repo-id>
```

## Project layout

- `engine/` — the daemon (composition root `engine/entry.ts`, flat layout).
- `engine/content/` — bundled prompts/templates/defaults, seeded into the KV store.
- `packages/core` — shared types, interfaces, error classes (zero runtime).
- `packages/adapters` — concrete implementations (SQLite KV, GitHub VCS, …).
- `app/` — Next.js observability UI.
- `deployment/` — container image + compose for running the engine.

See `docs/` for the architecture, workflow, and vision documents.

## Code standards

These are enforced in review and partly in CI. The non-negotiables:

- **TypeScript strict.** No `any`, no `@ts-ignore`, no `as any`.
- **Named exports only** — no default exports. Use `import type` for types.
- **No dead code.** Every exported symbol is reachable from `engine/entry.ts`
  or a colocated test; `ts-prune` and `knip` run in CI.
- **Colocated `*.test.ts`** for every implementation file, `>=90%` coverage on
  touched files (`>=95%` for `engine/pipeline/primitives/`). Every bug fix ships
  with a regression test named for the bug scenario.
- **`OperationContext` threaded** through every function that touches state,
  git, VCS, or the filesystem.
- **Layer boundaries.** `@operator/core` never imports adapters/engine/app;
  `@operator/adapters` never imports engine/app. Only
  `engine/pipeline/primitives/` may call `git.*` / `PRManager.*` /
  `VCSPlatform.*` / `AgentRuntime.*` directly. Branch management lives only in
  `WorkspaceScope`.
- **No force-push, ever** (including `--force-with-lease`). The operator never
  pushes to `master` / `main` / `develop` — it authors feature branches + PRs.
- **Platform-neutral vocabulary** in core (`CodeReview`, `WorkItem`), never
  `PullRequest` / `Issue` outside `engine/platforms/github/`.
- **Observability.** Every externally visible action (commit, push, PR change,
  label flip, comment) and every decision gets an INFO log line with enough
  context to reconstruct the run from logs alone.
- **English-only source** — all output, comments, identifiers, and docs.
- **LF line endings** on all `.ts`, `.md`, `.yaml`, `.yml`, `.sh`.
- **File size:** `engine/pipeline/**` ≤200 lines, elsewhere ≤300 (logging,
  comments, and JSDoc do not count toward the cap).

## Commit messages

Exactly one line: a capital letter, past tense, no prefixes (no `feat:`,
`fix:`, `chore:`), and no `Co-authored-by` / `Signed-off-by` trailers. Describe
what changed, not what was tried — e.g. `Added the KVStore SQLite adapter`.

## Pull requests

1. Branch from `master`.
2. Keep each PR to a single logical change with a clean revert.
3. Ensure `npm run typecheck && npm test && npm run lint` are green.
4. List anything the PR deletes in the description.

By contributing you agree that your contributions are licensed under the
project's [MIT License](LICENSE).
