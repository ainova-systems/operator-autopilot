---
path: "engine/**"
---

# Engine Review Rules

Path-scoped PR-review checks for `engine/**`. Full rules:
`intelligence/rules/typescript.md`, `intelligence/rules/context.md`.

- **Primitives boundary:** any `git.*` / `WorkspaceGit`, `PRManager.*`, `VCSPlatform.*`, `AgentRuntime.run`, or KV write outside `engine/pipeline/primitives/**` is a blocker.
- **Layer graph:** reject upward/sideways imports (e.g. `platforms/` importing `agents/`, `storage/` importing `pipeline/`).
- **Branch safety:** no push or PR head against `master`/`main`/`develop`; no force-push flag; branch decisions only inside `WorkspaceScope`.
- **Terminal items:** every selector filters out items whose status is terminal for their kind — no "retry next cycle" path.
- **Stages are config:** reject new files under `engine/pipeline/stages/`; behaviour changes belong in `engine/content/prompts/stages.yaml` + prompt files.
- **Observability:** every externally visible action and decision has an INFO line (PR#, SHA, branch, verdict, duration where relevant); every catch-and-continue WARNs; error logs include `.cause`.
- **`OperationContext`** threaded through every new/changed I/O function.
- **Line caps:** `engine/pipeline/**` <= 200, elsewhere <= 300 (logging/comments excluded); a file over cap means a primitive is leaking.
- **Tests:** colocated `*.test.ts` present; bug fixes carry a failing-first regression test named for the bug scenario; touched files >=90% coverage (primitives >=95%).
- **Hygiene:** named exports only, no `any`/`@ts-ignore`, no default exports, Octokit `.paginate()` on list calls, agent-output parsing wrapped in typed `AgentError`.
