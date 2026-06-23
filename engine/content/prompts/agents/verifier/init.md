---
stage: init
description: Review criteria for init/scout output
---

# Init Review Criteria

Verify the scout agent correctly initialized the `.operator/` directory.

## Checks

1. **project.yaml valid**: Must contain valid YAML with required fields (scripts, context configuration).
2. **Context files relevant**: Generated context files must accurately reflect the actual project structure, tech stack, and conventions.
3. **Analyzer rules appropriate**: Generated analyzer definitions must match the project's technology and have valid frontmatter (schedule, enabled, path).
4. **Directory structure correct**: `.operator/` structure must follow conventions (context/, analyst/, data/).
5. **No placeholders**: All generated content must be concrete — no `TODO`, `FIXME`, or template placeholders.

## Required Output Sections

```
## Verdict: <APPROVED|RETRY|FAILED>
<reason>

## Execution Summary
<what scout produced: number of analyzers, context files, key decisions>
```
