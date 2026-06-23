# intelligence-sync: Initialize Your Project

The sync engine is already installed in this directory's `scripts/` subfolder. Your job: analyze this codebase, ask the user targeted questions, and generate the project-specific configuration and content.

**Execute phases sequentially. Do not skip or combine phases. Each phase has a gate — wait for it before proceeding.**

## Bootstrap: install the engine if it isn't here yet

You can reach this file two ways:

- **Already vendored in the project** (`intelligence/sync/INIT.md`) — the engine is installed. Skip straight to *Phase 0* below.
- **Fetched remotely** (a raw GitHub URL) — the engine is **not** installed yet. Install it first, then continue:

1. Check whether `intelligence/sync/scripts/sync.sh` exists at the project root. If it does, the engine is already installed — skip the rest of this section.
2. If it does not, clone upstream into a temp directory and copy the `intelligence/` folder into the project root (never clone into the project tree itself). Adapt the temp path to the platform:

   ```bash
   tmp="$(mktemp -d)"
   git clone --depth=1 https://github.com/ainova-systems/intelligence-sync.git "$tmp"
   cp -r "$tmp/intelligence" ./intelligence
   rm -rf "$tmp"
   ```

   If the project already has an umbrella folder holding a `config.yaml` under a different name (see *Phase 0*), copy the `sync/` module into that existing folder instead of creating a second `intelligence/`.
3. From here on, work against the freshly copied, version-matched `intelligence/sync/INIT.md` and the rest of this document — that copy is authoritative.

## Phase 0: detect the source folder name

This document is read by an AI agent and contains many literal references to `intelligence/` (lowercase). The folder you are reading from may have been **renamed** by the user (e.g. `Intelligence/`, `prompts/`, a project codename). Before doing anything else:

1. Identify the directory that contains this `INIT.md` and a `scripts/sync.sh` file. Call its basename `<intel>`.
2. Throughout the rest of this document, every reference to `intelligence/` means `<intel>/` — substitute it consistently in every path you write (`config.yaml` `sources:`, `targets.agents.header` Markdown links, generated content, skill instructions).
3. Do NOT create a second folder named `intelligence/` if `<intel>` is already different. The sync engine is folder-name-agnostic — `bash <intel>/sync/scripts/sync.sh` works regardless of casing or naming.

If the user has not renamed it, `<intel>` is `intelligence` and the literal text below applies as-is.

## What You Will Generate

1. `intelligence/config.yaml` -- sync configuration
2. `intelligence/rules/` -- coding standards and conventions
3. `intelligence/agents/` -- specialized AI personas
4. `intelligence/skills/` -- reusable command sequences
5. `AGENTS.md` -- project documentation for LLMs (committed)
6. `CLAUDE.md` -- local user preferences (gitignored, if Claude enabled)
7. `.gitignore` updates

## Pre-check

Before starting, verify:

1. `intelligence/sync/scripts/sync.sh` exists
2. `intelligence/sync/scripts/lib/common.sh` exists
3. `intelligence/sync/scripts/adapters/claude.sh` exists
4. Check initialization state:
   - **Already initialized** = `intelligence/config.yaml` exists AND `intelligence/rules/` contains at least one `.md` file
   - **Partially initialized** = either exists but not both
   - **Fresh** = neither exists

If files from steps 1-3 are missing, the engine isn't installed yet — go back to **Bootstrap** above and install it (clone upstream, copy `intelligence/` in), then re-run this Pre-check. Do not proceed to Phase 1 until they exist.

### Already initialized → offer sync-only path

If the project is **already initialized** (config + rules present), do NOT run the full bootstrap. Instead:

1. Check if local IDE output is missing or stale: for each enabled target in `config.yaml`, see whether the output path exists (e.g., `.claude/`, `.cursor/`, `AGENTS.md`). If any are missing, this is a new clone / new team member.
2. Tell the user: "This project is already initialized. I can just run `bash intelligence/sync/scripts/sync.sh` to generate your local IDE files from `intelligence/`."
3. Offer two options:
   - **Sync** — run `intelligence/sync/scripts/sync.sh` and exit (do not touch rules/agents/skills/config)
   - **Re-initialize** — wipe existing rules/agents/skills and regenerate (destructive; only if the user explicitly wants a fresh bootstrap)
4. Default to sync. Only proceed to Phase 1 if the user explicitly chooses re-initialize.

---

## Phase 1: Discovery

