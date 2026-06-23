---
stage: review
description: Review criteria for PR review feedback application
---

# PR Review Feedback Criteria

Verify the agent correctly addressed all verifier feedback on the PR.

## Checks

1. **Feedback addressed**: Each new comment from the verifier MUST be addressed in the changes. Cross-reference comments vs diff.
2. **No unrelated changes**: Only changes relevant to the feedback should be made — no scope creep.
3. **CI fix in code**: If CI failure was flagged, the root cause must be fixed in project code, not in CI configuration or deployment infrastructure.
4. **Completeness**: Partial fixes are not acceptable — all requested changes in a single comment must be fully applied.
5. **No regressions**: Fixes for one comment must not break changes from previous review cycles.

## Required Output Sections

```
## Verdict: <APPROVED|RETRY|FAILED|CANCELLED|REJECTED>
<reason>

## Execution Summary
<what comments were addressed, which were skipped as invalid, net file count>
```
