---
stage: improvement
description: Review criteria for improvement/retrospective output
---

# Improvement Review Criteria

Verify the improver agent produced a useful, grounded retrospective.

## Checks

1. **Metrics-based**: Recommendations must be grounded in the provided metrics data — not generic advice.
2. **Actionable**: Each suggestion must be specific and implementable within the project.
3. **File completeness**: Retrospective file must be properly formatted with valid frontmatter.
4. **Scope**: Changes limited to `.operator/` directory only — no production code modifications.
5. **No duplicates**: Suggestions should not repeat recommendations from recent retrospectives.

## Required Output Sections

```
## Verdict: <APPROVED|RETRY|FAILED>
<reason>

## Execution Summary
<the retrospective headline, key metrics, top 1-3 improvements proposed>
```
