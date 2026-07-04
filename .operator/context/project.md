---
path: "*"
---

# Operator (operator-autopilot) Project Strategy

## Project Vision
Operator is a closed-loop SDLC engine that autonomously discovers issues, plans
fixes, implements code, verifies, delivers, observes, and learns. Its guiding
principle is **orchestrator, not agent**: it schedules work and invokes external
agent CLIs through a single generic `runStage` loop plus a small set of primitives —
it never reimplements tool execution. The v5 rebuild collapsed all pipeline work
into `runStage` + ~10 primitives, moved state into a pluggable KV model, and ships
an observability UI (`@operator/app`) from day one.

## Repository Shape
npm-workspaces monorepo, TypeScript throughout, Node.js >= 24.
- `engine/**` — the daemon (flat, no `src/`); composition root is `engine/entry.ts`.
- `packages/core/**` — `@operator/core`: shared types, interfaces, Zod schemas, error classes. Zero runtime deps.
- `packages/adapters/**` — `@operator/adapters`: concrete KVStore / kind-registry / VCS implementations.
- `app/**` — `@operator/app`: Next.js 15 + React 19 observability + config-edit UI (read-only KV access).
- `config/` — instance config (`repos.yaml`, seed-mirror source). `docs/` — canonical docs. `intelligence/` — AI prompt framework.

Authoritative rules live in `intelligence/rules/` (synced to `AGENTS.md`/`.claude`/`.cursor`).
Do not restate them here — reference them:
- `intelligence/rules/context.md` — global product + architecture rules.
- `intelligence/rules/typescript.md` — engine/package TypeScript rules (path-scoped).
- `intelligence/rules/source-language-english.md` — English-only source language.
- `intelligence/rules/test-project-names.md` — no real customer/sandbox names outside `config/repos.yaml`.
- `docs/workflow.md`, `docs/vision.md`, `docs/architecture-v5.md` — behaviour + target shape.

## Architectural Principles
### Engine + packages (TypeScript, strict)
- Package boundaries (enforced by ESLint `no-restricted-imports`): `core` imports nothing runtime; `adapters` imports only `core`; `engine` imports `core` + `adapters`; `app` imports `core` types + `adapters` read-only, never `engine` runtime. No upward/cross-package imports.
- Layer graph inside `engine/`: strictly downward (see `intelligence/rules/typescript.md`). `platforms/` never imports `agents/`, `storage/` never imports `pipeline/`, etc.
- Primitives boundary: only `engine/pipeline/primitives/**` may call `git.*`, `PRManager.*`, `VCSPlatform.*`, `AgentRuntime.run`, or write KV. Stages compose primitives; they never reach past the boundary.
- `runStage` is generic: new stage behaviour is config in `engine/content/prompts/stages.yaml` + a prompt file, NOT a new file under `pipeline/stages/`.

**DO NOT** (see `intelligence/rules/typescript.md` for the full list):
- Leave dead code — every export must be reachable from `entry.ts` closure or a colocated test (`ts-prune` + `knip` are CI gates).
- Use default exports, `any`, `@ts-ignore`, or `as any` casts.
- Call `git.*` / `PRManager.*` / `VCSPlatform.*` / `AgentRuntime.run` / write KV outside `engine/pipeline/primitives/**`.
- Push or open PRs against `master` / `main` / `develop`, or force-push in any form (fast-forward only; `WorkspaceScope` owns branching).
- Use platform vocabulary (`PullRequest`, `Issue`, `MergeRequest`) outside `engine/platforms/github/**` — core speaks `CodeReview` / `WorkItem`.
- Re-select a work item whose authoring PR closed terminal (rejected/cancelled/duplicate). Recovery is human-only.
- Exceed line caps: 200 lines in `engine/pipeline/**`, 300 elsewhere (logging/comments excluded).

**DO:**
- Thread `OperationContext` (`traceId`, `repoId`, `action`, `budget`, `signal`) through every I/O function.
- Log every externally visible action and decision at INFO (observability is the reason v5 exists).
- Ship a colocated `*.test.ts` for every implementation file; every bug fix gets a failing-first regression test.
- Validate external input with Zod at boundaries; use typed errors (each carries a `code`).
- Keep all source, comments, identifiers, and commit messages in English; use generic placeholders (`sample`, `owner/<repo-id>`) instead of real project names.
- Commit messages: one line, capital first letter, past tense, no prefixes, no `Co-authored-by`/`Signed-off-by`.

## Technical Debt Priorities
### P1 - Fix Immediately
- Any boundary/layer violation (cross-package or cross-layer import, primitive call outside `pipeline/primitives/**`).
- Dead code flagged by `ts-prune` / `knip`; default exports; `any` / `@ts-ignore`.
- Any push or PR head targeting `master`/`main`/`develop`, or a force-push flag.
- Missing `OperationContext` on an I/O function; a code path that succeeds with zero log lines.

### P2 - Fix This Sprint
- Files over the line cap (a leaking primitive in `engine/pipeline/**`).
- Missing colocated test or a bug fix without a regression test.
- Coverage on a touched file below 90% (below 95% for `engine/pipeline/primitives/**`).
- Non-`import type` type-only imports; platform vocabulary leaking into core.

### P3 - Scheduled Cleanup
- CRLF line endings on `.ts`/`.md`/`.yaml`/`.yml`/`.sh`.
- Stale doc/rule drift from code (fix docs in the same change per context-engineering).
- Real project names leaking into fixtures/comments outside `config/repos.yaml`.

## Areas of Focus
### High Priority Areas
- `engine/pipeline/**` — `run-stage.ts` + `primitives/**` + `stage-logic/**`: the correctness- and safety-critical core.
- `engine/platforms/github/**` — the only place VCS/PR vocabulary and Octokit pagination live.
- `packages/core/**` — the contract everything depends on; changes ripple across all workspaces.

### Lower Priority Areas
- `app/src/components/**` and Next.js route files — tested via the dev server, excluded from vitest coverage.
- `engine/content/**` — bundled prompt/template/defaults assets (data, not runtime code).
