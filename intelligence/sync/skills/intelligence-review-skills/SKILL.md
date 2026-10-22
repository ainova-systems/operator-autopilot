---
name: intelligence-review-skills
description: "Audit the intelligence layer for duplication, drift, size, hardcoded paths and framing"
argument-hint: "[target: rules|agents|skills|all]"
agent: intelligence-architect
---

# Review the intelligence layer

Read-only audit of the project's rules, agents and skills, ending in a punch-list. This skill owns the **generic** audit — everything true of any repository. A project that adds laws of its own layers a thin project audit on top and invokes this one; it never re-implements these checks.

Name reflects the umbrella usage of "skills" for all AI artifacts (rules + agents + skills).

## Scope: what to read, and what to leave alone

1. **Resolve the layout — never assume folder names.** The umbrella is the directory holding `config.yaml`; the engine module is the directory under it holding `scripts/sync.sh` and `scripts/VERSION` (conventionally `sync/`). Read authoring conventions from `<module>/docs/CONVENTIONS.md` and the `intelligence-authoring` rule.

2. **Enumerate from `config.yaml`, not from a guessed path.** The artifacts are exactly the directories listed under `sources.rules`, `sources.agents` and `sources.skills` — there may be several groups (e.g. a shared one and a project one), they may be nested, and an `@<pack>` (or inline `git+`) entry is a remote pack declared under `packs:`. Take the list from the config; a literal `intelligence/rules/` is wrong in any project that named things differently.

3. **Skip everything the engine owns.** Sources under `<module>/` (`<module>/rules`, `<module>/agents`, `<module>/skills/intelligence-*`) are upstream-owned: `update.sh` replaces them wholesale, so a local "fix" there is deleted at the next update. Never propose an edit to them. If one of them is genuinely wrong, or a generic check is missing from this skill, that is a **proposal to upstream** — say so in the report rather than patching locally.

4. **Never read or edit generated output** (`.claude/`, `.cursor/`, `.github/`, `.codex/`, `.agents/`, `.pi/`, `.opencode/`, `AGENTS.md`). Sync owns those entirely; the finding always belongs to the source.

## Steps

5. **Pull git history** (when available) for each artifact — last edit, edit count, first-add date. A stale candidate has no recent edits *and* nothing cross-referencing it.

