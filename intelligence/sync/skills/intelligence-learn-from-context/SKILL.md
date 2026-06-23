---
name: intelligence-learn-from-context
description: "Capture session lessons and apply to intelligence/ after approval"
argument-hint: <optional-lesson-statement>
---

# Learn from Context

Use after a session where a meaningful preference, working pattern, or recurring friction emerged that should persist into future sessions. Runs in two phases — analyze (read-only) then apply (after user approval).

## Principle: positive framing

LLMs follow whatever is named. Negation ("never do X") often draws attention to X. Positive framing ("default to Y", "prefer Y") steers behavior more cleanly.

This skill translates user-stated lessons before encoding:
- "Don't use NOT-comparison structures" → "State positively what IS"
- "Stop generating 3 options" → "Default to one strong recommendation"
- "Never push toward architecture framing" → "Reflect the user's framing in their own words first"

The original negative pattern stays in the rule body as an illustrative example (paired with positive replacement), but the LLM-facing instruction is positive.

## Phase A — Analyze (read-only)

1. **Read authoring conventions first**: load `intelligence/skills/intelligence-add-rule/SKILL.md`, `intelligence-add-skill/SKILL.md`, `intelligence-add-agent/SKILL.md`, and `docs/CONVENTIONS.md` (Authoring Discipline section). This skill writes nothing on its own — it delegates to the add-* skills, which carry authoring conventions.

2. **Capture the lesson** from session context or user input. Strip session-specific detail, keep the underlying pattern.

3. **Translate to positive form**:
   - "Never do X" → "Default to Y"
   - "Stop doing Y" → "Do Z instead"
   - Already-positive lessons keep as-is.
   Confirm the translation with the user if removing the negation changes meaning.

4. **Route to the right artifact type**:
   - Behavioral preference, tone, communication style → **rule** (`intelligence/rules/<NNN-name>.md`)
   - Multi-step repeatable workflow → use `intelligence-extract-skill` instead
   - Knowledge scope / persona / expertise area → **agent**
   - Project-specific context tied to a path → scoped rule with `paths:` frontmatter

5. **Check for an existing artifact to extend**: list the target directory and read titles. When the lesson fits an existing artifact's scope, propose `UPDATE` rather than `CREATE`. Artifact proliferation costs context space.

6. **Output the proposal list** — one entry per change, each with:
   - Action: `CREATE` / `UPDATE` / `ARCHIVE`
   - Target file path
   - Brief draft of the change (positive framing applied)
   - One-line reasoning

   **No files are written in this phase.**

## User approval gate

Present the proposal list to the user. User accepts or rejects per item. Only accepted items move to Phase B.

## Phase B — Apply (after approval)

7. For each accepted item, delegate to the appropriate add-* skill or edit directly:
   - `CREATE` rule → call `intelligence-add-rule`
   - `CREATE` skill → call `intelligence-add-skill`
   - `CREATE` agent → call `intelligence-add-agent`
   - `UPDATE` existing artifact → edit the file directly, applying the proposed change
   - `ARCHIVE` → move to `intelligence/_archive/` and update cross-references that point at it

8. **Run `/intelligence-sync`** once all accepted items are applied.

## Related skills

- `intelligence-extract-skill` — when the lesson is a multi-step workflow to be made reusable
- `intelligence-review-skills` — broader audit across existing intelligence/ artifacts
- `intelligence-add-rule`, `intelligence-add-skill`, `intelligence-add-agent` — atomic creators that Phase B delegates to
