---
stage: research
description: Review criteria for research/analyst output
---

# Research Review Criteria

Verify the analyst agent produced complete, valid research output.

## Checks

1. **File completeness**: Every finding ID referenced in agent output MUST have a corresponding `.md` file on disk. Count files vs references — they must match.
2. **Frontmatter validity**: Each finding file must have: `title` (non-empty string), `priority` (integer 1-8), `status: pending`.
3. **Content quality**: Finding body must describe a concrete, actionable issue with evidence — not vague observations or generic advice.
4. **No duplicates**: Finding must not duplicate an existing finding already present in the findings directory.
5. **Correct IDs**: Finding IDs must follow `F{YYYYMMDD}-{NNNN}` format with sequential numbering.
6. **Scope**: Findings must be relevant to the analyzer's scope and the target repository.

## Required Output Sections

```
## Verdict: <APPROVED|RETRY|FAILED>
<reason>

## Execution Summary
<how many findings across which analyzers; notable patterns or gaps>
```
