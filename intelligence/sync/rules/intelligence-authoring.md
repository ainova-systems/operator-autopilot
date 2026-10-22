---
name: intelligence-authoring
description: "Authoring discipline for the intelligence layer - subtraction first, rule vs skill vs agent, scoping, size"
paths:
  - "<umbrella>/**"
---

# Authoring the intelligence layer

Applies when writing or changing anything under `<umbrella>/`. The mechanics — frontmatter fields, tier and access vocabulary, how each tool is fed — live in `<module>/docs/CONVENTIONS.md`. This rule is the judgement that sits on top of them.

## Subtraction is the job

**Every line here is loaded into someone's context, and that budget is shared and finite.** An always-on rule is loaded into *every* session, forever. A line you add is a line something else loses — and the loss is invisible, so nobody ever notices what it cost.

So the default answer to "should this be a rule?" is **no**. Delete before you add. Merge before you split. The registry that gets trusted is the small one: a crowded one gets skimmed, and a skimmed rule is worse than a missing one, because it looks like coverage.

Three ways to shorten, in order of what they are worth:

1. **Make the rule unnecessary.** The best rule is a gate the model cannot skip. A rule that lists which command to run for which change is a *menu*, and a menu gets ordered from; the same decision expressed once, in a script the work has to pass through, cannot be forgotten, mis-remembered or skimmed past. **Ask this first, every time.**
2. **Delete what the code already says.** A rule restating what a reader can see in the file is noise, and noise trains people to skim the lines that are not.
3. **Cut the words, keep the reason.** Prose can shrink; the *why* cannot — an instruction without its reason does not survive contact with a judgement call.

**Never solve a problem by adding an artifact when moving one, or removing one, would do.** A new rule is the most expensive answer available, and it is the one that feels cheapest to write.

## Source of truth

Edit the sources listed in `config.yaml` — the `rules/`, `agents/` and `skills/` directories it names — and `config.yaml` itself. Everything else is derived: `.claude/`, `.cursor/`, `.github/{instructions,agents,skills}/`, `.codex/`, `.agents/skills/`, `.pi/`, `.opencode/` and `AGENTS.md` are **generated output**, and a hand edit there survives exactly until the next sync.

`<module>/` is the vendored engine. It owns its own rules, agents and meta-skills; `update.sh` replaces them wholesale, so a local edit there is lost at the next update. Fix it upstream instead.

After any change: `bash <module>/scripts/sync.sh`. A change that was not synced does not exist for any tool.

## Pick the right artifact

| Type | Intent | How it loads |
|---|---|---|
| **Rule** | The model **respects** a constraint while doing other work | Automatically — always-on, or path-scoped via `paths:` |
| **Skill** | The model **performs** a defined procedure | Explicitly — `/skill-name` |
| **Agent** | The model **adopts** a persona | Explicitly — via the agent picker |

The mistakes that actually happen, in order of frequency:

- A **checklist** written into an agent body → a checklist is a *procedure*; it belongs in a **skill**. This one keeps happening because a checklist *feels* like expertise. It is not: it changes with the task, a role does not. An agent is what it is for, what it optimises for, where it stops, and what it calls done.
- A **convention** written into an agent body → it belongs in a **rule**, so every agent gets it, not just the one you happened to be editing.
- A **workflow** written into a rule body → it belongs in a **skill**. A rule is loaded always; a procedure should be invoked.
- **Expertise** written into a skill body → it belongs in an **agent**; the persona is reusable across skills.

## Rules

**Scope with `paths:`.** A rule without `paths:` is loaded into *every* session and inlined into `AGENTS.md` — the most expensive context real estate there is. Earn it. A rule that only matters when someone touches the frontend belongs scoped to the frontend.

**Lead with the positive default, then the invariant.** The model acts on the first instruction it reads, and it follows whatever is named — negation ("never do X") draws attention to X. Reserve absolute language (NEVER, MUST) for true must-nots: safety, security, output format. A judgement call written as a NEVER only teaches the model that NEVERs are negotiable.

**Derive from the code, not from prose that already exists.** Every REQUIRED and every invariant must be backed by something observed in the repository. Documentation is a claim, not evidence — read the file.

**Describe the repository, not a machine.** The OS, the shell, the editor, a local dev stack, personal tooling — these are environment facts. They belong in a personal, gitignored `CLAUDE.md`. A rule is committed and read by everyone, so a shell-specific command or an absolute local path in it is simply wrong for whoever is on another platform.

**Explain the why — but only a why you can back.** A reason the reader can check is what makes an instruction survive a judgement call. An invented reason is worse than none: it sounds like evidence.

### Invariants

