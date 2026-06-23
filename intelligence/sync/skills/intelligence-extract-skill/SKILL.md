---
name: intelligence-extract-skill
description: "Extract observed workflow into a reusable skill"
argument-hint: "<skill-name-hint> [target: skill|rule|agent]"
---

# Extract Skill

Use when a workflow that ran during this session should become a reusable artifact — same sequence will be needed again by this user or by someone else using shared intelligence. Starts from observed session behavior instead of design-from-scratch.

## When to use this vs `intelligence-add-skill`

- `intelligence-add-skill` — design from scratch / from codebase analysis
- `intelligence-extract-skill` — extract from the conversation that just happened

Both end at the same artifact format. Extract starts from observed behavior, so the steps already exist as real working procedure.

## Steps

1. **Identify the pattern from session**: list the concrete steps the assistant or user-and-assistant performed during the conversation. Include user decisions at each branch and assistant actions.

2. **Generalize**: strip session-specific details (file names, dates, specific phrasing), keep the repeatable structure. The artifact should work for the next instance of this task type, not just the one that ran.

3. **Determine artifact type**:
   - Multi-step workflow with concrete steps → **skill**
   - Behavioral preference / constraint / pattern to default to → **rule** (use `intelligence-learn-from-context` for single preferences from session)
   - Knowledge area / persona / expertise scope → **agent**

4. **Determine domain prefix** (for skill / agent): reuse the existing domain when one fits — list `intelligence/skills/` and `intelligence/agents/`. Derive from repo structure only when no existing domain matches.

5. **Determine naming** (for skill): `<domain>-<verb>-<noun>` with convention verbs — `add-` (atomic create), `create-` (orchestrator), `update-` (modify), `run-` (execute), `review-` (read-only analysis).

6. **Check for matching agent**: if creating a skill and an agent already covers the domain, link via `agent:` frontmatter. If no matching agent and one is warranted, call `intelligence-add-agent` first.

7. **Write the artifact** by delegating to the relevant `intelligence-add-*` skill (`intelligence-add-skill` / `intelligence-add-rule` / `intelligence-add-agent`). The add-* skills carry the authoring conventions — no need to duplicate them here.

8. **Run sync**: `/intelligence-sync` to distribute to all enabled IDE targets.

## Authoring guidance

Follow the **Authoring Discipline** section in `docs/CONVENTIONS.md` when writing the artifact body — size budgets (<500 lines for SKILL.md body), imperative form, explain WHY, reserve absolute language for true invariants, lead with positive defaults.

## Related skills

- `intelligence-add-skill` — design new skill from scratch
- `intelligence-learn-from-context` — capture a behavioral preference from session (often → rule update)
- `intelligence-review-skills` — audit existing artifacts for duplication, staleness, discipline issues
