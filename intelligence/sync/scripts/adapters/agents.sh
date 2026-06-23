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
        for f in "$dir"/*.md; do
            [ -f "$f" ] || continue
            local name rel tier access desc
            name="$(basename "$f" .md)"
            rel="${f#$repo_root/}"
            tier=$(get_frontmatter_value "tier" "$f")
            access=$(get_frontmatter_value "access" "$f")
            desc=$(get_frontmatter_value "description" "$f")
            rows+="| [$name]($rel) | ${tier:--} | ${access:--} | ${desc:--} |"$'\n'
            count=$((count + 1))
        done
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
        for skill_dir in "$dir"/*/; do
            [ -d "$skill_dir" ] || continue
            local dirname
            dirname="$(basename "$skill_dir")"
            case "$dirname" in _*) continue ;; esac
            local skill_file="${skill_dir%/}/SKILL.md"
            [ -f "$skill_file" ] || continue
            local rel desc
            rel="${skill_file#$repo_root/}"
            desc=$(get_frontmatter_value "description" "$skill_file")
            rows+="| [$dirname]($rel) | ${desc:--} |"$'\n'
            count=$((count + 1))
        done
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
        for f in "$dir"/*.md; do
            [ -f "$f" ] || continue
            local name rel scope
            name="$(basename "$f" .md)"
            rel="${f#$repo_root/}"
            scope="global"
            if [ "$(has_paths "$f")" != "0" ]; then
                scope="scoped"
            else
                global_rule_files+=("$f")
            fi
            lines+="- [$name]($rel) ($scope)"$'\n'
            count=$((count + 1))
        done
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
        {
            echo "---"
            echo ""
            echo "## Project Context"
            echo ""
            echo "<!-- Inlined from always-on rules in intelligence/rules/ -->"
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

    {
        echo "<!-- Generated by intelligence-sync. Do not edit manually. -->"
        echo "<!-- Source: intelligence/ | Sync: bash intelligence/scripts/sync.sh -->"
        echo ""
    } > "$output_file"

    agents_md_append_header "$output_file" "$config_file"

    {
        echo "## Intelligence"
        echo ""
        echo "Source of truth: \`intelligence/\` | Sync: \`bash intelligence/scripts/sync.sh\`"
        echo ""
    } >> "$output_file"

    agents_md_append_agents_table "$repo_root" "$config_file" "$output_file"
    agents_md_append_skills_table "$repo_root" "$config_file" "$output_file"
    agents_md_append_rules_list  "$repo_root" "$config_file" "$output_file"

    normalize_file_to_lf "$output_file"
    echo "  -> ${output_file#$repo_root/}"
}
