# intelligence-sync: Writing a New Adapter

## Overview

An adapter transforms source prompts (from `intelligence/`) into an IDE-specific format. Each adapter is a single bash file in `intelligence/sync/scripts/adapters/`.

## Quick Start

1. Copy `intelligence/sync/scripts/adapters/_template.sh` to `intelligence/sync/scripts/adapters/<name>.sh`
2. Replace `<name>` placeholders with your adapter name
3. Implement the `sync_to_<name>()` function
4. Add target to `config.yaml`:
   ```yaml
   targets:
     <name>: { enabled: true, output: ".<name>" }
   ```
5. Run `bash intelligence/sync/scripts/sync.sh <name>` to test

## Adapter Contract

### Required Function

```bash
sync_to_<name>(repo_root, config_file, output_dir)
```

This is called by `sync.sh` for each enabled target.

Parameters:
- `repo_root` -- absolute path to the project root
- `config_file` -- absolute path to `config.yaml`
- `output_dir` -- absolute path to output directory (e.g., `/project/.cursor`)

### Available Library Functions

Source `lib/common.sh` for these utilities:

| Function | Description |
|----------|-------------|
| `normalize_file_to_lf(file)` | Convert CRLF to LF |
| `lint_frontmatter(file)` | Warn about unquoted colons, leading tabs, and literal double quotes inside unquoted values (stderr) |
| `get_frontmatter_value(key, file)` | Extract YAML frontmatter value |
| `has_frontmatter(file)` | Check for `---` header |
| `has_paths(file)` | Check for `paths:` field |
| `get_model(config, ide, tier)` | Resolve model from `models:` override or default |
| `get_model_default(ide, tier)` | Hardcoded default for `<ide>:<tier>` |
| `map_access_to_claude_tools(access)` | Tool string for access level |
| `map_access_to_claude_disallowed(access)` | Disallowed tools string |
| `read_yaml_list(config, section)` | Read list from `config.yaml` |
| `resolve_source_dir(repo_root, src)` | Map a source entry to a local dir — `"$repo_root/$src"`, or a shallow clone for a remote `git+<url>` spec |
| `source_is_remote(src)` | True (0) if a source entry is a remote `git+` spec |
| `get_target_field(config, target, field)` | Read a field from a target's config block |

### Transformation Patterns

Each adapter handles three prompt types. Here's how the built-in adapters approach each:

**Rules:**

intelligence-sync routes rule content based on **scope** (always-on vs path-scoped) and on which channels each IDE actually reads, to avoid duplicating content into multiple places.

| Source | `agents` (AGENTS.md) | `claude` | `cursor` | `copilot` | `codex` | `pi` | `opencode` |
|--------|----------------------|----------|----------|-----------|---------|------|------------|
| Always-on (no `paths:`) | inlined as canonical | copied as-is | skipped (Cursor reads AGENTS.md) | skipped (Copilot reads AGENTS.md) | skipped (Codex reads AGENTS.md) | skipped (Pi reads AGENTS.md) | skipped (opencode reads AGENTS.md) |
| Path-scoped (with `paths:`) | listed by name only | copied as-is | `paths:` → `globs:` in `.mdc` | `paths:` → `applyTo:` in `.instructions.md` | not supported by Codex | copied to `.pi/intelligence-sync/rules/` + surfaced by generated extension | not supported (opencode has no native scoping; users may opt in via `instructions:` globs in `opencode.json`) |
| Listing | full table in AGENTS.md | n/a | n/a | n/a | n/a | extension prompt snippet | n/a |

**Skills:**

