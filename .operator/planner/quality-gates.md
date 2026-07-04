---
path: "*"
---

# Planning Quality Gates

Rules for validating findings and generating tasks in this repository.

- **Every task plan includes a regression-test step.** A plan that fixes
  behavior without naming the test that pins it is incomplete — the test must
  fail on pre-fix code and its name must describe the bug scenario
  (`intelligence/rules/typescript.md`).
- **Single-PR revertibility.** Each task must be independently revertible in
  one commit; never bundle a migration with an irreversible cleanup. Split
  expand-contract changes into separate tasks.
- **Observability is part of the change.** Tasks touching `engine/pipeline/**`
  or any I/O path must state which INFO/WARN/ERROR lines the change adds or
  preserves — a plan that removes visibility is defective.
- **Plans respect the primitives boundary.** Any plan step that would call
  `git.*` / `PRManager.*` / `VCSPlatform.*` / `AgentRuntime.run` or write KV
  outside `engine/pipeline/primitives/**` is invalid; route through existing
  primitives or extend one.
- **Scope honesty.** If a finding's real fix exceeds ~800 changed lines,
  split it into ordered tasks with explicit hand-off notes instead of one
  oversized task.
- **Reject non-actionable findings** back with reason: no concrete file:line
  evidence, stylistic preference without a rule source, or duplicate of an
  open item.
