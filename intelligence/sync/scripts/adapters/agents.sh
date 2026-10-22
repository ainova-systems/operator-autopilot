#!/bin/bash
# intelligence-sync: AGENTS.md adapter
# Generates a committed project-index document that lists all agents, skills,
# and rules discovered from intelligence/ sources.
#
# Output: AGENTS.md at repo root (or wherever targets.agents.output points)
# Header: static text from config.yaml targets.agents.header (block scalar)
# Body:   auto-built tables/lists from frontmatter of rules/agents/skills
#
# Unlike other adapters, the output is a single committed markdown file
# meant to be read by both humans and LLMs. It must never be hand-edited —
# every sync regenerates it from scratch.

source "$(dirname "${BASH_SOURCE[0]}")/../lib/common.sh"

# Repo-relative paths to the umbrella folder and the engine module, DERIVED —
# never hardcoded. The umbrella is named by the project (`intelligence/`,
# `Intelligence/`, a codename) and the engine lives in a module inside it;
# detect_layout resolved both before any adapter ran. A literal path here would
# print a sync command that does not exist, and would be wrong outright on a
# case-sensitive filesystem — in the one document Cursor, Copilot and Codex all
# read as canonical.
# sync.sh exports both as layout tokens; recompute only when an adapter is
# driven directly (tests), never assume a folder name.
agents_md_umbrella_rel() {
    local repo_root="$1" rel="${IS_UMBRELLA_REL:-}"
    [ -n "$rel" ] || rel="$(repo_rel_dir "$repo_root" "${LS_UMBRELLA_DIR:-$repo_root/intelligence}")"
    printf '%s' "${rel:-intelligence}"
}

agents_md_module_rel() {
    local repo_root="$1" rel="${IS_MODULE_REL:-}"
    [ -n "$rel" ] || rel="$(repo_rel_dir "$repo_root" "${LS_MODULE_DIR:-$repo_root/intelligence/sync}")"
    printf '%s' "${rel:-intelligence/sync}"
}

# Append the static header block from config.yaml (or a fallback).
agents_md_append_header() {
    local output="$1"
    local config_file="$2"

    local header
    header=$(get_target_block "$config_file" "agents" "header")

    if [ -n "$header" ]; then
        printf '%s\n' "$header" >> "$output"
    else
        local project_name
        project_name=$(get_project_name "$config_file")
        echo "# ${project_name:-Project}" >> "$output"
    fi
    echo "" >> "$output"
}

agents_md_append_agents_table() {
    local repo_root="$1"
    local config_file="$2"
    local output="$3"

    local rows=""
    local count=0

    while IFS= read -r src; do
        [ -z "$src" ] && continue
        local dir
        dir="$(resolve_source_dir "$repo_root" "$src")"
        [ -d "$dir" ] || continue
        # Byte-order (LC_ALL=C) sort so generated output is identical across
        # platforms — bash glob order follows LC_COLLATE, which differs between
        # Linux CI (UTF-8, ignores `-`) and Git Bash (C, byte order).
        while IFS= read -r f; do
            [ -f "$f" ] || continue
            local name rel tier access desc
            name="$(basename "$f" .md)"
            rel="$(repo_rel_link "$repo_root" "$f")"
            tier=$(get_frontmatter_value "tier" "$f")
            access=$(get_frontmatter_value "access" "$f")
            desc=$(get_frontmatter_value "description" "$f")
            if [ -n "$rel" ]; then
                rows+="| [$name]($rel) | ${tier:--} | ${access:--} | ${desc:--} |"$'\n'
            else
                rows+="| $name | ${tier:--} | ${access:--} | ${desc:--} |"$'\n'
            fi
            count=$((count + 1))
        done < <(find "$dir" -maxdepth 1 -type f -name '*.md' -print | LC_ALL=C sort)
    done < <(read_yaml_list "$config_file" "agents")

    [ "$count" -eq 0 ] && return 0

    {
        echo "### Agents"
        echo ""
        echo "| Agent | Tier | Access | Description |"
        echo "|-------|------|--------|-------------|"
        printf '%s' "$rows"
        echo ""
    } >> "$output"

    echo "  agents: $count listed"
}

agents_md_append_skills_table() {
    local repo_root="$1"
    local config_file="$2"
    local output="$3"

    local rows=""
    local count=0

    while IFS= read -r src; do
        [ -z "$src" ] && continue
        local dir
        dir="$(resolve_source_dir "$repo_root" "$src")"
        [ -d "$dir" ] || continue
        # Byte-order (LC_ALL=C) sort so generated output is identical across
        # platforms — see the note in agents_md_append_agents_table.
        while IFS= read -r skill_dir; do
            [ -d "$skill_dir" ] || continue
            local dirname
            dirname="$(basename "$skill_dir")"
            case "$dirname" in _*) continue ;; esac
            local skill_file="${skill_dir%/}/SKILL.md"
            [ -f "$skill_file" ] || continue
            local rel desc
            rel="$(repo_rel_link "$repo_root" "$skill_file")"
            desc=$(get_frontmatter_value "description" "$skill_file")
            if [ -n "$rel" ]; then
                rows+="| [$dirname]($rel) | ${desc:--} |"$'\n'
            else
                rows+="| $dirname | ${desc:--} |"$'\n'
            fi
            count=$((count + 1))
        done < <(find "$dir" -mindepth 1 -maxdepth 1 -type d -print | LC_ALL=C sort)
    done < <(read_yaml_list "$config_file" "skills")

    [ "$count" -eq 0 ] && return 0

    {
        echo "### Skills"
        echo ""
        echo "| Skill | Description |"
        echo "|-------|-------------|"
        printf '%s' "$rows"
        echo ""
    } >> "$output"

    echo "  skills: $count listed"
}