Skills follow the [Agent Skills open standard](https://agentskills.io). All supported tools read `SKILL.md` directly — no semantic transformation needed.

| Pattern | Used by | Output location |
|---------|---------|-----------------|
| Copy SKILL.md dirs as-is | Claude, Cursor, Copilot, Codex, Pi, opencode | `.claude/skills/`, `.cursor/skills/`, `.github/skills/`, `.agents/skills/` (shared by Codex, Pi, opencode) |

**Agents:**

| Pattern | Used by |
|---------|---------|
| Transform frontmatter | Claude (`tier`→`model` via `get_model`, `access`→`tools`/`disallowedTools`), Cursor (`tier`→`model` via `get_model`, `access: readonly`→`readonly: true`) |
| Transform to `.agent.md` | Copilot (`tier`→`model`, `access: readonly`→restricted `tools` array) |
| Transform to `.toml` | Codex (`name`, `description`, `model`, `model_reasoning_effort` from tier, `sandbox_mode` from access, `developer_instructions`) |
| Transform to prompt template | Pi (`.pi/prompts/intelligence-agent-<name>.md`; `readonly` becomes prompt guidance, `full` stays implicit) |
| Transform to markdown subagent | opencode (`.opencode/agents/<name>.md`; `mode: subagent`, `model` from tier via `get_model`, `permission.edit`/`permission.bash` from access) |

Model names come from `get_model(config_file, ide, tier)` in `lib/common.sh`. Defaults are baked into `get_model_default()`; users override per-IDE/tier under `models:` in `config.yaml`. Sync prints a drift report when an override no longer matches the current default.

### Cleanup Contract

Every adapter MUST follow these rules to stay safe alongside others:

1. **Clean only adapter-owned subpaths.** Never `rm -rf "$output_dir"` — users hand-author siblings (`.claude/settings.json`, `.cursor/settings.json`, `.pi/settings.json`, `.opencode/opencode.json`, project-specific commands and extensions). Mirror `claude.sh` (deletes only `rules/`, `agents/`, and per-skill subdirs), `pi.sh` (deletes only `.pi/intelligence-sync/`, the named extension file, and `intelligence-agent-*.md` prompt files), or `opencode.sh` (deletes only `.opencode/agents/` wholesale, and inside `.opencode/commands/` only files that carry the `<!-- Generated by intelligence-sync. Do not edit manually. -->` marker — hand-authored sibling commands survive).
2. **Use shared helpers for shared dirs.** `.agents/skills/` is read by Codex, Pi, opencode, and any tool implementing the [Agent Skills open standard](https://agentskills.io). All adapters writing there must call `sync_open_skill_dirs`, which owns the full lifecycle (clean per-skill subfolders, recreate the dir, populate). Do NOT duplicate the clean / `mkdir -p` in the adapter — calling sites become divergent and one adapter inevitably drifts.
3. **Document owned paths in `.gitignore`.** Each adapter's INIT.md `.gitignore` block lists exactly the paths it writes — no broader. This lets users keep hand-authored content under the same root tracked.

## Example: Minimal Adapter

```bash
#!/bin/bash
source "$(dirname "$0")/../lib/common.sh"

sync_to_myide() {
    local repo_root="$1"
    local config_file="$2"
    local output_dir="$3"

    echo "=== MyIDE ==="
    mkdir -p "$output_dir/rules"

    # Copy rules, strip frontmatter
    while IFS= read -r src; do
        [ -z "$src" ] && continue
        # resolve_source_dir maps a source entry to a local dir: "$repo_root/$src"
        # for a local path, or a shallow clone for a remote `git+<url>` spec.
        local dir
        dir="$(resolve_source_dir "$repo_root" "$src")"
        [ -d "$dir" ] || continue
        for f in "$dir"/*.md; do
            [ -f "$f" ] || continue
            awk '
                BEGIN { in_fm=0; past_fm=0 }
                { sub(/\r$/, "") }
                /^---$/ {
                    if (!past_fm) { in_fm = !in_fm; if (!in_fm) { past_fm=1 }; next }
                }
                past_fm || !in_fm { print }
            ' "$f" > "$output_dir/rules/$(basename "$f")"
            normalize_file_to_lf "$output_dir/rules/$(basename "$f")"
        done
    done < <(read_yaml_list "$config_file" "rules")
}
```

## Testing

Test your adapter by creating a temporary project with `config.yaml` and running:

```bash
REPO_ROOT=/path/to/test/project bash intelligence/sync/scripts/sync.sh <name>
```

Verify the output directory contains correctly transformed files. The sync entry point also runs `lint_frontmatter` over every source file before adapters fire — unquoted YAML colons and leading tabs surface as warnings on stderr.

## Distributing changes

When you ship a new adapter, downstream projects pick it up by running:

```bash
bash intelligence/sync/scripts/update.sh
```

`update.sh` clones the upstream repo into a `mktemp -d` directory, shows the diff for `intelligence/sync/scripts/` and `intelligence/sync/INIT.md`, and prompts before overwriting. Project content (`config.yaml`, `rules/`, `agents/`, `skills/`) is never touched. Pass `--yes` for non-interactive runs; set `REPO_URL=<fork>` to use a fork.

## Built-in Adapters Reference

| Adapter | Output | Rules | Skills | Agents |
|---------|--------|-------|--------|--------|
| `agents.sh` | `AGENTS.md` (committed) | Always-on inlined; scoped listed | Listed in table | Listed in table |
| `claude.sh` | `.claude/` | Copy as-is (Claude does not read AGENTS.md) | SKILL.md dirs | tier/access → model/tools |
| `cursor.sh` | `.cursor/` | Scoped only → `.mdc` + globs | Copy as-is | tier → model |
| `copilot.sh` | `.github/` | Scoped only → `.instructions.md` | SKILL.md dirs | `.agent.md` |
| `codex.sh` | `.codex/` + `.agents/skills/` | None (AGENTS.md handles) | SKILL.md dirs in `.agents/skills/` | `.toml` in `.codex/agents/` |
| `pi.sh` | `.pi/` + `.agents/skills/` | Scoped rules copied + listed by generated extension; always-on via AGENTS.md | SKILL.md dirs in `.agents/skills/` | prompt templates in `.pi/prompts/` |
| `opencode.sh` | `.opencode/` + `.agents/skills/` | None (AGENTS.md handles always-on; opencode has no native scoping) | SKILL.md dirs in `.agents/skills/`; one slash command per skill in `.opencode/commands/<name>.md` (marker-protected) | markdown subagents in `.opencode/agents/` |

### Notes on `agents.sh`

Unlike IDE adapters, `agents.sh` emits a single committed markdown file intended for humans and generic LLM tooling. It reads a static `header` block from `config.yaml` (under `targets.agents.header`) and appends auto-generated tables (agents, skills) and a list of rules derived from frontmatter. The output carries a "do not edit manually" marker and is regenerated on every sync.

#### Why AGENTS.md inlines always-on rules

AGENTS.md is the canonical project doc — Cursor, Copilot, Codex, Pi, and opencode read it natively. Always-on rule content is inlined automatically so all five tools see the same context from one source. Path-scoped rules are NOT inlined (would balloon AGENTS.md in monorepos); they live in tool-specific channels with native scoping (`.cursor/rules/*.mdc` with `globs:`, `.github/instructions/*.instructions.md` with `applyTo:`) or, for Pi, in generated on-demand rule files surfaced by a small extension. opencode has no first-class path-scoped channel; users who need scoped rules can opt into them via `instructions:` globs in `opencode.json`.

Claude Code does not read AGENTS.md natively (per [open feature request](https://github.com/anthropics/claude-code/issues/6235)) — its adapter copies all rules into `.claude/rules/`. There is no duplication because Claude does not consume AGENTS.md.
