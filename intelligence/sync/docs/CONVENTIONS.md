# intelligence-sync: Conventions

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
└── sync/                             # intelligence-sync MODULE (upstream-owned)
    └── INIT.md  docs/  scripts/(+VERSION)  skills/intelligence-*
```

Everything project-authored lives at the umbrella level (`rules/ agents/ skills/`); everything upstream-owned lives in the self-contained module `sync/`, updated independently via `sync/scripts/update.sh`. Additional modules (e.g. `domain/`) sit beside `sync/`. The umbrella folder name is derived at runtime as "the directory holding `config.yaml`" — never hardcoded. The `intelligence-` skill prefix is **reserved** for upstream meta-skills; project skills must not use it (the updater moves/prunes anything matching that prefix).

Rule filenames, agent names, and skill names all share the same **domain prefix** (`backend-`, `frontend-`, `devops-`, `core-`, `tests-`, project codename, or monorepo component name). Pick the domain once from repo structure and reuse it — do not invent new domains without clear need.

### Remote sources (git)

A `sources.{rules,agents,skills}` entry is normally a **local path** relative to the repo root. It may instead be a **remote git spec**, which `sync` shallow-clones on the fly and treats exactly like a local source directory — so a team can keep shared intelligence in one repo and pull it into many projects:

```yaml
sources:
  skills:
    - "intelligence/skills"                                       # local
    - "git+https://github.com/org/shared-intel.git@v1.2.0#skills"  # remote, pinned tag
  rules:
    - "intelligence/rules"
    - "git+ssh://git@github.com/org/shared-intel.git@main#rules"   # remote, branch
```

Spec format: `git+<url>[@<ref>][#<subpath>]`

- `<url>` — must carry an explicit scheme: `https://`, `http://`, `ssh://`, `git://`, or `file://`. Other transports (notably the command-executing `ext::` / `fd::`) are **rejected** with a warning and skipped.
- `@<ref>` — optional tag, branch, or commit SHA. Parsed as the segment after the last `@`, accepted as a ref only when it contains no `/` (so `ssh://git@host/...` userinfo is not mistaken for a ref). Branch names containing `/` (e.g. `feature/x`) can't be expressed this way — use a tag, SHA, or slashless branch (pinning is recommended regardless).
- `#<subpath>` — optional directory inside the cloned repo holding the rules / agents / skills. Omit to use the repo root.

Behavior and trust:

- **Fresh every sync.** Each `sync` run clones into a run-scoped temp dir and removes it on exit, so branch refs always pick up the latest. Within one run the same `repo@ref` is cloned only once, even when several entries (different `#subpath`s) reference it.
- **Reproducibility / supply chain.** A remote's content becomes rules, agents, and skills the LLM reads as project context. Pin to a tag or SHA so an upstream change can't silently alter behavior, and only reference repos you trust.
- **Containment.** The clone can't be made to read outside itself: `..` in `#subpath` is refused, remote repos are checked out with `core.symlinks=false` (a hostile `skills -> /etc` link becomes an inert text file, not a path the copy step follows), and the resolved directory is verified to sit inside the clone.
- **Private repos** rely on ambient credentials (an SSH agent or git credential helper). `sync` runs git with `GIT_TERMINAL_PROMPT=0`, so a missing credential fails fast with a warning instead of hanging; local sources still sync.
- **Best-effort.** A clone failure (offline, bad URL, missing subpath) warns on stderr and skips that one source — the rest of the sync proceeds and still reports `IS_STATUS=ok`.

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

### Tier Mappings

| Tier | Claude | Cursor | Use for |
|------|--------|--------|---------|
| heavy | opus | (default) | Developers, complex reasoning, migration |
| standard | sonnet | fast | Reviewers, validators, analysis |
| light | haiku | fast | Simple lookups, formatting |

Tier is only relevant for IDEs with agent support (Claude, Cursor). Other IDEs ignore it.

### Access Mappings

| Access | Claude | Cursor | Description |
|--------|--------|--------|-------------|
| full | tools: Read,Write,Edit,Glob,Grep,Bash,Agent | (default) | Full edit access |
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

Standard optional fields (`license`, `compatibility`, `metadata`, `allowed-tools`) and IDE-specific extensions (Claude's `disable-model-invocation`, `model`, `effort`, `context: fork`, `hooks`, `paths`, `shell`) pass through unchanged — adapters do not strip them. Each tool ignores fields it does not understand.

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
| `add-` | Atomic | Creates/updates a single artifact |
| `create-` | Orchestrator | Invokes multiple `add-` skills in sequence |
| `update-` | Meta-orchestrator | Discovers existing components, updates selectively |
| `run-` | Execution | Runs an operation (tests, sync, build) |
| `review-` | Read-only | Analyzes code without changes |
| `test-` | Testing | Manual or automated test verification |
| `remove-` | Deletion | Safely removes an artifact |

Agents follow the same domain prefix rule: `<domain>-<role>` (e.g., `backend-developer`, `frontend-code-reviewer`). Rule filenames use the domain without a verb: `<domain>.md` (e.g., `backend.md`).

### Skill Tiers

- **Atomic** (`add-`): Full implementation details, code patterns, examples
- **Orchestrator** (`create-`): Thin wrapper — discovery logic + calls to atomic skills. NO pattern duplication
- **Meta-orchestrator** (`update-`): Discovers existing components, invokes atomic skills for gaps

## Authoring Discipline

### Writing description fields

Each skill, rule, and agent has a `description` field in frontmatter. This field is loaded into every IDE's available-skills context. **Total description tokens across all artifacts compete for a shared budget** — with a large registry, longer descriptions push other skills out of reach.

Two cases:

| Case | Format | Length target |
|---|---|---|
| **Unique skill** (no siblings doing similar action) | Plain verb-noun phrase | 4-8 words |
| **Skill with siblings** (multiple similar skills in registry) | verb-noun + distinct trigger phrase | 10-20 words, 250 char hard cap |

Examples:

```yaml
# Unique skill — short is fine
description: "Create new intelligence rule"

# Sibling skill — needs distinguishing trigger
description: "Run weekly check-up: retrospective + strategic analysis + next week planning"
```

When the registry grows past comfortable budget, prefer **curation** (merge duplicates, archive orphans via `intelligence-review-skills`) over truncating descriptions individually.

### Size discipline

Reference sizes for skill / rule / agent bodies:

| Type | Target | Hard cap | Over-budget action |
|---|---|---|---|
| SKILL.md body | <500 lines | 1000 lines | Refactor via `references/<topic>.md` and point to it from SKILL.md |
| Reference file (`references/*.md`) | <300 lines | 500 lines | Add table of contents past 300 lines |
| Rule | 80-300 lines | 500 lines | Split by sub-scope, or move pattern detail to `references/` |
| Agent | 40-150 lines | 200 lines | Refactor — agents stay thin; heavy content lives in skills/rules |

When approaching limits, add a layer of hierarchy: move detail into `references/<topic>.md`, then point to it from SKILL.md with `Read references/<topic>.md when [condition].`

Resource organization:

```
skill-name/
├── SKILL.md (required, <500 lines)
├── references/    — Detailed docs loaded as needed
├── scripts/       — Executable code for deterministic / repetitive tasks
└── assets/        — Files used in output (templates, fonts, icons)
```

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
