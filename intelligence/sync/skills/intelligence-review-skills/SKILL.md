---
name: intelligence-review-skills
description: "Audit intelligence/ for duplicates, stale, size, and discipline issues"
argument-hint: "[target: rules|skills|agents|all]"
---

# Review Skills

Read-only audit of `intelligence/rules/`, `intelligence/agents/`, `intelligence/skills/`. Detects issues, proposes actions, hands accepted actions to `intelligence-learn-from-context` Phase B for application.

Name reflects the umbrella usage of "skills" for all AI artifacts (rules + skills + agents).

## Steps

1. **Read conventions first**: load `docs/CONVENTIONS.md` Authoring Discipline section — size budgets, description discipline, writing principles. The detection checks below reference these standards.

2. **Enumerate artifacts**: list every file under `intelligence/rules/`, `intelligence/agents/`, `intelligence/skills/` (recursive — each skill is its own directory).

3. **Pull git history** (when available): for each artifact, capture:
   - Last edit date: `git log -1 --format='%ai' <file>`
   - Total edit count: `git log --oneline <file> | wc -l`
   - First-add date: `git log --follow --format='%ai' <file> | tail -1`
   Stale candidates have no recent edits and a low cross-reference count from other artifacts.

4. **Run detection checks**:

   | Check | Detection | Proposed action |
   |---|---|---|
   | **Duplicate content** | Two artifacts cover overlapping scope, or descriptions share trigger phrases | `MERGE` — present both, propose unified |
   | **Over size budget** | SKILL.md >1000 lines, rule >500 with multiple distinct topics | `SPLIT` — propose 2+ artifacts with clean scope, or extract detail to `references/<topic>.md` |
   | **Stale** | git: no edits in 6+ months and zero cross-references from other artifacts | `ARCHIVE` — move to `intelligence/_archive/` |
   | **Negative-framed instruction** (judgment call) | Body contains "never do X" / "don't X" / "X, not Y" where positive framing fits | `REWRITE` — propose positive replacement |
   | **ALL-CAPS MUST/NEVER for judgment** | Body uses uppercase MUST / NEVER / ALWAYS outside safety/security/output context | `REFRAME` — replace with decision rule + reasoning |
   | **Weak / duplicate description** | Description identical or near-identical to another, or under 3 words for a sibling-rich registry | `DIFFERENTIATE` — propose distinct trigger |
   | **Missing frontmatter field** | Required field absent (`name`, `description`) | `PATCH` — add the missing field |
   | **Orphan rule** | No skill / agent / cross-reference points at this rule | `FLAG` — review whether intentional or stale |
   | **Body leads negative** | First section of rule body is FORBIDDEN instead of REQUIRED | `REORDER` — REQUIRED first |
   | **Description over cap** | Description exceeds 250 chars | `TRIM` — propose shorter version preserving distinct trigger |

5. **Build the punch-list**: each item has — finding, target file, proposed action, priority (1 = high-impact, 3 = low). High-impact: size violations, duplicates, orphan rules referencing dead code. Low-impact: description tweaks, single ALL-CAPS occurrence.

6. **Output the punch-list to the user**. Read-only — no files written by this skill.

## User approval gate

User reviews list, accepts items individually. Bulk-accept for low-impact tweaks is fine.

## Apply phase

7. Accepted items are handed to `intelligence-learn-from-context` Phase B for application. That skill owns the write machinery — single source of truth for the apply path. Pass:
   - Action type (`MERGE` / `SPLIT` / `ARCHIVE` / `REWRITE` / `REFRAME` / `DIFFERENTIATE` / `PATCH` / `REORDER` / `TRIM`)
   - Target file path
   - Drafted change content
   - One-line reasoning

8. After Phase B finishes — `/intelligence-sync` runs once for all applied changes.

## Related skills

- `intelligence-learn-from-context` — single-lesson capture; this skill's apply phase delegates to its Phase B
- `intelligence-extract-skill` — when an audit surfaces a workflow that should become a new skill
