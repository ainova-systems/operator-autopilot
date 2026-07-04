---
path: "packages/**"
---

# Shared Packages Developer Context

Two workspaces with a strict, ESLint-enforced dependency direction. Full rules:
`intelligence/rules/typescript.md` (§Architecture — Package Boundaries).

## `@operator/core` (`packages/core/src/**`)
The contract every other workspace depends on.
- Exports types, interfaces, Zod schemas, and error classes. Permitted runtime: schema values and error class constructors; `types/` and `interfaces/` are type-only.
- Imports only `zod` at runtime (type-only from Node built-ins is fine). NEVER imports `@operator/adapters`, `@operator/engine`, or `@operator/app`.
- Platform-neutral vocabulary only: `CodeReview`, `WorkItem`. `PullRequest` / `Issue` / `MergeRequest` are forbidden here (they belong in `engine/platforms/github/**`).
- Interfaces are PascalCase with no `I` prefix (`VCSPlatform`, not `IVCSPlatform`). Every error carries a `code: string`.
- `WorkItem.kind` is `string` backed by the KV kind registry — do NOT reintroduce a closed `"finding" | "task" | ...` union.

## `@operator/adapters` (`packages/adapters/src/**`)
Concrete implementations of core interfaces (SQLite KVStore, kind-registry, VCS, …).
- Imports `@operator/core` + approved npm runtime deps (`better-sqlite3`, `@octokit/rest`, `js-yaml`, `zod`, …). NEVER imports `@operator/engine` or `@operator/app`.
- Validate external/boundary data with Zod; internal code trusts validated data.
- Octokit list calls always `.paginate()`. SQLite uses WAL mode — never hold a write transaction open across an async boundary.
- Pin native bindings (`better-sqlite3`) to exact versions; `^` is fine for pure-JS deps.

## Shared conventions
- Named exports only (`import type` for type-only imports); kebab-case filenames; colocated `*.test.ts` per implementation file.
- `>=90%` coverage on touched files. Prefer fake implementations (`TestKVStore`, `TestVCSPlatform`) over `vi.fn()`; use real temp dirs (`fs.mkdtemp`) for filesystem tests, never mock `fs`.
- New runtime dependencies must come from trusted publishers and pass `npm audit` clean — see `intelligence/rules/typescript.md` §Dependency Security.

## Verify
`npm run typecheck && npm run lint && npm test` from the repo root (workspace-aware).
