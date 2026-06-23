---
name: operator-run-tests
description: Run the correct test suites (vitest across workspaces) based on the scope of pending changes
argument-hint: [--coverage] [--workspace <name>]
---

# Run Operator Tests

Detect which workspaces to test based on changed files and execute vitest. Post-migration the project is a monorepo with `engine/`, `app/`, `packages/core/`, `packages/adapters/`.

## Steps

1. **Detect scope** — run `git status --porcelain` + `git diff --name-only`, then classify:
   - **engine scope**: any changed file under `engine/` or root `package.json` / `tsconfig.json`
   - **app scope**: any changed file under `app/src/`, `app/package.json`, `app/tsconfig.json`
   - **core scope**: any changed file under `packages/core/src/`
   - **adapters scope**: any changed file under `packages/adapters/src/`
   - **Docs/prompts only**: everything else (`docs/`, `intelligence/`, `templates/`, `config/`, `*.md`, `agents/`) — report and stop, no tests to run

2. **Honor flags**
   - `--coverage`: add `-- --coverage` to vitest invocation. Enforce >=90% gate
   - `--workspace <name>`: run tests only in the specified workspace regardless of detected scope

3. **Type check first** — before any test run:
   - `npm run typecheck` (runs `tsc --noEmit` across workspaces)
   - On type error: report the failing file, first error, STOP

4. **Run tests for detected workspaces**
   - All workspaces: `npm test`
   - With coverage: `npm test -- --coverage`
   - On test failure: report failing file, test name, first error message, STOP

5. **Run lint** (if any source file changed, not docs-only)
   - Post-step-1: `npm run lint`
   - `ts-prune` is part of lint — catches dead code
   - On lint error: report the finding, STOP

6. **Report results**
   - Per workspace: pass/fail counts, duration, coverage (if measured)
   - Mixed scope: summary block with all workspaces
   - Note any orphaned exports flagged by `ts-prune`

## CRITICAL

- NEVER modify test configurations or test code to make a failing test pass
- NEVER skip the type check even if tests are requested directly
- NEVER skip lint — dead code is a migration blocker
- Coverage gate: >=90% for touched files, >=95% for primitives in `engine/pipeline/primitives/`
- If `ts-prune` reports unused exports, that is a lint failure — treat as test failure