Explore the codebase to detect:

**Language & Framework** (check for these markers):

| Marker files | Stack |
|---|---|
| `.sln`, `.csproj`, `global.json` | .NET / C# |
| `package.json` | Node.js -- inspect `dependencies` for framework: |
| -- `react`, `react-dom` | React |
| -- `next` | Next.js |
| -- `@angular/core` | Angular |
| -- `vue` | Vue |
| -- `svelte` | Svelte / SvelteKit |
| -- `nuxt` | Nuxt |
| -- `express`, `fastify`, `nestjs`, `hono` | Node.js backend |
| -- `electron` | Electron desktop app |
| -- `react-native`, `expo` | React Native mobile |
| `go.mod` | Go |
| `requirements.txt`, `pyproject.toml`, `setup.py`, `Pipfile` | Python |
| -- `django` in deps | Django |
| -- `fastapi` in deps | FastAPI |
| -- `flask` in deps | Flask |
| `pom.xml` | Java (Maven) |
| `build.gradle`, `build.gradle.kts` | Java/Kotlin (Gradle) |
| `Cargo.toml` | Rust |
| `composer.json` | PHP |
| -- `laravel/framework` in deps | Laravel |
| `Gemfile` | Ruby |
| -- `rails` in deps | Ruby on Rails |
| `mix.exs` | Elixir / Phoenix |
| `pubspec.yaml` | Dart / Flutter |
| `Package.swift` | Swift |
| `*.xcodeproj`, `*.xcworkspace` | iOS / macOS (Xcode) |
| `CMakeLists.txt`, `Makefile` (with `.c`/`.cpp`) | C / C++ |
| `terraform/`, `*.tf` | Terraform (IaC) |
| `pulumi/`, `Pulumi.yaml` | Pulumi (IaC) |
| `helm/`, `Chart.yaml` | Helm charts |
| `docker-compose.yml`, `compose.yaml` | Docker Compose |
| `serverless.yml` | Serverless Framework |
| `deno.json`, `deno.jsonc` | Deno |
| `bun.lockb`, `bunfig.toml` | Bun |

**Project Components** -- identify what this project actually is:

Scan the directory tree and determine which components exist. A project may have one or several:
- Backend API, frontend app, BFF layer
- Infrastructure / deployment configs
- Shared libraries, CLI tools, workers
- Mobile app, documentation site
- Git submodules (check `.gitmodules`)
- Workspace tooling (`pnpm-workspace.yaml`, `lerna.json`, `nx.json`, `turbo.json`)

Describe what you find naturally: "This is a .NET 8 API with a React frontend and Terraform infrastructure" -- not abstract labels.

**Build & Test:**
- Build tools: Makefile, Dockerfile, docker-compose, Taskfile.yml, justfile
- CI: `.github/workflows/`, `.gitlab-ci.yml`, `.circleci/`, `Jenkinsfile`
- Test frameworks, linters, formatters, package managers

**Existing AI Prompt Infrastructure** (CRITICAL -- check all):
- `AGENTS.md`, `CLAUDE.md`, `.cursorrules`
- `.github/copilot-instructions.md`
- `.claude/` directory (rules, agents, skills)
- `.cursor/` directory (rules, agents)
- `.pi/` directory (`settings.json`, `extensions/`, `prompts/`)
- `.opencode/` directory (`opencode.json`, `agents/`)
- `.claude/settings.json`, `.claude/settings.local.json`
- Any sync scripts (`sync.sh`, `sync-to-claude.sh`, etc.)
- `.gitignore` entries for `.claude`, `.cursor`, `.pi`, `.opencode`, `CLAUDE.md`

---

## Phase 2: Present Recommended Setup

Present everything in ONE summary. The user confirms once.

Include these sections:

1. **Components detected**: list with paths
2. **Rules recommended**: N component rules + 1 shared context
3. **Targets to enable**:
   - `agents` is **always enabled** by default — it generates `AGENTS.md` (committed project index consumed by many LLM tools).
   - At least **one IDE adapter** must be enabled. Detect which by scanning for existing tool markers:
     - `.claude/`, `CLAUDE.md`, `.claude/settings.json` -> recommend `claude`
     - `.cursor/`, `.cursorrules` (legacy single-file Cursor format) -> recommend `cursor`
     - `.github/copilot-instructions.md` (legacy Copilot single-file), `.github/instructions/` -> recommend `copilot`
     - `.codex/`, `.agents/` -> recommend `codex`
     - `.pi/`, `.pi/settings.json`, `.pi/extensions/`, `.pi/prompts/` -> recommend `pi`
     - `.opencode/`, `.opencode/opencode.json`, `.opencode/agents/` -> recommend `opencode`
     - If nothing detected, default to `claude` (most common).
     - If the user explicitly names a tool, honor that instead.
   - Present as: "I detected [existing configs]. I will enable: `agents` + `<detected IDE>`. Other adapters (Claude, Cursor, Copilot, Codex, Pi, opencode) can be added any time via `/intelligence-install-adapter`."
