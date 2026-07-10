# Operator (ainova-systems/operator-autopilot)

Closed-loop SDLC engine: discovers issues, plans fixes, implements code, verifies, delivers, observes, learns.

**Architecture principle**: orchestrator, not agent. Schedules work and invokes external agent CLIs. Never reimplements tool execution.

**Current state**: the v5 rebuild is complete. The earlier v4 migration failed because duplicate stage plumbing and dead code accumulated — v5 does not repeat those mistakes.

## Repository Structure (monorepo)

Layout refactor is done. Code lives in `engine/` (flat, no `src/` subdirectory). Packages and app are workspaces under npm workspaces config at root.

```
git-operator-autopilot/
├── package.json             @operator/engine — root workspace (owns engine/ tree)
├── tsconfig.json            root tsconfig, rootDir = engine
├── vitest.config.ts         vitest config, covers engine/ + packages/ + app/
├── engine/                  daemon source + bundled content
│   ├── entry.ts             composition root
│   ├── pipeline/, agents/, config/, infra/, state/, …   TypeScript sources (flat, no src/)
│   └── content/             non-code engine assets — bundled with the engine
│       ├── prompts/
│       │   ├── agents/      role prompts (analyst.md, creator.md, ...)
│       │   │   ├── context/ bundled base / state context
│       │   │   └── reviewer/ stage-scoped reviewer criteria
│       │   ├── stages.yaml  MVP stage definitions (seeded into KV in Step 5)
│       │   └── kinds.yaml   work-item kind registry (seeded into KV in Step 5)
│       ├── templates/       PR body + format templates
│       └── defaults/        defaults.yaml + agents.yaml (engine defaults)
├── app/                     @operator/app — Next.js observability UI
│   ├── package.json
│   ├── next.config.ts
│   └── src/
├── packages/
│   ├── core/                @operator/core — shared types, interfaces, Zod schemas, error classes
│   │                        (runtime: no I/O, no cross-workspace imports; zod only)
│   │   ├── package.json
│   │   └── src/
│   └── adapters/            @operator/adapters — KVStore / Guard / RateLimiter / VCS impls
│       ├── package.json
│       └── src/
├── config/                  instance config — ONLY repos.yaml (seed-mirror source)
│   ├── repos.yaml           managed repos (committed during MVP testing window)
│   └── repos.yaml.example   documented template
├── intelligence/            this framework (rules, agents, skills)
├── docs/                    architecture, migration, workflow, vision
├── dev/                     repo tooling
└── state/                   gitignored runtime workspace (user-configurable path)
```

Legacy v1 bash code no longer lives in this repo — it was extracted to the sibling `git-legacy-operator` repository. No TypeScript, doc, config, or CI pipeline here references it.

## Canonical Documentation

| Doc | Purpose |
|-----|---------|
| `docs/workflow.md` | Target behavior: 8-step run loop, persistence modes, verdicts, MVP stage list |
| `docs/vision.md` | Product direction, invariants, non-goals, four tenets |
| `docs/architecture-v5.md` | Target shape: monorepo layout, primitives, KV model, package boundaries |

## Build / Test / Dev

```bash
npm install                                  # workspace root
npm run typecheck                             # tsc --noEmit
npm test                                      # vitest
npm test -- --coverage                        # coverage (>=90% required)
npm run lint                                  # eslint + ts-prune (dead code check)
npm run dev --workspace @operator/app         # Next.js UI on localhost
npx tsx --env-file=.env.local engine/entry.ts --once   # one manual cycle
npm run exec                                  # alias for above
```

## Global Rules (enforced every PR)

- **🚨 OPERATOR NEVER PUSHES `master` / `main` / `develop`. PR feature branches only.**
- **🚨 PR closed / rejected / cancelled / duplicate → work item TERMINAL. Selectors skip unconditionally. ALL kinds.** Only the retrospective stage reads terminal items (as analysis input) and only Phase 6 P-505 retrospective recovery flow may spawn replacement work-items.
- **NO DEAD CODE.** Every file and exported symbol must be reachable from `entry.ts` import closure or a colocated test. `ts-prune` in CI. Dead code is a migration blocker — v4 died from exactly this pattern.
- **NO FORCE-PUSH.** Every commit-push sequence is fast-forward-safe. `WorkspaceScope` primitive is the only place that manages branches. Non-negotiable after 2026-04-13 incident.
- **One PR per migration step.** Never combine two steps. Rollback must always be a single revert.
- **Platform-neutral vocabulary** in core: `CodeReview`, `WorkItem`. Forbidden: `PullRequest`, `Issue`, `MergeRequest` outside `platforms/github/`.
- **Composition root is `engine/entry.ts` only.** No other file instantiates cross-layer classes with `new`.
- **OperationContext** threaded through every I/O function (traceId, repoId, action, budget, signal).
- **Named exports only.** No default exports.
- **LF line endings** on all `.ts`, `.md`, `.yaml`, `.yml`, `.sh`, `.bats`.
- **TypeScript strict**: `strict: true`, no `any`, no `@ts-ignore`.
- **Max 200 lines** per file in `engine/pipeline/**`. Max 300 elsewhere. `entry.ts` must stay under 200.
- **Git commits**: exactly one line, capital letter, past tense, no prefixes (no `feat:`, `fix:`, `chore:`). No `Co-authored-by`, no `Signed-off-by`.

