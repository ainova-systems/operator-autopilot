# intelligence-sync: Conventions

> **Historical documentation.** Intelligence Sync is archived. Current authoring, package and adapter conventions live in the supported [Intelligence CLI](https://github.com/ainova-systems/intelligence); this document describes only the frozen vendored engine.

## Choosing artifact type

Three artifact types — each has a different intent and loading mechanism. Picking the right one is the first authoring decision.

| Type | Intent | Loading | Content |
|---|---|---|---|
| **Rule** | LLM **respects** a constraint or convention in the background | Auto (path-scoped or always-on) | Required patterns, invariants, architecture, examples |
| **Skill** | LLM **performs** a multi-step procedure on invocation | Explicit (`/skill-name`) | Numbered steps with verification |
| **Agent** | LLM **adopts** a persona / domain expertise | Explicit (via agent picker) | Expertise scope, before-any-task checklist, build/verify |

Plain rule of thumb:
- "AI should consider X across any work in scope" → **rule**
- "AI should execute a defined sequence of steps" → **skill**
- "AI should think as an X-domain expert with these tools" → **agent**

Common mistakes to avoid:
- Conventions / standards embedded in an agent body → belongs in a **rule** (auto-loaded, shared across all agents working in scope)
- A workflow embedded in a rule body → belongs in a **skill** (explicit invocation, not always-loaded context)
- Expertise scope embedded in a skill body → belongs in an **agent** (persona reusable across many skills)

## Source Structure

```
intelligence/                         # Umbrella — name NOT hardcoded (whatever holds config.yaml)
├── config.yaml                       # Sync config + `sync_version` schema key (committed)
├── rules/                            # Path-based rules (auto-loaded by context)
│   ├── context.md                    # Always-loaded (no paths:)
│   ├── backend.md                    # paths: ["src/backend/**"]
│   └── frontend.md                   # paths: ["src/frontend/**"]
├── agents/                           # Specialized agent definitions
│   ├── backend-developer.md          # tier: heavy, access: full
│   └── backend-code-reviewer.md      # tier: standard, access: readonly
├── skills/                           # Reusable project skill commands
│   ├── backend-add-endpoint/SKILL.md
│   └── frontend-add-component/SKILL.md
├── adapters/                         # OPTIONAL — project-owned adapters (survive updates)
│   └── myide.sh                      # sync_to_myide(); overrides a built-in of the same name
└── sync/                             # intelligence-sync MODULE (upstream-owned)
    ├── INIT.md  docs/  scripts/(+VERSION)
    ├── rules/intelligence-authoring.md    # authoring discipline for this layer
    ├── agents/intelligence-architect.md   # designs and prunes this layer
    ├── agents/intelligence-operator.md    # runs sync, update, adapter flows
    └── skills/intelligence-*              # meta-skills
```

Everything project-authored lives at the umbrella level (`rules/ agents/ skills/ adapters/`); everything upstream-owned lives in the self-contained module `sync/`, updated independently via `sync/scripts/update.sh`. Additional modules (e.g. `domain/`) sit beside `sync/`. The umbrella folder name is derived at runtime as "the directory holding `config.yaml`" — never hardcoded. The `intelligence-` prefix is **reserved** for upstream artifacts; project rules, agents and skills must not use it (the updater prunes what matches it).

The module ships three kinds of artifact, and `config.yaml` must list all three under `sources` for them to reach the IDEs — `<umbrella>/sync/rules`, `<umbrella>/sync/agents`, `<umbrella>/sync/skills`. INIT emits those entries on bootstrap; the `0.7.0` migration adds them to existing projects.

### Layout tokens in engine-shipped artifacts

An artifact shipped *by the engine* cannot write the umbrella's name down — the project chooses it (`intelligence/`, `Intelligence/`, a codename). So engine artifacts spell it with tokens, and every adapter expands them on the way out (`finalize_output_file` in `lib/common.sh`):

| Token | Expands to | Example |
|---|---|---|
| `<umbrella>` | repo-relative umbrella dir | `Intelligence` |
| `<module>` | repo-relative engine module | `Intelligence/sync` |

Expansion covers frontmatter and body alike, so `paths: ["<umbrella>/**"]` reaches Claude's `paths:`, Cursor's `globs:` and Copilot's `applyTo:` already carrying the project's real folder name. Project-authored artifacts may use the tokens too, but they have no reason to — they can simply name their own folders.

A custom adapter belongs in the umbrella's `adapters/`, never in the module's `sync/scripts/adapters/` — the module is replaced wholesale on every update, so an adapter written there disappears at the next one. See `docs/ADAPTERS.md`.

Rule filenames, agent names, and skill names all share the same **domain prefix** (`backend-`, `frontend-`, `devops-`, `core-`, `tests-`, project codename, or monorepo component name). Pick the domain once from repo structure and reuse it — do not invent new domains without clear need.

### Packs (remote sources)

A `sources.{rules,agents,skills}` entry is normally a **local path** relative to the repo root. It may instead reference a **pack** — a remote git repo that `sync` shallow-clones and treats exactly like a local source directory — so a team can keep shared intelligence in one repo and pull it into many projects.

A pack is **declared once** under `packs:` and referenced by name from as many sections as need it:

```yaml
packs:
  shared-intel:
    url: https://github.com/org/shared-intel.git
    ref: v1.2.0                                    # the pin — one place, not one per section
    mirror: "intelligence/external/shared-intel"   # optional; see below

sources:
  rules:
    - "intelligence/rules"        # local
    - "@shared-intel/rules"       # pack
  skills:
    - "@shared-intel/skills"      # same pack, same clone, same pin
```

Declaring the pack is what keeps the url and the ref in one place. Repeating them per section is how the two drift, and nothing catches it: rules pinned at one commit and skills at another is a config that looks fine and reads wrong.

Reference format: `@<pack>[/<subpath>]`

- `<pack>` — a key under `packs:`. It is a **reference handle, never a path component**, so it needs no sanitizing; it must simply contain no `/`.
- `/<subpath>` — optional directory inside the pack repo holding the rules / agents / skills. Omit to use the repo root. The subpath is preserved in the mirror, so `@shared-intel/packs/core/rules` lands at `<mirror>/packs/core/rules`.
- **An undeclared pack fails the run** (exit 1, naming the pack and listing the declared ones). This is deliberately unlike a missing local path, which only warns: the config claims to know that name, so a typo must not quietly drop a whole rule set.

Pack fields:

- `url:` — must carry an explicit scheme: `https://`, `http://`, `ssh://`, `git://`, or `file://`. Other transports (notably the command-executing `ext::` / `fd::`) are **rejected** with a warning and skipped.
- `ref:` — optional tag, branch, or commit SHA. Omit for the default branch.
- `mirror:` — optional; see [Mirroring a pack into the repo](#mirroring-a-pack-into-the-repo).

#### Inline specs (`git+…`)

A source entry may still carry the whole spec inline: `git+<url>[@<ref>][#<subpath>]`. This is an **anonymous pack** — it has no declared name and no mirror, so it is always transient and cannot be referenced from elsewhere. Declare the pack under `packs:` to pin it once or to commit it.

The inline `@<ref>` is parsed as the segment after the last `@`, accepted as a ref only when it contains no `/` (so `ssh://git@host/...` userinfo is not mistaken for a ref). Branch names containing `/` (e.g. `feature/x`) can't be expressed this way — use `packs:` with a plain `ref:`, which has no such limit.

Behavior and trust:

- **Fresh every sync.** Each `sync` run clones into a run-scoped temp dir and removes it on exit, so branch refs always pick up the latest. Within one run the same `url@ref` is cloned only once, even when several entries (different subpaths) reference it.
- **Reproducibility / supply chain.** A remote's content becomes rules, agents, and skills the LLM reads as project context. Pin to a tag or SHA so an upstream change can't silently alter behavior, and only reference repos you trust.
- **Containment.** The clone can't be made to read outside itself: `..` in `#subpath` is refused, remote repos are checked out with `core.symlinks=false` (a hostile `skills -> /etc` link becomes an inert text file, not a path the copy step follows), and the resolved directory is verified to sit inside the clone.
- **Line endings are the pack's, not the host's.** The clone pins `core.autocrlf=false` and `core.eol=lf`, so a pack that declares no `.gitattributes` still materializes the bytes it has stored. Without it, Git for Windows' `core.autocrlf=true` default would rewrite the checkout to CRLF and a `mirror:` — copied verbatim — would land CRLF in your repo, showing up as a whole-pack diff after every sync.
- **Private repos** rely on ambient credentials (an SSH agent or git credential helper). `sync` runs git with `GIT_TERMINAL_PROMPT=0`, so a missing credential fails fast with a warning instead of hanging; local sources still sync.
- **Best-effort.** A clone failure (offline, bad URL, missing subpath) warns on stderr and skips that one source — the rest of the sync proceeds and still reports `IS_STATUS=ok`.

#### Mirroring a pack into the repo

Without `mirror:` a pack exists only inside the run cache, so the only trace of an upstream change is a shifted diff in the *generated* output, mixed in with your own content. Give the pack a `mirror:` and it is additionally materialized there, which makes a version bump readable as an ordinary diff:

```yaml
packs:
  shared-intel:
    url: https://github.com/org/shared-intel.git
    ref: v1.2.0
    mirror: "intelligence/external/shared-intel"   # omit to keep the pack transient
```

```
intelligence/external/
└── shared-intel/          # the path you declared — nothing is derived
    ├── .pack              # url + ref + resolved SHA, written by sync
    ├── rules/             # only the subpaths your sources reference
    └── skills/
```

Commit that directory — being able to review `git diff` after bumping a pin is the entire point. `<umbrella>/external/<pack>` is the recommended location, but the value is a plain path, so packs can live wherever suits the repo, one per pack.

- **The directory is declared, never derived.** `mirror:` says exactly where the pack goes, so there is no name to sanitize and no collision to resolve.
- **`.pack` is output, not config.** sync writes it; nothing reads it as configuration and it is not meant to be hand-edited. The pin lives in `config.yaml`.
- **Only the referenced subpaths are copied**, so a pack's `README`, CI config and tests never enter your repo. A reference with no subpath copies the whole repo.
- **`.git` is never copied.** A nested repository would be recorded as a gitlink, whose contents git does not track — precisely the state this avoids.
- **Cleared once per run.** The first entry to touch a pack clears its mirror, so content left by a previous ref (or by a source entry you have since deleted) does not linger; later entries only replace their own subpath.
- **Never destructive.** The `.pack` stamp marks the directory as sync's to manage: a non-empty directory *without* one is left alone (with a warning) rather than deleted, so a directory of your own at that path is safe. A stamped directory stays the pack's even after you edit its `url:` — a moved or renamed upstream refreshes the mirror, which is the whole point of committing it. To hand a mirror path back to the project, delete the directory. A mirror that resolves to the repo root, escapes the repo, or sits inside a configured `sources.*` directory is refused outright — `sync` exits 1 before anything is written.
- Mirrored files have committed paths, so `AGENTS.md` and the Pi adapter link to them like any local source instead of naming them bare. A transient pack has no such path and is still named bare.

## Agent Frontmatter

```yaml
---
name: agent-name                     # Kebab-case identifier
description: When to use this agent  # Shown in IDE agent picker
tier: heavy|standard|light           # Model capability (tool-agnostic)
access: full|readonly                # Tool permissions (tool-agnostic)
skills:                              # Optional: linked skills
  - skill-name-1
  - skill-name-2
---

Agent instructions in markdown...
```

### An agent is thin — it never restates the rules

Body sections: **Expertise** → **Boundaries** (where it stops) → **Build & Verify**. What belongs to the agent is its role, its limits, and how it proves the work is done.

**Do not instruct an agent to read the rules.** They reach it on their own: Claude Code loads `.claude/rules/` into every custom subagent's startup context alongside `CLAUDE.md` (*Subagents → What loads at startup*), and Cursor, Copilot, Codex, Pi and opencode receive always-on rules inlined in `AGENTS.md`. A `Read intelligence/rules/<domain>.md before starting` line is duplication: it doubles the tokens and creates a second copy that drifts from the rule it copied. Point at a rule by name if you must; never restate it. The urge to copy a rule into an agent means the rule is in the wrong place — move it.

### Tier Mappings

| Tier | Claude | Cursor | Copilot / Codex | opencode | Use for |
|------|--------|--------|-----------------|----------|---------|
| heavy | opus | (default) | gpt-5.6-sol | claude-opus-4-8 | Developers, complex reasoning, migration |
| standard | sonnet | fast | gpt-5.6-terra | claude-sonnet-5 | Reviewers, validators, analysis |
| light | haiku | fast | gpt-5.6-luna | claude-haiku-4-5 | Simple lookups, formatting |

The vocabulary is tool-agnostic on purpose: the source says `tier: heavy`, and each adapter resolves it through `get_model()`. Defaults move forward as vendors ship new models — pin one per IDE/tier under `models:` in `config.yaml` only when you must, and expect a drift report on every sync once the default overtakes the pin.

### Access Mappings

| Access | Claude | Cursor | Description |
|--------|--------|--------|-------------|
| full | (no `tools:` field - inherits every session tool, MCP servers included) | (default) | Full edit access |
| readonly | tools: Read,Grep,Glob,Bash + disallowedTools: Write,Edit | readonly: true | Analysis only |

## Rule Frontmatter

```yaml
---
paths:                               # Optional: path-based activation
  - "src/backend/**"                 # Glob patterns from repo root
  - "config/**"
---

Rule content in markdown...
```

- **With paths:** Rule auto-loads when user edits matching files
- **Without paths:** Rule applies always (context rules)

### Sync Transformations (Rules)

| Source | Claude | Cursor | Copilot | Codex / Pi / opencode / AGENTS.md |
|--------|--------|--------|---------|------------------------|
| `paths:` (scoped) | copied | `globs:` in `.mdc` | `applyTo:` in `.instructions.md` | listed in AGENTS.md; Pi also gets generated on-demand rule files + extension |
| no `paths:` (always-on) | copied | skipped | skipped | inlined into AGENTS.md |
| extension | `.md` | `.mdc` | `.instructions.md` | inline / generated extension / n/a |

Always-on rule content is inlined once into AGENTS.md (which Cursor, Copilot, Codex, Pi, and opencode read natively); the per-IDE rule channels carry only path-scoped rules to preserve monorepo glob targeting without duplicating context. Claude Code does not read AGENTS.md, so its adapter receives the full rule set. opencode has no first-class path-scoped channel (users may opt in via `instructions:` globs in `opencode.json`), so the opencode adapter does not generate scoped-rule files.

## Skill Frontmatter

Skills follow the [Agent Skills open standard](https://agentskills.io) (adopted by Claude Code, Cursor, GitHub Copilot, OpenAI Codex, Pi, Gemini CLI, OpenCode, Goose, Junie, and 30+ others). Required fields: `name` + `description`.

```yaml
---
name: <domain>-<verb>-<noun>         # e.g., backend-add-endpoint
description: What the skill does     # Shown in IDE skill picker
argument-hint: <arg1> [arg2]         # Optional: usage hint
---

# Skill Title

## Steps
1. First step...
2. Second step...
```

Standard optional fields (`license`, `compatibility`, `metadata`, `allowed-tools`) and IDE-specific extensions (Claude's `disable-model-invocation`, `model`, `effort`, `agent`, `context: fork`, `hooks`, `paths`, `shell`) pass through unchanged — adapters do not strip them. The engine's own flow skills declare `agent:` (`intelligence-review-skills` → `intelligence-architect`, the four sync/update/adapter flows → `intelligence-operator`); the binding takes effect where a tool honors it, and a skill invoked directly runs on the session model unless it also sets `context: fork`, as `intelligence-sync` does — the flows that can need the user mid-run (update, adapter install/removal) deliberately do not. Each tool ignores fields it does not understand.

**Limits that reject the skill outright** (it does not degrade — it disappears from the picker):

| Field | Limit | Failure |
|---|---|---|
| `description` | 1024 chars | *"Skill description must be at most 1024 characters"* |
| `name` | 64 chars | rejected at load |
| `argument-hint` | must be a **string** | `argument-hint: [pr-number]` is a YAML flow *sequence* unquoted → *"argument-hint must be a string"* |

Sync quotes `description` and `argument-hint` for every target on the way out, so an unquoted hint is fixed automatically; the length limits it can only warn about (`lint_frontmatter` prints the file, line and actual length) — shortening the text is the author's call.

### Naming Conventions

Skill names are `<domain>-<verb>-<noun>`. Both parts are required.

**Domain prefix** (the scope — required, never omit):

| Source | Domain |
|--------|--------|
| Single / root project | Project codename from `config.yaml` → `project.name` |
| Backend service / API | `backend-` |
| Frontend / web / UI | `frontend-` |
| Infrastructure / IaC / CI/CD | `devops-` |
| Shared library / common code | `core-` |
| Test suites (e2e, integration) | `tests-` |
| Monorepo named components | Component name (e.g., `billing-`, `auth-`) |
| Tool-internal (intelligence-sync) | `intelligence-` |

Reuse an existing domain whenever possible. Do not invent new domains without clear need.

**Verb prefix** (the action):

| Verb | Type | Description |
|------|------|-------------|
| `add-` | Append | Puts one new member into a set that already exists |
| `create-` | Originate | Brings into existence the container nothing hosted before |
| `update-` | Revise | Changes what is already there, selectively |
| `run-` | Execution | Runs an operation (tests, sync, build) |
| `review-` | Read-only | Analyzes code without changes |
| `test-` | Testing | Manual or automated test verification |
| `remove-` | Deletion | Safely removes an artifact |

Agents follow the same domain prefix rule: `<domain>-<role>` (e.g., `backend-developer`, `frontend-code-reviewer`). Rule filenames use the domain without a verb: `<domain>.md` (e.g., `backend.md`).

### How much a skill body carries

A skill that does the work itself carries the detail: the patterns, the code, the examples. A skill that dispatches to other skills stays thin — it names them and adds only what it alone knows (the discovery, the order, the check between steps), and it never restates their content, because two copies of a procedure disagree at the first edit.

Which of the two a skill is has nothing to do with its verb. An `add-` skill may dispatch, and a `create-` skill may do the work itself: the verb answers what already existed (Verb prefix, above), not how the skill is built inside.

## Authoring Discipline

### Writing description fields

Each skill, rule, and agent has a `description` field in frontmatter. This field is loaded into every IDE's available-skills context. **Total description tokens across all artifacts compete for a shared budget** — with a large registry, longer descriptions push other skills out of reach.

Two cases:

| Case | Format | Length target |
|---|---|---|
| **Unique skill** (no siblings doing similar action) | Plain verb-noun phrase | 4-8 words |
| **Skill with siblings** (multiple similar skills in registry) | verb-noun + distinct trigger phrase | 10-20 words, ~250 chars |

Two different numbers, do not confuse them: **~250 chars is the house budget** (what keeps the shared registry affordable), while **1024 chars is a wall** — Claude Code and the Agent Skills standard reject a longer `description` outright and the artifact disappears from the picker. Sync warns at the wall (`lint_frontmatter`); staying near the budget is the author's job.

Examples:

```yaml
# Unique skill — short is fine
description: "Create new intelligence rule"

# Sibling skill — needs distinguishing trigger
description: "Run weekly check-up: retrospective + strategic analysis + next week planning"
```

When the registry grows past comfortable budget, prefer **curation** (merge duplicates, archive orphans via `intelligence-review-skills`) over truncating descriptions individually.

### Size discipline — the backstop, not the goal

The goal is **subtraction** (see the `intelligence-authoring` rule the engine ships): every line is loaded into someone's context out of a shared, finite budget, so the default answer to "should this be a rule?" is no. These caps are only the line past which something is definitely wrong.

| Type | Hard cap | Over the cap |
|---|---|---|
| SKILL.md body | 1000 lines | Move detail into `references/<topic>.md` and point at it |
| Reference file (`references/*.md`) | 500 lines | Add a table of contents past 300 lines |
| Rule | 500 lines | Split by sub-scope, or move pattern detail to `references/` |
| Agent | 200 lines | Refactor — agents stay thin; heavy content lives in skills and rules |

**Ceilings, not quotas.** An artifact that says everything it needs to is finished, not underweight. Over the cap means it is doing two jobs, or the detail belongs behind a pointer: `Read references/<topic>.md when [condition].`

Resource organization — **content lives inside the skill that uses it, by default**:

```
skill-name/
├── SKILL.md (required)
├── references/    — Detailed docs, loaded on demand
├── scripts/       — Executable helpers for deterministic / repetitive steps
└── assets/        — Files used in output (templates, fonts, icons)
```

Sync copies the whole directory, so a bundled helper travels with its skill into every tool. **Promote a helper out of the skill folder only when a second skill needs it** — then it lives beside the source groups (e.g. `<umbrella>/scripts/`) and every skill resolves it the same way. The dividing line is reuse, not repetition: a helper one skill runs a hundred times still belongs to that skill.

### Writing principles

Apply to skill bodies, rule bodies, and agent bodies — anywhere LLM-facing instructions are authored.

**Use imperative form.** "Read the config file" works better than "You should read the config file."

**Explain the WHY.** LLMs follow positive instructions better when reasoning is visible. "Use module boundaries — AI knows which imports are allowed without guessing" works better than "Use module boundaries (MUST)."

**Reserve absolute language for true invariants.** ALL-CAPS MUSTs and NEVERs fit security, safety, output format — places where the constraint is non-negotiable. For judgment calls, write **decision rules** in positive form: "When X, do Y" instead of "NEVER do Z." If you find yourself writing ALWAYS or NEVER in all caps for a judgment call, that's a yellow flag — reframe and explain the reasoning.

**Keep prompts lean.** Remove instructions that aren't pulling their weight. Padding wastes context and dilutes the instructions that matter.

**Lead with positive defaults.** Rule body order: REQUIRED → Invariants → Architecture → Build & Test → Examples → Patterns to recognize and replace. The LLM acts on the positive instruction it reads first; anti-patterns sit at the end as reference documentation, not as instructions.

**Bundle repeated patterns as scripts.** If the LLM reinvents the same helper on every invocation, encode it in `scripts/` and have the skill call it.

## Generated Output

| Target | Rules output | Skills location | Agents location | Git-ignored |
|--------|--------------|-----------------|-----------------|-------------|
| `agents` | inlined into `AGENTS.md` (always-on); listed (scoped) | n/a | listed in `AGENTS.md` | No (committed) |
| Claude Code | `.claude/rules/` (full) | `.claude/skills/` | `.claude/agents/` | Yes |
| Cursor | `.cursor/rules/*.mdc` (scoped only) | `.cursor/skills/` | `.cursor/agents/` | Yes |
| GitHub Copilot | `.github/instructions/*.instructions.md` (scoped only) | `.github/skills/` | `.github/agents/` | Partial |
| OpenAI Codex | none (reads `AGENTS.md`) | `.agents/skills/` | `.codex/agents/*.toml` | Yes |
| Pi | `.pi/intelligence-sync/rules/*.md` + `.pi/extensions/intelligence-sync-rules.ts` (scoped only; always-on via `AGENTS.md`) | `.agents/skills/` | `.pi/prompts/intelligence-agent-*.md` | Partial |
| opencode | none (always-on via `AGENTS.md`; users may opt in to scoped rules via `instructions:` globs in `opencode.json`) | `.agents/skills/` | `.opencode/agents/*.md` (mode: subagent) | Yes |

Skill locations all comply with the Agent Skills open standard. Cursor reads from `.cursor/skills/` and `.agents/skills/`; Copilot reads from `.github/skills/`, `.claude/skills/`, and `.agents/skills/`; Codex, Pi, and opencode all read from `.agents/skills/`; Claude Code reads from `.claude/skills/`.

**Rule routing rationale:** AGENTS.md is canonical for Cursor/Copilot/Codex/Pi/opencode (all read it natively), so always-on rule content is inlined there once and the per-IDE rule directories carry only path-scoped rules — no duplication. Claude Code does not read AGENTS.md, so its adapter receives the full rule set.

`AGENTS.md` is always enabled and regenerated on every sync. The static header (`targets.agents.header` in `config.yaml`) is the only hand-authored part; everything below it is rebuilt from frontmatter — agents/skills tables, the rules list, and the inlined content of every always-on rule (those without `paths:`). Path-scoped rules are listed by name only so AGENTS.md does not balloon in monorepos.

## Migration & Module Contract

Structural changes to the module layout are handled by **versioned migrations**, not ad-hoc scripts or manual instructions. The model is designed for an *unbounded, uncoordinated* upgrade window — a project may sit on an old version indefinitely and still migrate safely whenever it finally runs.

**Division of responsibility**

- **Bash = deterministic, fail-closed core.** It performs only mechanically safe, reversible-until-committed steps and **never guesses**. Any state it cannot resolve safely is reported, not forced.
- **`intelligence-update` skill = intelligent layer.** It detects project state, bootstraps the engine, runs bash, interprets the status, and resolves the cases bash refuses (asking the user when genuinely ambiguous).

**The schema-version contract key.** The applied schema version is a managed, top-level scalar `sync_version` in `config.yaml` — *not* a dotfile, *not* `scripts/VERSION`. `config.yaml` is what most future breaking changes reshape, so the schema version lives with what it versions. **Invariant: this key is permanent and format-stable** — no migration may ever rename, move, or change its shape, so any engine (however old/new) can always read "what schema is this?" before parsing the rest. The bootstrap/INIT flow emits it for fresh projects (= engine `scripts/VERSION`) and must preserve it on re-bootstrap. `scripts/VERSION` = what the engine *is*; the key = what has been *applied*; the gap = pending breaking changes.

**Every `migrate_to_<ver>` obeys this contract**

1. **Version-named & ordered.** Suffix is the target version (`migrate_to_0_3_1`); listed in `MIGRATIONS=()` ascending, append-only — never reorder or rewrite shipped migrations.
2. **Idempotent structural precondition is the correctness mechanism.** Each migration self-detects from the actual on-disk/config structure whether its change is already applied, and is a silent no-op if so. The dispatcher runs the whole chain in order; it does **not** gate on the version stamp — so a wrong/missing `sync_version` can never cause a needed migration to be skipped. Replaying any number of times never fails or duplicates.
3. **Transactional / fail-closed.** Stage → **verify postcondition (sentinel)** → commit → only then delete the old state. A crash or partial input leaves the prior state intact; nothing is destroyed before the replacement is verified.
4. **Version-compat guard.** A stale engine refuses to operate on a project whose `sync_version` is newer than it understands (`ahead-of-engine`). This is the *only* role of the stamp — a guard, never a gate.
5. **Status hand-off is first-class.** "Cannot safely automate" is a normal outcome, reported via the contract below — not an error to paper over.

**Breaking-change releases carry a `### Breaking` CHANGELOG subsection**, each item stating its post-condition. The `intelligence-update` skill reads the changelog across the version gap, surfaces these, and verifies each post-condition after applying. `sync.sh` is a pure synchronizer — it never migrates; it fails closed (`needs-update`) across an un-applied gap so a stale engine can't generate against a newer schema. `update.sh` (+ the skill) is the sole migrator.

**bash ↔ skill status contract** (codes are public; never renumber)

| `IS_STATUS` | exit | Meaning |
|---|---|---|
| `ok` | 0 | Up to date / nothing to do |
| `migrated` | 0 | Migration performed this run |
| `error` | 1 | Generic failure (detail in message) |
| `config-missing` | 2 | No `config.yaml` — project not bootstrapped |
| `ambiguous` | 3 | Conflicting state; skill/human-only (bash never emits it) |
| `ahead-of-engine` | 4 | Project schema newer than this engine |
| `aborted-incomplete` | 5 | Staged module incomplete; prior state left intact |
| `needs-update` | 6 | Pending breaking changes — run the update flow first |

Bash emits `IS_STATUS=<code> [IS_DETAIL=...]` on stdout and exits with the matching code; callers capture it with `cmd || rc=$?` (never `if ! cmd; then exit $?` — that loses the code). The skill branches on the code.

**Module model.** The engine self-locates by its own path; it does not assume a folder name (`sync/` by convention). Each `<umbrella>/<module>/` is self-contained: its own `scripts/`(+`VERSION`), `skills/`, `INIT.md`, `docs/`. Modules update independently and never touch sibling modules or project content (`rules/`, `agents/`, non-meta `skills/`) nor `config.yaml` beyond the idempotent additive `sources.skills` line and the `sync_version` key.

## .gitignore Pattern

```
# AI IDE tools (generated by intelligence-sync, local preferences)
CLAUDE.md
.cursorrules
.agents/
.codex/
.pi/intelligence-sync/
.pi/extensions/intelligence-sync-rules.ts
.pi/prompts/intelligence-agent-*.md

# opencode: the generated subagents and slash commands are owned by the adapter.
# .opencode/opencode.json (and any other hand-authored config) stays tracked.
.opencode/agents/
.opencode/commands/

# Claude Code: ignore everything except project-shared settings.
.claude/*
!.claude/settings.json

# Cursor: same pattern.
.cursor/*
!.cursor/settings.json
```

The inverse pattern (`.claude/*` + `!.claude/settings.json`) ignores every generated subdir (`rules/`, `skills/`, `agents/`) plus any per-machine state Claude writes (`settings.local.json`, `*.lock`, `scheduled_tasks.*`, `sessions/`, `cache/`, etc.) without having to enumerate filenames Claude may add later. Only `.claude/settings.json` (project-shared bash allowlist, tool permissions) is tracked. Same logic for `.cursor/`. Pi and opencode are narrower: only the generated adapter-owned paths are ignored (`.pi/intelligence-sync/`, `.pi/extensions/intelligence-sync-rules.ts`, `.pi/prompts/intelligence-agent-*.md`, `.opencode/agents/`, `.opencode/commands/`), so `.pi/settings.json`, `.opencode/opencode.json`, and any hand-authored Pi extensions/prompts remain available for tracking. The opencode adapter additionally protects hand-authored slash commands by an emit-marker (`<!-- Generated by intelligence-sync. Do not edit manually. -->`): re-sync only deletes marker-bearing files in `.opencode/commands/`, so a project may track a hand-authored command alongside the generated ones (typically by un-ignoring it). If a project needs to track another file under `.claude/` or `.cursor/` (e.g., a hand-authored `.claude/commands/<name>.md`), add another `!<path>` line.

## Project Entry Points

| File | Role | Git status |
|------|------|-----------|
| `AGENTS.md` | Auto-generated canonical project doc for LLMs (do not edit manually) | Tracked |
| `CLAUDE.md` | Local user preferences (gitignored) | Ignored |
| `<umbrella>/config.yaml` | Sync config + `sync_version` schema-version contract key (committed) | Tracked |
| `<umbrella>/{rules,agents,skills}/` | Project source of truth | Tracked |
| `<umbrella>/sync/` | intelligence-sync module (engine+`scripts/VERSION`, meta-skills, INIT, docs) — vendored upstream-owned | Tracked |
