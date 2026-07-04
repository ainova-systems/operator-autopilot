---
path: "packages/**"
---

# Shared Packages Review Rules

Path-scoped review checks for `packages/**`. Full rules:
`intelligence/rules/typescript.md` (§Architecture — Package Boundaries).

- **`@operator/core`:** exports only types/interfaces/error classes (no other runtime); imports nothing runtime; never imports `adapters`/`engine`/`app`. Platform vocabulary (`PullRequest`/`Issue`/`MergeRequest`) is a blocker here — use `CodeReview`/`WorkItem`.
- **`@operator/adapters`:** imports only `core` + approved runtime deps; never imports `engine`/`app`. Boundary data validated with Zod; Octokit `.paginate()`; no write transaction held across an async boundary.
- **Contracts:** every error carries a `code`; interfaces PascalCase without `I` prefix; `WorkItem.kind` stays `string` (no closed union).
- **Dependencies:** new deps come from trusted publishers, pass `npm audit`, and pin native bindings to exact versions.
- **Tests:** colocated `*.test.ts`; prefer fake implementations over `vi.fn()`; real temp dirs for filesystem tests; >=90% coverage on touched files.
