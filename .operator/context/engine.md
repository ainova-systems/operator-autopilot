---
path: "engine/**"
---

# Engine Developer Context

The daemon. Flat layout under `engine/` (no `src/`). Composition root is
`engine/entry.ts` — the ONLY file that instantiates cross-layer classes with `new`.
Everything else receives dependencies through its constructor.

Full rules: `intelligence/rules/typescript.md` and `intelligence/rules/context.md`.
Target shape / behaviour: `docs/architecture-v5.md`, `docs/workflow.md`.

## Layer graph (imports flow strictly downward)
```
entry.ts    → daemon/, engine/, storage/, pipeline/, config/, logging/, @operator/adapters
daemon/     → engine/, logging/
engine/     → pipeline/, config/, logging/, @operator/core
pipeline/run-stage.ts → pipeline/primitives/*, @operator/core, @operator/adapters (via primitives)
pipeline/primitives/  → agents/, platforms/, storage/, infra/, @operator/core
agents/     → platforms/, events/, infra/, @operator/core
platforms/  → infra/, logging/, @operator/core
storage/    → @operator/core, @operator/adapters
infra/      → Node built-ins only
logging/    → nothing
```
`platforms/` must NOT import `agents/`; `storage/` must NOT import `pipeline/`; etc.

## Primitives boundary (hard line)
`engine/pipeline/primitives/**` is the ONLY place that may call `git.*` /
`WorkspaceGit`, `PRManager.*`, `VCSPlatform.*`, `AgentRuntime.run`, or write to
`KVStore` from a stage path. One file per primitive (`workspace-scope.ts`,
`item-selector.ts`, `agent-invocation.ts`, `persist-output.ts`, `route-verdict.ts`,
`recovery-journal.ts`), each with a colocated test at >=95% coverage, each <=200 lines.
`run-stage.ts` composes primitives only (~150 lines) — no stage-specific logic.

## Stages are config, not code
There is no `engine/pipeline/stages/` directory. New stage behaviour = edit
`engine/content/prompts/stages.yaml` + the relevant prompt under
`engine/content/prompts/agents/`. If `runStage` cannot express it, extend `StageDef`
config — do NOT add a stage file.

## Non-negotiables specific to the engine
- `WorkspaceScope` is the only place that decides "create branch vs checkout existing" (2026-04-13 non-fast-forward incident). Fast-forward pushes only; never `--force` / `--force-with-lease` / `+refspec`.
- Never push or open a PR head against `master`/`main`/`develop`. Operator authors only `ai/<kind>/<id>` branches.
- Terminal work items (PR closed/rejected/cancelled/duplicate) are never re-selected — every selector has an explicit terminal-skip keyed on `kindRegistry.terminalStatusesFor(kind)`.
- Octokit list calls always `.paginate()`. Agent output parsing always wrapped in try/catch with a typed `AgentError`.
- Resolve YAML/content paths via `resolveContentPath` (`engine/infra/content-path.ts`) relative to bundled content, never `process.cwd()`.

## Observability (REQUIRED — the reason v5 exists)
Every I/O function takes `OperationContext` and logs: INFO for every important
action + decision with its reason (PR number, SHA, branch, verdict, duration);
DEBUG for data payloads; WARN on every catch-and-continue with the reason; ERROR
with full `.cause`. Silent success is a bug — add at least one INFO summary at exit.

## Line caps & tests
`engine/pipeline/**` <= 200 lines; elsewhere <= 300 (logging/comments/JSDoc excluded —
split, don't strip logs). Colocated `*.test.ts` for every file; >=90% coverage on
touched files (>=95% for primitives). Every bug fix ships a regression test that fails
on the pre-fix code and names the bug scenario.

## Verify
`npm run typecheck && npm run lint && npm test` (from repo root). `lint` includes
`ts-prune` + `knip` — dead code is a CI-blocking failure.