4. **Agents recommended**: list with tier/access
5. **Skills recommended**: pre-installed + migrated + new suggestions (see Phase 3.5)
6. **Conventions detected**: key patterns from codebase
7. **Submodules** (if found): recommend excluding
8. **Migration** (only if existing AI infrastructure found): conflict report with file counts:
   ```
   WILL BE OVERWRITTEN: .claude/rules/ (N files), .cursor/rules/ (N files), etc.
   WILL BE PRESERVED: .claude/settings.local.json, .claude/settings.json
   NEEDS MIGRATION: CLAUDE.md, .cursorrules, existing skills/commands
   ```

End with:

> **Accept** to proceed (backup + migrate + generate), or **Cancel** to stop.

If **Cancel** -- stop completely. intelligence-sync cannot coexist with manually managed IDE prompts.

If **Accept** -- execute migration (if needed), then generate.

### Migration (only if existing AI infrastructure found)

1. **Backup:** Create `intelligence/_backup/`, move (not copy) all existing AI files. Add `intelligence/_backup/` to `.gitignore`.
2. **Migrate** to tool-agnostic format:
   - `.claude/rules/*.md` -- copy as-is
   - `.cursor/rules/*.mdc` -- rename `.md`, `globs:` -> `paths:`, remove `alwaysApply:`
   - `.github/copilot-instructions.md`, `.cursorrules` -- split by topic
   - `.claude/agents/*.md` -- reverse: `model:` -> `tier:`, remove IDE fields, add `access:`
   - `.cursor/agents/*.md` -- reverse: `model: fast` -> `tier: standard`, `readonly:` -> `access:`
   - `.claude/skills/*/SKILL.md`, `.cursor/skills/*/SKILL.md`, `.claude/commands/*.md`, `.cursor/commands/*.md` -- copy as skills
3. **Cleanup:** `git rm` tracked files, `rm` untracked. Remove empty directories.
4. **Post-migration validation** (CRITICAL -- do not skip):
   - Build a list of the paths that were removed/renamed (e.g., `dev/scripts/`, `dev/prompts/`, `.cursorrules`, `.claude/rules/`, old directory names).
   - Run `git ls-files` to enumerate every tracked file in the repository (no whitelist -- references to old paths live in `README.md`, scripts, config files, wikis, workflow YAML, not just `docs/`).
   - For each tracked file, grep for each removed path. Record findings.
   - For unambiguous replacements (e.g., `dev/scripts/sync-to-claude.sh` -> `intelligence/sync/scripts/sync.sh`), patch the file automatically.
   - For ambiguous references (path removed without a clear successor, references inside narrative prose, references to scripts that no longer exist), print them to the user grouped by file with line numbers and ask how to resolve.
   - Do not proceed to Phase 3 generation until stale references are resolved or explicitly deferred by the user.

### Files we NEVER touch

- `.claude/settings.local.json`, `.claude/settings.json`
- `.git/`
- Anything outside AI prompt scope

---

## Phase 3: Generate

**Principles:**
1. **Adopt, don't impose.** Use the repo's existing directory names and casing conventions.
2. **Derive from code, not general knowledge.** Read actual source files. Extract real patterns, real commands, real examples. Every FORBIDDEN/REQUIRED rule must be backed by something you observed in the codebase. Do not generate generic best-practice rules.
3. **Agents must reflect reality.** Read existing implementations to determine expertise, architecture patterns, and build commands. If you cannot verify a pattern exists in the code, do not include it.

### 3.1 `intelligence/config.yaml`

Set `sync_version` to the engine version — read it verbatim from
`intelligence/sync/scripts/VERSION`. This is a **managed contract key**: emit
it on first bootstrap and **preserve its existing value if `config.yaml`
already has one** when re-bootstrapping (never drop or guess it — the update
flow owns its value).