## Merge Authority (who may land a PR on `master`)

The engine daemon never merges and never pushes a protected branch — the first Global Rule above is
unchanged and applies to every stage the operator runs.

Landing a PR on `master` is a separate authority, held by exactly two actors:

- **The owner**, at any time.
- **The `operator-review-open-prs` merge gate**, run under the owner's account, and only for a PR that
  clears every deterministic gate *and* that `operator-pr-architect` returned `verdict: PASS` for at the
  PR's current head SHA. It squash-merges and deletes the branch.

The gate **never** auto-merges, and instead relabels `ai:manual` for the owner, when the change touches a
**protected surface** — `.github/**`, Docker/compose/deploy manifests, `package.json` /
`package-lock.json`, `engine/entry.ts`, or `config/repos.yaml` — or when the architect reports
`owner_decision: yes` or `confidence: low`, or when a **human** raised a review thread on it.

This is a deliberate, owner-granted exception to the dev-pack rule *"autonomous runs never merge
themselves"* (`git-workflow`). It is scoped to this repository's own PR queue and to that one skill.
Nothing else — no engine stage, no other skill, no agent — may merge.

### Outcome labels

- `ai:ready-to-merge` — cleared the operator's own verifier; awaiting the merge gate.
- `ai:in-review` — blocking findings the **operator's supervisor** fixes, then re-promotes.
- `ai:manual` — needs an **owner** decision. Only the owner clears it.

## Deployment

Primary runtimes: VM/systemd, plain Docker/Compose, Kubernetes. Docker AI Sandbox is optional quick-start only, never the sole path. Local-first: SQLite + filesystem + one agent API key is enough.

## Shared Files (consumed by engine and app)

**Engine-bundled content** (under `engine/content/`, resolved via `resolveContentPath` from `engine/infra/content-path.ts`):

- `engine/content/defaults/defaults.yaml` — schedules, labels, conventions (engine defaults).
- `engine/content/defaults/agents.yaml` — agent role + provider config (engine defaults).
- `engine/content/prompts/agents/*.md` — runtime agent prompts. Seeded into KV category `prompts/*` in Step 5.
- `engine/content/prompts/agents/context/*.md` — bundled base + state context.
- `engine/content/prompts/agents/reviewer/{stage}.md` — stage-scoped reviewer criteria.
- `engine/content/prompts/stages.yaml` — MVP stage definitions, seeded into `workflow-stages/*` in Step 5.
- `engine/content/prompts/kinds.yaml` — work-item kind registry, seeded into `work-item-kinds/*` in Step 5.
- `engine/content/templates/*.md` + `formats/*.txt` — PR body and format templates.

**Instance config** (under `config/` at repo root):

- `config/repos.yaml` — managed repos. Seed-mirror source for `kv:repos/*` (Step 5).
- `config/repos.yaml.example` — documented template.

## Sync Contract

- **Agents write only to workspace files.** Never to KV.
- **Orchestrator writes only to KV** via primitives inside `run-stage.ts`.
- **`syncFromFiles`** runs once at cycle start and is the only reconciler from file state to KV work items.
- **Seed** never overwrites existing KV entries except on explicit `--reseed {category}`.
- **Three layers of truth**: work item content → git; runtime config → KV (seeded from repo); execution state → KV only.

## AI Prompt Framework

Rules, agents, skills for this project live in `intelligence/`:

- `intelligence/rules/` — coding standards (path-scoped or always-loaded)
- `intelligence/agents/` — specialized AI personas for development tasks
- `intelligence/skills/` — reusable command sequences

Sync with `bash intelligence/sync/scripts/sync.sh`. Generated outputs (`.claude/`, `.cursor/`) are gitignored.
