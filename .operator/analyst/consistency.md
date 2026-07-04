---
path: "*"
schedule: weekly
---

# Consistency Rules

Cross-stack consistency checks for the monorepo. Reference, do not restate:
`intelligence/rules/typescript.md`, `intelligence/rules/source-language-english.md`,
`intelligence/rules/context.md`, and `intelligence/rules/dev-context-engineering.md`.

## Package & layer boundaries
- Import direction holds everywhere: `core` (nothing runtime) ← `adapters` ← `engine`; `app` uses `core` types + `adapters` read-only, never `engine` runtime.
- Inside `engine/`, imports flow strictly downward per the layer graph (`platforms/` ⇏ `agents/`, `storage/` ⇏ `pipeline/`, `infra/` → Node built-ins only).
- Primitive-boundary calls (`git.*`, `PRManager.*`, `VCSPlatform.*`, `AgentRuntime.run`, KV writes) appear only in `engine/pipeline/primitives/**`.

## Vocabulary & language
- Core/shared layers use `CodeReview` / `WorkItem`; platform terms confined to `engine/platforms/github/**`.
- Source language is English everywhere the codebase emits or carries text — CLI/log output, comments, JSDoc, identifiers, KV keys, env-var names, commit messages, docs. Flag any non-English word (Unicode symbols like `—` `·` `…` `✓` are allowed).
- No real project names outside `config/repos.yaml`; fixtures use generic placeholders (`sample`, `owner/<repo-id>`, `Source/Backend/Sample/`).

## Style & structure
- Filenames kebab-case; interfaces PascalCase without an `I` prefix; classes PascalCase; functions camelCase; named exports only (`import type` for type-only imports).
- Every implementation file has a colocated `*.test.ts` (exceptions: `entry.ts`, `types/`, Next.js pages). No orphan implementation files, no orphan tests.
- LF line endings on `.ts` / `.md` / `.yaml` / `.yml` / `.sh` / `.bats`.
- Semicolons, double quotes; line caps observed (200 in `engine/pipeline/**`, 300 elsewhere).

## Docs ↔ code drift
- A convention change must update its single source-of-truth rule in the same change; docs that drift from code are defects (`intelligence/rules/dev-context-engineering.md`). One source per convention; everything else references it.

## Command tooling
```
npm run lint                # eslint (naming, boundaries) + ts-prune + knip
git ls-files -z '*.ts' '*.md' '*.yaml' | xargs -0 grep -lP '\r$'   # CRLF offenders
```
