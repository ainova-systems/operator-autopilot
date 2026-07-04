---
path: "engine/**"
---

# Engine Task-Execution Rules

Path-scoped guidance for implementing changes in `engine/**`. Full rules:
`intelligence/rules/typescript.md`; behaviour contract: `docs/workflow.md`.

- Compose existing primitives; do NOT call `git.*` / `PRManager.*` / `VCSPlatform.*` / `AgentRuntime.run` / write KV outside `engine/pipeline/primitives/**`.
- Add stage behaviour as config (`engine/content/prompts/stages.yaml` + a prompt file), not a new `pipeline/stages/` file; extend `StageDef` if `runStage` can't express it.
- Thread `OperationContext` through every I/O function and log every action/decision (INFO), payloads (DEBUG), catch-and-continue (WARN), failures with `.cause` (ERROR).
- Never target `master`/`main`/`develop`; never force-push; let `WorkspaceScope` own branch creation and reset workspaces in `finally`.
- Ship a colocated `*.test.ts` with the change; for a bug fix add a regression test that fails on the pre-fix code and names the bug scenario. Keep touched files >=90% coverage (primitives >=95%).
- Named exports, `import type` for types, no `any`/`@ts-ignore`; kebab-case filenames; respect line caps (200 in `pipeline/**`, 300 elsewhere — split rather than trim logs).
- English-only source; generic placeholders instead of real project names.
- Run the gate before finishing: `npm run typecheck && npm run lint && npm test`.