```yaml
project:
  name: "project-name"

# Managed by intelligence-sync — applied schema version. Do not hand-edit;
# preserve on re-bootstrap. (Value = intelligence/sync/scripts/VERSION.)
sync_version: "0.5.0"

sources:
  rules:
    - "intelligence/rules"
  agents:
    - "intelligence/agents"
  skills:
    - "intelligence/skills"
    - "intelligence/sync/skills"

targets:
  # agents: ALWAYS enabled — generates committed AGENTS.md as the
  # canonical project doc. Always-on rules (no `paths:`) are inlined
  # automatically; path-scoped rules stay in tool-specific channels
  # (.cursor/rules/, .github/instructions/) for monorepo scoping.
  agents:
    enabled: true
    output: "AGENTS.md"
    header: |
      # <Project Name>

      <one-line stack summary — e.g., ".NET 8 API + React 19 | Azure | Phase: MVP">

      **Full context**: [`intelligence/rules/context.md`](intelligence/rules/context.md)
  # At least one IDE adapter — pick based on detection or user preference
  claude: { enabled: true, output: ".claude" }
  # Optional adapters: cursor, copilot, codex, pi, opencode
  # pi: { enabled: false, output: ".pi" }
  # opencode: { enabled: false, output: ".opencode" }

ignore:
  - "node_modules"
  - "vendor"
  - "dist"

# Optional: override per-IDE tier -> model mappings. Defaults live in
# intelligence/sync/scripts/lib/common.sh. Add only the entries you want to
# pin; everything else uses the current default.
# Example:
# models:
#   copilot:
#     heavy: "gpt-5.5"
```

The `agents.header` block is the only hand-authored part of `AGENTS.md`. Everything else (tables for agents/skills, list of rules) is regenerated from frontmatter on every sync. Keep the header to 3–5 lines: project name, one-liner stack summary, link to `context.md`.

Engine scripts (under `intelligence/sync/scripts/`):

- `sync.sh` — generate IDE outputs from `intelligence/`
- `update.sh` — pull latest scripts/INIT.md from upstream without touching project content
- `lib/common.sh` — shared helpers (`get_model`, `lint_frontmatter`, frontmatter parsers, etc.)

Built-in adapters:

| Target | Adapter | Output | Notes |
|--------|---------|--------|-------|
| `agents` | `agents.sh` | `AGENTS.md` | Committed; canonical project doc with inlined always-on rules |
| `claude` | `claude.sh` | `.claude/` | Full rule copy (Claude does not read AGENTS.md) |
| `cursor` | `cursor.sh` | `.cursor/` | Path-scoped rules only (always-on come from AGENTS.md) |
| `copilot` | `copilot.sh` | `.github/` | Path-scoped rules only; shares dir with workflows |
| `codex` | `codex.sh` | `.agents/skills/` + `.codex/agents/` | Reads AGENTS.md for context |
| `pi` | `pi.sh` | `.pi/` + `.agents/skills/` | Reads AGENTS.md for always-on context; generated extension surfaces scoped rules; agents become prompt templates |
| `opencode` | `opencode.sh` | `.opencode/` + `.agents/skills/` | Reads AGENTS.md natively; agents become markdown subagents (`.opencode/agents/<name>.md`); skills via `.agents/skills/`; no scoped-rules emission (users may opt in via `instructions:` globs in `opencode.json`) |

### 3.2 `intelligence/rules/context.md`

Always-loaded context (no `paths:` in frontmatter):
- Project name and description
- Repository structure
- Build and test commands
- Global rules (naming, formatting, forbidden patterns)

### 3.3 Component-specific rules

One rule per component, scoped with `paths:` frontmatter:
- REQUIRED patterns (positive defaults — what to do, judgment calls)
- Invariants (true must-nots: safety, output format, security — never judgment calls)
- Architecture patterns
- Component-specific build/test commands
- Code examples from the actual codebase
- Patterns to recognize and replace (optional — anti-patterns documented as reference with positive replacements; documentation, not LLM instruction)

### 3.4 Agents

**Developer agents** (tier: heavy, access: full) -- one per distinct stack:
- Expertise based on detected patterns, "Before Any Task" checklist, build/verify commands
- "Before Any Task" must reference the domain rules file: "Read `intelligence/rules/<domain>.md` before starting"
- Link relevant skills via `skills:` in frontmatter

