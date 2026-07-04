---
path: "*"
schedule: daily
---

# Code Quality Rules

Detection rules for the TypeScript monorepo. Authoritative source:
`intelligence/rules/typescript.md` (§FORBIDDEN / §REQUIRED) and
`intelligence/rules/context.md` (§Global Rules). Report findings with priority and
the exact `file:line`; do not restate the rule bodies — reference them.

## Detection Rules
### TypeScript (engine/, packages/, app/)
**FORBIDDEN (P1) — blockers:**
- Dead code: an exported symbol unreachable from `engine/entry.ts` closure or a colocated test (also flagged by `ts-prune` / `knip`).
- `any`, `@ts-ignore`, or `as any` casts; default exports.
- `git.*` / `WorkspaceGit`, `PRManager.*`, `VCSPlatform.*`, `AgentRuntime.run`, or KV writes OUTSIDE `engine/pipeline/primitives/**`.
- Cross-package upward import (`core`→`adapters`/`engine`, `adapters`→`engine`, `app`→`engine` runtime) or cross-layer upward import inside `engine/` (see the layer graph).
- Any push / PR head against `master`/`main`/`develop`; any force-push flag (`--force`, `--force-with-lease`, `+refspec`).
- A selector path that can return a work item whose status is terminal for its kind.
- An I/O function (state/git/VCS/filesystem) that does not take `OperationContext`.

**FORBIDDEN (P2):**
- Files over the line cap: >200 lines in `engine/pipeline/**`, >300 elsewhere (excluding logging/comments/JSDoc) — usually a leaking primitive.
- Implementation file without a colocated `*.test.ts`, or a bug fix without a failing-first regression test.
- Runtime code in `types/` / `packages/core/src/types/` (only interfaces, type aliases, and error-class constructors allowed).
- Platform vocabulary (`PullRequest`, `Issue`, `MergeRequest`) outside `engine/platforms/github/**`.

**DEPRECATED (P4-P5):**
- New files under `engine/pipeline/stages/` (stages are config in `engine/content/prompts/stages.yaml`, not code).
- Closed `WorkItemType` unions (`"finding" | "task" | ...`) — `kind` is `string` via the KV kind registry.
- A `switch (action)` block growing in `entry.ts` (target state has none).

## Observability checks
- Any externally visible action (push, comment, label flip, commit) without a matching INFO log line.
- A catch-and-continue branch with no WARN; an error log missing `.cause`; a successful code path with zero log lines.

## Build Commands
```
npm ci                                         # install (Node >= 24)
npm run typecheck                              # tsc --noEmit across workspaces
npm run lint                                   # eslint + ts-prune + knip (dead-code gates)
npm test                                       # vitest run --coverage (>=90%; primitives >=95%)
```
