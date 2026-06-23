---
stage: finding
description: Review criteria for finding execution (planner) output
---

# Finding Execution Review Criteria

Verify the planner agent produced a valid verdict and actionable tasks.

## Checks

1. **Verdict justified**: The `## Verdict: VALID` or `## Verdict: INVALID` must be clearly stated and supported by analysis.
2. **Tasks actionable**: If VALID, each created task must be specific, implementable, and properly scoped to a single unit of work.
3. **Task files exist**: Every task ID referenced in agent output must have a corresponding `.md` file on disk.
4. **Task frontmatter**: Each task file must have: `title` (non-empty), `priority` (1-8), `status: pending`, `parent_id` linking back to the finding (e.g. `parent_id: "F20260427-0001"`).
5. **No scope creep**: Tasks must address only what the finding describes, nothing beyond.
6. **Reasonable sizing**: Each task should be completable in a single PR — split large tasks.

## Required Output Sections

Include BOTH sections — the orchestrator archives the summary as the
finding's `kv:executions/{id}.summary` and surfaces it in the UI timeline.

```
## Verdict: <VALID|INVALID|RETRY|FAILED|CANCELLED|REJECTED>
<justification>

## Execution Summary
<what the planner concluded, how many tasks were produced, any caveats>
```