**Code reviewer** (tier: standard, access: readonly):
- Review criteria per component, output format
- Link review skills if created (e.g., `<domain>-review-` skills)

### 3.5 Skills

Pre-installed skills:
- `/intelligence-sync` — sync to all enabled IDE targets
- `/intelligence-install-adapter` — enable an IDE target
- `/intelligence-uninstall-adapter` — disable an IDE target
- `/intelligence-add-skill` — create new skill with conventions
- `/intelligence-add-agent` — create new agent with conventions
- `/intelligence-add-rule` — create new rule with conventions

**Proactively suggest domain skills** based on detected stack. Analyze the codebase for repeatable multi-file patterns and propose skills. Look for operations that touch 3+ files in a predictable pattern.

Common skill categories (suggest what applies to this repo):

**Atomic (`add-`)** — creates/updates a single artifact:
- `<domain>-add-entity` — new domain model with all required files
- `<domain>-add-endpoint` — new API endpoint/route with handler
- `<domain>-add-page` — new page/view with routing
- `<domain>-add-component` — new UI component with tests
- `<domain>-add-service` — new service/client with types
- `<domain>-add-migration` — database schema change
- `<domain>-add-modal` — dialog/modal with form
- `<domain>-add-tests` — unit/integration tests for existing code
- `<domain>-add-e2e-tests` — end-to-end tests for feature

**Orchestrator (`create-`)** — invokes multiple add- skills. MUST use `create-` prefix, never `add-`:
- `<domain>-create-feature` — full feature from spec (entity + endpoint + page + tests)
- `<domain>-create-crud` — complete CRUD for single entity

**Modifier (`update-`)** — changes across existing files:
- `<domain>-update-feature` — add/remove/modify fields across stack

**Execution (`run-`)** — runs operations:
- `<domain>-run-tests` — run and analyze test results
- `<domain>-run-lint` — run linter and fix issues

**Review (`review-`)** — read-only analysis:
- `<domain>-review-pending-changes` — review before commit
- `intelligence-review-rules` — check rules match actual codebase

Present the suggested list to the user. They choose which to create now. Remind them skills can be added any time with `/intelligence-add-skill` (or manually).

Each skill must have 3+ concrete, repeatable steps derived from actual codebase patterns. Do not create skills for one-off operations.

### 3.6 `.gitignore`

Add (if not present):
```
# AI IDE tools (generated by intelligence-sync)
CLAUDE.md
.cursorrules
.agents/
.codex/

# Pi: generated prompt templates, scoped-rule extension, and copied rule files.
# Keep .pi/settings.json and any hand-authored extensions/prompts outside these
# paths tracked if you want to share them.
.pi/intelligence-sync/
.pi/extensions/intelligence-sync-rules.ts
.pi/prompts/intelligence-agent-*.md

# opencode: only the generated subagents and slash commands are owned by the adapter.
# Keep .opencode/opencode.json (and any hand-authored config) tracked.
.opencode/agents/
.opencode/commands/

# Claude Code: ignore everything except project-shared settings.
# This catches generated subdirs (rules/, skills/, agents/) plus any
# per-machine state Claude writes (settings.local.json, *.lock,
# scheduled_tasks.*, sessions/, cache/, etc.) without us having to
# enumerate every filename Claude may add in the future.
.claude/*
!.claude/settings.json

# Cursor: same pattern.
.cursor/*
!.cursor/settings.json
```