agents_md_append_rules_list() {
    local repo_root="$1"
    local config_file="$2"
    local output="$3"

    local lines=""
    local count=0
    local global_rule_files=()

    while IFS= read -r src; do
        [ -z "$src" ] && continue
        local dir
        dir="$(resolve_source_dir "$repo_root" "$src")"
        [ -d "$dir" ] || continue
        # Byte-order (LC_ALL=C) sort so generated output — and the inline order
        # of always-on rules below — is identical across platforms. See the
        # note in agents_md_append_agents_table.
        while IFS= read -r f; do
            [ -f "$f" ] || continue
            local name rel scope
            name="$(basename "$f" .md)"
            rel="$(repo_rel_link "$repo_root" "$f")"
            scope="global"
            if [ "$(has_paths "$f")" != "0" ]; then
                scope="scoped"
            else
                global_rule_files+=("$f")
            fi
            if [ -n "$rel" ]; then
                lines+="- [$name]($rel) ($scope)"$'\n'
            else
                lines+="- $name ($scope)"$'\n'
            fi
            count=$((count + 1))
        done < <(find "$dir" -maxdepth 1 -type f -name '*.md' -print | LC_ALL=C sort)
    done < <(read_yaml_list "$config_file" "rules")

    [ "$count" -eq 0 ] && return 0

    {
        echo "### Rules"
        echo ""
        printf '%s' "$lines"
        echo ""
    } >> "$output"

    echo "  rules: $count listed"

    # Always-on rules (no `paths:`) are inlined into AGENTS.md as canonical
    # project context. Codex (only reads AGENTS.md) and Cursor/Copilot
    # (read AGENTS.md natively) all pick up rule content from here.
    # Path-scoped rules stay in tool-specific channels (.cursor/rules/,
    # .github/instructions/) so monorepo scoping is preserved.
    if [ "${#global_rule_files[@]}" -gt 0 ]; then
        local umbrella_rel
        umbrella_rel="$(agents_md_umbrella_rel "$repo_root")"
        {
            echo "---"
            echo ""
            echo "## Project Context"
            echo ""
            echo "<!-- Inlined from always-on rules in $umbrella_rel/rules/ -->"
            echo ""
        } >> "$output"
        local rf
        for rf in "${global_rule_files[@]}"; do
            awk '
                BEGIN { in_fm=0; past_fm=0 }
                { sub(/\r$/, "") }
                /^---$/ {
                    if (!past_fm) { in_fm = !in_fm; if (!in_fm) { past_fm=1 }; next }
                }
                past_fm || !in_fm { print }
            ' "$rf" >> "$output"
            echo "" >> "$output"
        done
        echo "  rules: ${#global_rule_files[@]} global rule(s) inlined"
    fi
}

# Main entry point for AGENTS.md adapter
sync_to_agents() {
    local repo_root="$1"
    local config_file="$2"
    local output_dir="$3"

    echo "=== AGENTS.md ==="

    # output_dir points at the target file path (e.g., /repo/AGENTS.md).
    # If it looks like a directory (trailing slash, existing dir, or no .md
    # extension), append default filename.
    local output_file="$output_dir"
    if [ -d "$output_file" ] || [[ "$output_file" == */ ]] || [[ "$output_file" != *.md ]]; then
        output_file="${output_file%/}/AGENTS.md"
    fi

    mkdir -p "$(dirname "$output_file")"

    local umbrella_rel module_rel
    umbrella_rel="$(agents_md_umbrella_rel "$repo_root")"
    module_rel="$(agents_md_module_rel "$repo_root")"

    # These two strings are written into a COMMITTED file. An absolute path here
    # means the derivation failed, and a machine-specific path in AGENTS.md is
    # worse than a failed sync — fail loudly instead.
    case "$umbrella_rel$module_rel" in
        /*|*:[\\/]*)
            echo "  ERROR: AGENTS.md paths did not resolve relative to the repo root:" >&2
            echo "         umbrella='$umbrella_rel' module='$module_rel' repo_root='$repo_root'" >&2
            return 1
            ;;
    esac

    {
        echo "<!-- Generated by intelligence-sync. Do not edit manually. -->"
        echo "<!-- Source: $umbrella_rel/ | Sync: bash $module_rel/scripts/sync.sh -->"
        echo ""
    } > "$output_file"

    agents_md_append_header "$output_file" "$config_file"

    {
        echo "## Intelligence"
        echo ""
        echo "Source of truth: \`$umbrella_rel/\` | Sync: \`bash $module_rel/scripts/sync.sh\`"
        echo ""
    } >> "$output_file"

    agents_md_append_agents_table "$repo_root" "$config_file" "$output_file"
    agents_md_append_skills_table "$repo_root" "$config_file" "$output_file"
    agents_md_append_rules_list  "$repo_root" "$config_file" "$output_file"

    finalize_output_file "$output_file"

    # Safety net: AGENTS.md is committed, so it must never carry an absolute or
    # transient link target (remote-pack content lives under the run cache). If
    # relativization ever fails, fail the sync loudly rather than write a
    # machine-specific path into version control.
    if grep -nE '\]\((/|[A-Za-z]:[\\/])' "$output_file" >/dev/null 2>&1; then
        echo "  ERROR: AGENTS.md has an absolute link target — relativization failed:" >&2
        grep -nE '\]\((/|[A-Za-z]:[\\/])' "$output_file" >&2
        return 1
    fi

    echo "  -> ${output_file#$repo_root/}"
}
