---
paths:
  - "docs/migration*.md"
  - "docs/architecture*.md"
  - "docs/workflow.md"
  - "docs/vision.md"
  - "engine/**"
  - "packages/*/src/**"
  - "app/src/**"
---

# Operator v5 Migration Rules

> **Status: Migration complete — v5.0.0 tagged (2026-04-17).** The 17-step migration plus the Step 18 readiness review are merged; the document below is kept for historical context and as the authoritative source of v4 lessons. Do not execute the step-by-step instructions on a fresh PR. The "Lessons from v4" and FORBIDDEN/REQUIRED sections remain active permanent rules for ALL future PRs — the accumulation patterns that killed v4 must not return.

v4 migration failed. v5 is the rebuild. Non-negotiable discipline below.

## Before ANY migration work — MANDATORY reading order

1. **`docs/migration-v5.md`** — find the CURRENT step, identify the exact next uncompleted PR. Update the progress dashboard (§17) at the end of each completed step.
2. **`docs/architecture-v5.md`** — target shape — read in full before touching code. Pay attention to §3 (run-stage loop), §5 (KVStore model), §6 (sync contract).
3. **`docs/workflow.md`** — behavior contract — 8-step run loop, 3 persistence modes, 5 verdicts, MVP stage list as config.
4. **`docs/vision.md`** — product invariants (§10), non-goals (§9), what we refuse to build (§12).
5. **`docs/architecture.md`** — current-state snapshot so you know exactly what you are migrating from.
6. **`docs/archive/v4/failed-migration.md`** — post-mortem — do not repeat these mistakes.

## FORBIDDEN

- **🚨 Direct commits / pushes to `develop` / `master` / `main`.** Operator authors feature branches + PRs only. See `context.md`.
- **🚨 Re-selecting a work-item whose PR ended in any terminal disposition (rejected / cancelled / closed / duplicate) — for ANY kind.** Selectors must filter terminal items unconditionally. See `context.md`.
- **Combining two steps in one PR.** Each migration step is a single PR, single rollback, single review.
- **Landing dead code.** Every PR ends with `ts-prune` clean. If a new export has no consumer in the same PR, split or revert.
- **Backward-compatibility shims for v4.** v4 state can be wiped; there is no data migration layer.
- **Feature flags for migration.** No parallel code paths between "old behavior" and "new behavior."
- **Skipping phases.** 1 → 2 → 3 → ... → 18. Never skip. Never reorder. `5a` runs after `5`, `8a` before `8b`.
- **Skipping end-to-end verification.** Every step ends with `npx tsx --env-file=.env.local engine/entry.ts --once --fresh-db --repo <repo-id>` running clean.
- **Adding a new file under `engine/pipeline/stages/`.** v5 has no such directory. Stages are config.
- **Reviving deleted code "because it might be useful later."** If something needs to come back, land its consumer first.
- **Force-push of any kind.** Including `--force-with-lease`.

## REQUIRED

- **ONE STEP = ONE PR.** If a step is too large for one PR (>800 lines), split mid-step with an explicit hand-off note added to `migration-v5.md`.
- **Every PR description lists what was deleted.** If nothing, reviewer asks why.
- **`ts-prune` runs clean** at the end of every PR from step 2 onwards.
- **Tests green**: `npm run typecheck && npm test -- --coverage && npm run lint`.
- **Coverage >=90%** on touched files. >=95% for primitives.
- **Progress dashboard updated** in `docs/migration-v5.md §17` at the end of every completed step.
- **Commit message is one line**, capital letter, past tense, no prefixes. Describes what changed, not what was tried.

## v5 Step Sequence (from migration-v5.md)

The source of truth is `docs/migration-v5.md §1` (phase overview) and `§17` (progress dashboard). This table MUST stay aligned with it.