Notes:
- `.github/` and `AGENTS.md` are intentionally NOT gitignored — they contain shared content.
- Only `.claude/settings.json` and `.cursor/settings.json` are tracked by default — they hold project-shared IDE settings (allowed bash commands, tool permissions). Everything else under those directories is either generated by sync or per-user state.
- The Pi adapter writes only three generated paths: `.pi/intelligence-sync/`, `.pi/extensions/intelligence-sync-rules.ts`, and `.pi/prompts/intelligence-agent-*.md`. It does NOT own `.pi/settings.json` or any other `.pi/extensions/*.ts` / `.pi/prompts/*.md` files.
- The opencode adapter writes only `.opencode/agents/` (one markdown subagent per source agent) and `.opencode/commands/` (one slash command per source skill, mirroring Claude Code's skill-as-command UX). It does NOT own `.opencode/opencode.json` or any other `.opencode/*` files — those remain hand-authored and tracked. Generated command files carry an `<!-- Generated by intelligence-sync. Do not edit manually. -->` marker; only marker-bearing files are removed on re-sync, so any hand-authored command in `.opencode/commands/` survives.
- If you need to track another file under `.claude/` or `.cursor/` (e.g., `.claude/commands/<name>.md` for a hand-authored command), add another `!path` un-ignore line below.

### 3.7 `AGENTS.md` (auto-generated by `agents.sh`)

`AGENTS.md` is produced by the `agents` adapter on every sync. It is NOT hand-authored. Do not create this file yourself in Phase 3 -- it will be generated in Phase 4 by `intelligence/sync/scripts/sync.sh`.

Your job in Phase 3 is to fill `targets.agents.header` in `config.yaml` (see 3.1) with a 3-5 line project summary: title, stack one-liner, link to `intelligence/rules/context.md`. The adapter appends auto-built tables for agents/skills and a list of rules after the header.

The file is committed (not gitignored) but carries a `<!-- Generated ... do not edit manually -->` marker. All regeneration happens via `bash intelligence/sync/scripts/sync.sh`.

### 3.8 `CLAUDE.md` (if Claude enabled)

Gitignored user preferences:
- Response language
- Setup: `intelligence/sync/scripts/sync.sh`
- Helper scripts, git commit rules

---

## Phase 4: Verify

1. Run `intelligence/sync/scripts/sync.sh`
2. If sync fails -- read the error, fix the cause (usually missing directory or malformed frontmatter), retry
3. Verify output counts match expectations
4. Report to user:
   - Files created (rules, agents, skills)
   - Sync results per target
   - **Enabled targets**: list what was configured (e.g., "claude, cursor, copilot")
   - **Available but not enabled**: list remaining adapters (e.g., "codex, pi, opencode — enable via `/intelligence-install-adapter <name>`")
   - **Available skills**: list all (pre-installed + generated)
   - "To add rules/agents/skills: `/intelligence-add-rule`, `/intelligence-add-agent`, `/intelligence-add-skill`"
   - "After manual edits: `/intelligence-sync` to re-sync"

---

## Reference

### Frontmatter

**YAML safety (required):** **always wrap `description` and any other free-text string field in double quotes**, even when no special characters are present. Codex CLI uses strict YAML — an unquoted colon, hyphen, or word that parses as boolean (`yes`, `no`) silently breaks the file. Quoting unconditionally removes a whole class of bugs and makes lint trivial. If the value itself contains a double quote, escape it as `\"` or wrap the value in single quotes — an unescaped inner quote terminates the scalar early. The sync engine auto-escapes inner quotes when it quotes a value, as a backstop.

**Agent:**
```yaml
---
name: agent-name
description: "When to use this agent"
tier: heavy|standard|light       # heavy=opus, standard=sonnet, light=haiku
access: full|readonly            # full=all tools, readonly=no write/edit
skills:                          # optional: skills this agent can invoke
  - domain-add-something
  - domain-run-tests
---
```

**Rule:**
```yaml
---
paths:                           # omit for always-loaded rules
  - "src/backend/**"
---
```

**Skill:**
```yaml
---
name: domain-verb-noun
description: "What the skill does"
argument-hint: <arg1> [arg2]     # optional
agent: agent-name                # optional: which agent executes this skill
---
```

### Content structure

**Rule body:** REQUIRED -> Invariants -> Architecture -> Build & Test -> Examples (from actual codebase) -> Patterns to recognize and replace (optional reference section)

- Lead with REQUIRED (positive defaults / judgment calls)
- Reserve **Invariants** for true must-nots — safety, output format, security
- **Patterns to recognize and replace** is reference documentation of anti-patterns with their positive replacement, not LLM instructions

**Agent body:** Expertise -> Before Any Task (reference rules to read) -> Build & Verify

**Skill body:** Steps (numbered, concrete, with verification at the end). Orchestrator skills (`<domain>-create-`) reference atomic skills (`<domain>-add-`) by name.

### Skill naming

Prefix with domain: `backend-`, `frontend-`, `devops-`, `intelligence-`, etc.

| Prefix | Type |
|--------|------|
| `<domain>-add-` | Creates a single artifact |
| `<domain>-create-` | Orchestrates multiple `add-` skills |
| `<domain>-run-` | Runs an operation |
| `<domain>-review-` | Analyzes without changes |

---

intelligence-sync is created by [Ainova Systems](https://www.ainovasystems.com). MIT License.
