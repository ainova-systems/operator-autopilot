---
name: operator-migrate-next
description: Identify and execute the next uncompleted step from the internal migration plan
argument-hint: [--dry-run]
agent: operator-migration
---

# Execute Next Migration Step (v5)

Systematically advance the v5 rebuild by identifying and executing the next uncompleted step from the internal migration plan (kept outside this public repo). The v5 migration is already complete, so on a fresh repo there is no step to advance; the discipline below stays in force for any future migration work. v4 migration was abandoned — the post-mortem is no longer in this repo.

## Canonical reference files

Read before executing any step:

| Document | When to read |
|----------|-------------|
| `intelligence/rules/migration.md` | Always — v5 discipline, quality gates, v4 lessons |
| `intelligence/rules/typescript.md` | Always — layer dependencies, primitives boundary, FORBIDDEN/REQUIRED |
| `intelligence/rules/context.md` | Always — repo layout, doc canon, global rules |
| `docs/architecture-v5.md` | Always — target shape, affected sections for current step |
| `docs/workflow.md` | Always — behavior contract, 8-step run loop |
| `docs/vision.md` | When step touches product invariants or non-goals |

## Steps

1. Read the internal migration plan completely, focusing on its phase overview and progress dashboard. (The plan is kept outside this public repo, and the v5 migration is already complete — if there is no open plan, there is no step to advance: report that and stop.)
2. Scan the dashboard. Identify the first step with status `not started`. That is your target.
3. Report the identified step to the user:
   - Step number and title from the phase overview
   - Summary of the step's goal (from the step's own section)
   - Files it will create, delete, move, or modify
   - Dependencies on previous steps (verify the chain is complete)
   - Verification commands
4. If `--dry-run` was passed, **STOP here** and report only.
5. If no `--dry-run`, proceed with full execution:
   a. Read all canonical reference files listed above (filter by relevance to the step)
   b. Read the current state of files the step will modify (full read, not just glanced)
   c. Implement the changes following `intelligence/rules/typescript.md` layer graph
   d. Create colocated `.test.ts` for every new implementation file
   e. Run full verification:
      - `npm run typecheck`
      - `npm test -- --coverage`
      - `npm run lint` (includes `ts-prune` for dead code)
      - `npx tsx --env-file=.env.local engine/entry.ts --once --fresh-db --repo <repo-id>` — end-to-end cycle must complete
   f. Run `ts-prune` manually if ESLint does not yet include it, delete anything newly orphaned
   g. Update the progress dashboard in the internal migration plan (status → "completed", note PR link or date)
6. Report results and next step.

## CRITICAL

- **ONE step at a time** — never combine multiple steps in a single execution
- **NO DEAD CODE** at the end — `ts-prune` must be green
- **No backward-compatibility shims** for v4 — delete, don't wrap
- **No new files under `engine/pipeline/stages/`** — stages are config in `agents/workflow/stages.yaml`
- **No direct `git.*` / `PRManager.*` / `VCSPlatform.*` / `AgentRuntime.*`** calls outside `engine/pipeline/primitives/**`
- **`engine/entry.ts` stays under 200 lines** — no `switch (action)` block
- **Platform-neutral vocabulary** in core — `CodeReview`, `WorkItem`, never `PullRequest` / `Issue`
- **Phase ordering is strict** — never skip steps, never reorder
- **End-to-end verification on a managed repo is mandatory** — v4 tests passed while end-to-end failed, that is how we got the 2026-04-13 incident
- **Update the internal migration plan's progress dashboard** as part of the step, not as a follow-up