6. **Run the detection checks.** Judgement decides; the checks only make a finding evidence rather than an impression.

   | Check | What it is | Proposed action |
   |---|---|---|
   | **Duplicate content** | Two artifacts cover overlapping scope, or their descriptions share trigger phrases | `MERGE` — present both, propose one |
   | **Misplaced content** | A checklist or procedure in an agent body; a convention in an agent; a workflow in a rule; expertise in a skill (the *Pick the right artifact* table in `intelligence-authoring`) | `MOVE` — a move, not a rewrite: both files change together |
   | **Over the cap** | `SKILL.md` over 1000 lines, rule over 500, agent over 200 | `SPLIT` — two artifacts, or move detail into `references/<topic>.md` |
   | **Rule links to a rule** | A markdown link from one rule to another (`R1`) | `UNLINK` — name the rule instead: always-on rules are inlined into `AGENTS.md` and the scoped channels carry only scoped rules, so the link is dead in at least one output |
   | **Machine facts in a rule** | OS, shell, editor or a local absolute path (`R2`) | `MOVE` — these belong in a personal, gitignored `CLAUDE.md`; a rule is committed and read by everyone, including whoever is on another platform |
   | **Literal path or command in a skill** | A path *outside the skill's own folder* baked into a procedure (`R3`) | `PARAMETERIZE` — a skill is *executed*, so a literal path breaks the moment the layout moves; resolve it from a rule or from `config.yaml`. **Exempt:** the skill's own bundle (`references/`, `scripts/`, `assets/` — content is co-located with its skill by default); rules and agents (describing the repository is their job); an example inside an output-format block; the resolution step itself |
   | **Skill with no verification** | Nothing at the end proves the procedure worked (`R4`) | `FLAG` — a procedure that proves nothing is a note, or just the work: give it a verification, or delete it |
   | **Reserved prefix** | A project artifact named `intelligence-*` | `RENAME` — the prefix belongs to the engine, and the updater prunes what matches it |
   | **Naming** | A skill that is not `<domain>-<verb>-<noun>`, or a domain invented rather than reused | `RENAME` — or introduce the new domain deliberately |
   | **Stale** | No edits in 6+ months and nothing cross-references it | `ARCHIVE` — move to `<umbrella>/_archive/` |
   | **Negative-framed judgement call** | "Never do X" where a positive default fits, outside safety / security / output-format | `REWRITE` — state the default; reserve NEVER for true must-nots |
   | **Unbacked reason** | A rule asserts a *why* — a number, a measurement, a tool's behaviour — that nothing in the repo or in that tool's documentation supports | `FLAG` — an invented reason is worse than none: it sounds like evidence. Surface it with a draft; never rewrite the meaning yourself |
   | **Always-on rule that should be scoped** | A concern that only matters in one area, loaded into every session and inlined into `AGENTS.md` | `SCOPE` — add `paths:`, or justify the cost out loud |
   | **Weak / duplicate description** | Identical to a sibling, or too vague to choose between them | `DIFFERENTIATE` — add the distinguishing trigger |
   | **Description over budget** | Over ~250 characters (the shared registry budget); over **1024** the tools reject the artifact outright | `TRIM` — keep the distinguishing trigger, drop the rest |
   | **Missing frontmatter field** | `name` or `description` absent | `PATCH` — add it |
   | **Orphan rule** | Nothing points at it and nothing loads it | `FLAG` — intentional, or dead? |

   Detection commands, portable on purpose — no `\b` and no `-P`, so the same command works in Git Bash on Windows, on macOS (BSD grep) and on Linux. Run each over the source directories resolved in step 2, never over generated output:

   ```sh
   # R1 — a markdown link from one rule to another
   grep -rnE '\]\([^)]*\.md\)' <rule-dirs>

   # R2 — machine facts in a rule (a shell, someone's home directory, a drive letter)
   grep -rinE 'powershell|cmd\.exe|/Users/|/home/|[A-Za-z]:[\\]' <rule-dirs>

   # R3 — a path baked into a skill's steps, excluding the skill's own bundle
   grep -rnE --include=SKILL.md '[A-Za-z0-9._-]+/[A-Za-z0-9._/-]+\.[A-Za-z0-9]+' <skill-dirs> \
     | grep -vE '(^|[^A-Za-z0-9._/-])(references|scripts|assets)/'

   # R4 — skills whose body never mentions verifying anything (-L lists files with NO match)
   grep -riLE --include=SKILL.md 'verif|expect|assert|check|test|IS_STATUS' <skill-dirs>
   ```

   `R4` is a coarse net, not a verdict: a skill that merely *mentions* a verification command anywhere passes it. Read the final step of every skill regardless — the question is whether something at the end **proves the work landed**, not whether the word appears.

7. **Ask subtraction first.** Before proposing any `SPLIT`, `REWRITE` or `PATCH`, ask whether the artifact should exist at all, whether two should become one, and whether the rule could be replaced by a gate the model cannot skip. A deletion is a better outcome than a tidy-up, and the punch-list should say so when it is true.

8. **Build the punch-list**: finding, target file, proposed action, one-line reasoning, priority (1 = high-impact: duplication, misplaced content, an artifact that should not exist; 3 = low: description tweaks). Read-only — this skill writes nothing.

## User approval gate

The user accepts items individually; bulk-accept for low-impact tweaks is fine. Anything that changes **meaning** (a law, a boundary, a gate, an unbacked reason) is surfaced with a draft and left to the human who owns it — never auto-fixed.

## Apply phase

9. Accepted items go to `intelligence-learn-from-context` Phase B, which owns the write machinery — do not invent a second apply path. Pass the action, the target file, the drafted change and the reasoning.

10. Run `/intelligence-sync` once, after all accepted items are applied, and report one line per artifact: **pass / fixed (what) / flagged (for whom)**.

## Related skills

- `intelligence-learn-from-context` — single-lesson capture; this skill's apply phase delegates to its Phase B
- `intelligence-extract-skill` — when the audit surfaces a workflow that should become a skill