- **Never state behaviour of a tool or engine you have not verified in its documentation or source.** This invariant exists because the claim *"Claude Code does not auto-load `.claude/rules/`"* was once written into this layer as fact. It is false — rules without `paths:` load at launch, path-scoped ones activate on matching files, and custom subagents inherit both (Claude Code docs: *Memory → Organize rules with `.claude/rules/`*, and *Subagents → What loads at startup*). An unverified claim about tooling is worse than a gap: nothing in the repository contradicts it, so it silently reshapes every decision downstream.
- **Never write a current defect into a rule as if it were the design.** Known breakage belongs in one place that says so. Every other rule describes the project *as it is meant to work* — a workaround documented as procedure becomes permanent.
- **Never link from one always-on rule to another.** Always-on rules are inlined verbatim into `AGENTS.md`, and the path-scoped channels carry only scoped rules, so a relative link is dead in at least one output. Name the rule instead; it loads on its own.

## Agents

An agent is **thin**: who it is, where it stops, how it verifies. Nothing else.

- **Do not list rules for an agent to read.** They load on their own — Claude Code loads `.claude/rules/` into every custom subagent's startup context, and Cursor, Copilot, Codex, Pi and opencode receive always-on rules inlined in `AGENTS.md`. Naming a rule is fine; copying it is duplication that drifts.
- **Point at a rule, do not restate it.** Wanting to copy a rule into an agent means the rule is in the wrong place — move it.
- **Do carry** what is genuinely the agent's own: its boundaries ("if the app will not start, stop — do not hand-write the output"), its verification commands, its definition of done.

## Skills

A skill is a repeatable procedure someone invokes, and **it ends in a verification**. If there is nothing to verify at the end, or it will only ever run once, it is not a skill — it is a note, or just the work.

### Naming

`<domain>-<verb>-<noun>`. The domain prefix carries the weight: it clusters siblings and says which system the skill acts on. Take it from the set already in use; add a new domain deliberately, not by accident.

The verb just names the action — `add-`, `run-`, `review-`, `extract-`, `plan-`, `validate-` all read fine. Prefer a verb already in use over a new synonym for the same thing. A stage that turns one thing into another reads naturally as `<domain>-to-<target>`.

Two verbs are told apart by what already exists. **`add-` puts one new member into a set that is already there** — a field on an existing type, a record among records, a component in the inventory the project keeps — so the noun names the member, and the number of files it takes to land is not the point. **`create-` brings the container itself into existence**, where nothing hosted it before. Neither verb describes how a skill is factored inside, so splitting a skill's internals never renames it.

`intelligence-` is **reserved** for the engine's own artifacts. A project skill carrying that prefix is pruned by the updater — rename it.

### Shape

- **A skill is executed, so it must not hardcode what can move.** Its steps are followed literally: a path, a command or a project name baked into a procedure breaks the moment the layout moves. Resolve them from a rule or from `config.yaml` instead. This does **not** apply to rules and agents — a rule's job is to *describe* the repository, so naming a path in prose is exactly right. Naming a path is description; baking one into a procedure is a defect waiting to fire.
- **Keep everything the skill needs inside the skill's own folder.** The Agent Skills standard lets a skill ship `scripts/`, `references/` and `assets/` beside `SKILL.md`, and sync copies the whole directory, so a bundled helper travels with the skill to every tool. That is the default.
- **Promote a helper out of the skill folder only when a second skill needs it** — then it belongs beside the source groups, and every skill resolves it the same way. The dividing line is reuse, not repetition: one skill's helper stays with that skill however often it runs.
- **A helper is code.** It gets what code gets — a test, and a way to run it that does not assume one person's machine.

## Size — the backstop, not the goal

The goal is subtraction, above. These are only the line past which something is definitely wrong.

| Type | Hard cap |
|---|---|
| Rule | 500 lines |
| Agent | 200 lines |
| `SKILL.md` | 1000 lines |

**Ceilings, not quotas.** An artifact that says everything it needs to is finished, not underweight — nothing here is a reason to pad. Over the cap means the artifact is doing two jobs, or the detail belongs in `references/<topic>.md` with a pointer from the body.

`description` fields compete for one shared budget across the whole registry: a long one pushes another artifact out of reach. Four to eight words when the name is unambiguous; longer only when a sibling does something similar and needs distinguishing. (The tools reject a `description` over 1024 characters outright — but that is a wall to stay far away from, not a target.)

## Verifying a change to this layer

The per-artifact checks are a procedure, not a constraint to hold in mind while doing other work — so they live in the meta-skills, not here. Invoke the one that matches what you are doing: `intelligence-add-rule`, `intelligence-add-agent`, `intelligence-add-skill`, `intelligence-extract-skill`, `intelligence-review-skills`, `intelligence-learn-from-context`, `intelligence-sync`, `intelligence-update`, `intelligence-install-adapter`, `intelligence-uninstall-adapter`.

A change to this layer is done when `bash <module>/scripts/sync.sh` reports `IS_STATUS=ok` and the skill you invoked reports clean.