| Step | Title | Status at time of writing |
|---|---|---|
| 1 | Layout refactor to monorepo | ✅ done |
| 2 | Dead code audit + delete | ✅ done |
| 3 | Asset relocation: `engine/content/` | ✅ done |
| 4 | `packages/core` + shared types + Zod schemas | ✅ done |
| 5 | KVStore + SQLite + seed.ts | ✅ done |
| 5a | Remove gitflow branch naming assumption | ✅ done |
| 6 | `@operator/app` Next.js read-only observability | ✅ done |
| 7 | `WorkspaceScope` + `FileOutputAdapter` primitives | ✅ done |
| 8a | Init-ordering fix (workspace prep hoist + `checkInitialized` removed) | ✅ done |
| 8b | `runStage` skeleton + init stage migration | next |
| 9 | finding-plan + task-execute migration | |
| 10 | pr-review migration | |
| 11 | research migration | |
| 12 | retrospective migration + `engine/pipeline/stages/` deleted | |
| 13 | Kind registry + open `WorkItemType` | |
| 14 | Execution history + reviewer summary + status observation layer | |
| 15 | Seed refactor: every consumer reads from KV | |
| 16 | UI write path: API + JSON editor + audit log + connection-management UI | |
| 17 | Polish: docs, tests, final dead-code sweep, ESLint error-flip, ts-prune in CI | |
| 18 | Production readiness review + optimization (added post-8a) | |

## Quality Gates (per PR)

- `npm run typecheck` passes on all workspaces
- `npm test` passes
- `npm run lint` passes (ESLint + `ts-prune`)
- Coverage >=90% for touched files
- LF line endings on all `.ts`, `.md`, `.yaml`, `.yml`
- Only `engine/pipeline/primitives/**` and `engine/pipeline/stage-logic/**` may call `git.*` / `PRManager.*` / `VCSPlatform.*` / `AgentRuntime.*`. `stage-logic/` files receive these deps via DI from `entry.ts` and compose them through `runStage`; they must not instantiate concrete implementations with `new`. All other modules are forbidden from direct calls. Branch management is still exclusively owned by `WorkspaceScope` (non-negotiable after 2026-04-13).
- No `switch (action)` in `entry.ts`
- Every stage execution produces an `executions/{id}` KV entry
- Every new primitive has a colocated test with >=95% coverage
- **Observability check**: every externally-observable action (commit, push, PR create/update, comment, label change) has an INFO log line with enough context (PR number, SHA, branch, verdict, duration) to reconstruct the run from logs alone. Every caught error has an ERROR or WARN line with full `.cause`. No silent success paths. This gate is a BLOCKER — v5 exists specifically to fix the "I cannot see what the engine did" problem that killed v4 trust.

## Lessons from v4 — apply on every PR

1. **Dead code kills migrations.** BaseStage existed as dead code in v4 for weeks before anyone noticed. `ts-prune` in CI from step 2 onwards is not optional.
2. **Workspace branch logic lives in ONE place.** The 2026-04-13 improver non-fast-forward push was caused by seven stages each doing their own git branch dance. `WorkspaceScope` primitive fixes this — never call `git.checkoutNewBranch` directly outside that one file.
3. **Observability early, not late.** User lost 2 weeks because they couldn't see what the engine was doing. Step 5 (Next.js app) is deliberately early — every subsequent step is visually verifiable before merge.
4. **Stages are config, not code.** In v5, if you are writing a new file under `pipeline/stages/`, STOP. There is no such directory. Stages live in `agents/workflow/stages.yaml`.
5. **One composition root.** Only `engine/entry.ts` uses `new` on concrete implementations. No other file instantiates cross-layer classes.
6. **Read the actual code before generalizing.** v4 vision described an abstraction layer that never matched what was in `src/`. v5 docs are grounded in the current-state snapshot `docs/architecture.md`.
7. **INFO logs are not optional.** v5 is being rebuilt because the operator was invisible in v4 — the user had to cross-reference GitHub and grep DEBUG stdout to figure out what happened on a cycle. Every externally-observable action (commit, push, PR change, label flip, bot comment) gets an INFO line. Every decision with a reason gets an INFO line. "I could tell from the log" is a hard acceptance criterion. Line-count caps do NOT apply to log statements.

## Key v5 invariants to verify per PR

- `engine/entry.ts` stays under 200 lines
- `engine/pipeline/**/*.ts` files stay under 200 lines
- `engine/pipeline/stages/` does not exist (from step 11 onwards)
- Every stage execution produces an `executions/*` KV entry
- Agents only write to workspace files; orchestrator only writes to KV
- `syncFromFiles` is the single reconciler, runs once per cycle at cycle start
- `WorkItem.kind` is `string`, not a closed union (from step 12 onwards)
- Dead-code `ts-prune` green at the end of every PR

Any intentional deviation from `docs/architecture-v5.md` or `docs/workflow.md` requires an explicit update to those docs in the same PR and a test that proves the new behavior.
