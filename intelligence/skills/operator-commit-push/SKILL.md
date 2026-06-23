---
name: operator-commit-push
description: Verify build, review changes, commit and push with a clean single-line message
---

# Commit and Push (v5)

Verify, review, commit, and push pending changes in one command. v5 rules apply — dead code is a blocker, force-push is forbidden.

## Steps

1. **Check pending changes**
   - `git status` and `git diff --stat`
   - If no changes — report and stop

2. **Detect change scope**
   - TypeScript changes (`engine/`, `packages/*/src/`, `app/src/`, `package.json`, `tsconfig.json`): run type check + vitest + lint
   - Docs / prompts only (`docs/`, `intelligence/`, `templates/`, `config/*.yaml`, `agents/*.md`, `*.md`): skip build verification
   - Mixed: run all applicable checks

3. **Run verification** (fail = stop, report errors, do NOT commit)
   - `npm run typecheck && npm test && npm run lint`
   - `npm run lint` includes `ts-prune` for dead code — this is a blocker, not a warning
   - Skip for docs-only changes
   - On failure: report which check failed, first error, STOP

4. **Quick review** — read the full diff (`git diff` for unstaged, `git diff --cached` for staged)
   - Check for: accidental `console.log`, TODO left behind, secrets/tokens, broken imports, accidental force-push command
   - Check for v5 red flags:
     - New file under `engine/pipeline/stages/` (directory does not exist in v5)
     - Direct `git.checkoutNewBranch` / `git.push --force*` outside `pipeline/primitives/`
     - `switch (action)` added to `entry.ts`
     - `any` type or `@ts-ignore`
     - Unused exports (ts-prune catches this but verify manually too)
   - If issues found — report and stop, do NOT commit

5. **Build commit message**
   - Exactly ONE line, never multiline
   - Capital letter, past tense, no prefixes (no `feat:`, `fix:`, `chore:`)
   - No `Co-authored-by`, no `Signed-off-by`
   - Describes what changed, not what was tried
   - Examples:
     - "Extracted WorkspaceScope primitive and fixed improver non-fast-forward push"
     - "Added KVStore interface with SQLite implementation"
     - "Migrated finding-plan and task-execute stages to runStage"
     - "Deleted BaseStage class and orphan stage subclasses"

6. **Stage, commit, push**
   - `git add` only relevant files (never `git add -A` blindly — exclude `.env`, credentials, large binaries)
   - `git commit -m "message"`
   - `git push` (fast-forward only, NEVER `--force` or `--force-with-lease`)
   - Report: commit hash, branch, files changed

## CRITICAL

- NEVER commit secrets, `.env` files, credentials, or large binaries
- **NEVER use `git push --force` or `git push --force-with-lease`** — 2026-04-13 incident, non-negotiable
- NEVER amend existing commits
- NEVER add `Co-authored-by` or `Signed-off-by` lines
- If build/lint fails — stop and report, do not skip verification
- If `ts-prune` reports dead code — stop and report, treat as build failure
- If review finds issues — stop and report, do not auto-fix and commit
- If the PR revives deleted v4 patterns (BaseStage, unused stubs, `switch (action)`) — stop and escalate
