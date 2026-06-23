---
name: operator-review-pending-changes
description: Read-only review of pending git changes against Operator v5 rules (layer deps, primitives boundary, dead code, commit hygiene)
agent: operator-code-reviewer
---

# Review Pending Changes (v5)

Review uncommitted changes against v5 rules BEFORE committing. Read-only — never writes or fixes, only reports.

## Steps

1. **Enumerate changes**
   - `git status --porcelain` — untracked and modified files
   - `git diff --stat` — lines added/removed per file
   - If no changes — report and stop

2. **Load relevant rules**
   - Always: `intelligence/rules/context.md` (global rules)
   - If any changed file under `engine/**`, `packages/*/src/**`, `app/src/**`: load `intelligence/rules/typescript.md`
   - If any changed file under `docs/migration*`, `docs/architecture*`, `docs/workflow.md`, `docs/vision.md`, or any `src/` file in a migration context: load `intelligence/rules/migration.md`

3. **Read full diffs**
   - `git diff` for unstaged, `git diff --cached` for staged
   - For each modified file, hold the full change in memory

4. **Check against rules** — produce findings grouped by severity:

   **Critical** (block commit):
   - Package boundary violation (`core` importing `adapters`, `app` importing `engine` runtime, etc.)
   - Layer dependency violation inside `engine/` (upward or sideways imports)
   - Direct `git.*` / `WorkspaceGit` / `PRManager` / `VCSPlatform` / `AgentRuntime` call outside `pipeline/primitives/`
   - New file under `engine/pipeline/stages/` (directory does not exist in v5)
   - `switch (action)` block in `entry.ts` (v5 engine iterates from KV config)
   - Platform-specific terms in core (`PullRequest`, `Issue`, `MergeRequest` outside `platforms/github/`)
   - `any`, `@ts-ignore`, `as any` cast
   - Missing `OperationContext` on I/O function
   - Missing colocated `.test.ts` for new non-`types/` implementation file
   - Dead code: new exported symbol with no consumer in the same PR and no test
   - Force-push or `git push --force*` present
   - CRLF line endings on `.ts`, `.md`, `.yaml`, `.yml`
   - Secrets, `.env` content, credentials, large binaries staged
   - Agent code writing to KV (only orchestrator primitives write KV)
   - Orchestrator code writing directly to workspace files outside `persist-output.ts`
   - `WorkItemType` as closed union re-introduced (post-step-12)

   **Warning**:
   - File over 200 lines in `pipeline/**`, over 300 elsewhere
   - `entry.ts` over 200 lines
   - Multiple concepts in one file
   - `import *`, default export, barrel re-export
   - Helper duplicated in 2+ files → candidate for shared helper
   - Missing Zod validation at external boundary
   - Defensive checks in core on trusted internal data
   - Coverage <90% for touched file (<95% for primitives)

   **Suggestion**:
   - Comments restating what the code already says
   - Opportunity to extract a helper
   - Unclear variable/function name
   - Test using `vi.fn()` where a fake implementation would be clearer

5. **Report findings** using this format:

```
## Critical
- `engine/pipeline/finding-plan.ts:42` — direct call to `git.checkoutNewBranch`, must go through `WorkspaceScope` primitive

## Warning
- `engine/pipeline/primitives/workspace-scope.ts:210` — file exceeds 200-line cap for pipeline/**

## Suggestion
- `packages/adapters/src/kvstore-sqlite/index.ts:100` — JSON field filter duplicated in 3 queries, extract helper

## Summary
- files: <N>, +<added> / -<removed>
- critical: <N>, warning: <N>, suggestion: <N>
- verdict: BLOCK | PASS-WITH-WARNINGS | CLEAN
```

## CRITICAL

- Read-only — NEVER edit, stage, or commit
- NEVER auto-fix findings — only report
- If verdict is `BLOCK`, recommend the user fix before running `/operator-commit-push`
- Dead code is always critical — v4 migration died from exactly this
- Force-push is always critical — 2026-04-13 incident
- Writing new files under `engine/pipeline/stages/` is always critical — v5 has no such directory
