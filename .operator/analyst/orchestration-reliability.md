---
path: "engine/**"
schedule: daily
---

# Orchestration Reliability Rules

The operator is an orchestrator for LLM-driven work: its core quality attribute is
that no work item is ever lost, stuck, duplicated, or silently mutated. Every rule
here comes from a real incident class fixed in this repository's history. Verify
against actual code paths (`engine/pipeline/**`, `engine/work-items/**`,
`engine/engine/**`) — never report from doc reading alone.

## Work-item lifecycle integrity (P1-P2)

- **A status source that can latch stale state.** Any code that derives work-item
  status from an external signal (PR label, PR state, directory, file location)
  must honor that signal ONLY while its carrier is live — e.g. a label on a
  closed PR must not keep overriding the item's terminal status. Look for
  reconciliation joins in `syncFromFiles` / status observation that read a signal
  without checking its liveness window.
- **A path where an agent-produced work item can be dropped without a log line.**
  Every EMIT child-item that fails validation, loses its parent, or misses a
  required field must surface as WARN/ERROR + execution-log entry — never a
  silent `continue`.
- **Terminal-status bypass.** Any selector, reconciler, or recovery path that can
  hand a terminal item (rejected / cancelled / duplicate / merged) back to a
  stage. The terminal-skip must be keyed on `kindRegistry.terminalStatusesFor(kind)`,
  not on a hardcoded status list.
- **One-way status transitions violated.** A non-terminal write that overwrites a
  terminal KV status (KV terminal must win over stale file/branch state).

## Stuck-state and self-healing (P1-P2)

- **Unbounded stuck states.** Every in-flight marker (lock, `in-progress` status,
  processing label, recovery-queue row) needs a bounded TTL / expiry with an
  explicit WARN when reaped. An orphan reconciler must cover EVERY kind that can
  get stuck — a reaper that handles one kind but not another is a defect.
- **Silent auto-clear.** Self-healing that resets state without logging what was
  lost and why is forbidden — bounded recovery must be observable (see
  `intelligence/rules/` no-silent-error-recovery discipline).
- **Lock skips polluting schedules.** A skip caused by a held lock must not count
  against retry/backoff budgets — only real failures do.

## Silent data loss on agent paths (P1)

- **Agent output not persisted.** Every agent invocation's raw output must reach
  the execution history sink, including failed/rejected attempts.
- **Agent-authored commits not pushed.** Any post-agent flow must detect commits
  the agent itself created and include them in the push — a fix applied by an
  agent that never reaches the PR is data loss.
- **Fresh feedback overwritten.** A bot reply that marks comments as answered
  must enumerate exactly the comment ids it actually addressed, never "all".

## Scheduling and budget correctness (P2)

- **Backoff counters mixed across causes** (lock-skip vs real failure vs empty
  result) — each cause needs its own counter semantics.
- **CI-state machine gaps**: a PR whose head has zero check runs, only skipped
  checks, or only third-party checks must classify deterministically (absent →
  reviewable), not hang in a pending-forever state.
- **Retry budgets that never reset** on new head SHA / new input, or reset when
  they must not (agent declines to fix — budget must persist).

## Reporting rules

- Cite the exact file:line of the risky path and the incident class it matches.
- One finding per root cause; list all affected call sites inside that finding.
- Acceptance criteria MUST include a failing-first regression test that pins the
  contract (see `intelligence/rules/typescript.md` — every bug fix ships one).
