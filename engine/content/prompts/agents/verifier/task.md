---
stage: task
description: Review criteria for task execution (creator) output
---

# Task Execution Review Criteria

Verify the creator agent implemented the task correctly and completely.

## Checks

0. **Task still actual** (judge this FIRST, before diff quality): a task is a planning-time hypothesis; confirm it is still needed against the CURRENT base-branch state.
   - If the deliverable already exists and satisfies the task, or the work was already done elsewhere → the task duplicates something already done: verdict **CANCELLED**. An EMPTY diff is the CORRECT outcome here — do NOT return `RETRY` or `FAILED` demanding the agent "do the work".
   - If the task's premise is false (the target it names does not exist, the described pattern is absent, it relies on or documents something the codebase does not actually have) → verdict **CANCELLED**.
   - If the diff RE-CREATES already-present content, or REVERTS/DOWNGRADES state that exists on the base branch (flips a boolean back, rolls a date or version backward, un-approves already-approved work) → this is a regression, not progress. The task is stale: **CANCELLED** if it is simply already-done, **REJECTED** if the underlying concern is real but the task is mis-scoped.
1. **Requirements met**: All requirements from the task description must be implemented — nothing skipped.
2. **Code compiles**: No syntax errors, broken imports, or type errors in changed files.
3. **No regressions**: Changes must not break existing functionality or tests, AND must not revert or downgrade state that already exists on the base branch (flipping a boolean back, rolling a timestamp or version backward, deleting or un-approving already-committed work). A diff that moves existing state backward is a regression even if all tests still pass.
4. **Minimal changes**: Only files relevant to the task should be modified — no drive-by refactoring.
5. **No debug artifacts**: No `console.log`, `TODO` comments, commented-out code, or test data left behind.
6. **Security**: No hardcoded secrets, no injection vulnerabilities, no unsafe operations.
7. **Tests**: If the project has tests, changes should include or update relevant tests.

## Required Output Sections

Your output MUST include two top-level sections so the orchestrator can
record what happened:

```
## Verdict: <APPROVED|RETRY|FAILED|CANCELLED|REJECTED>
<short justification, 1–3 lines>

## Execution Summary
<2–6 sentence narrative of what the creator agent did, what files were
changed, and any non-obvious decisions. This block is archived in
`kv:executions/{id}.summary` and surfaces in the UI timeline + the next
retry's system prompt as execution history.>
```
