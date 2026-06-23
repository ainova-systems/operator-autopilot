#!/bin/bash
# intelligence-sync: Claude Code adapter
# Transforms source prompts to .claude/ format
#
# Rules: copy as-is (paths: frontmatter preserved)
# Skills: copy SKILL.md directories
# Agents: tier -> model, access -> tools/disallowedTools

source "$(dirname "${BASH_SOURCE[0]}")/../lib/common.sh"

# Sync rules to Claude format (copy as-is, normalize LF)
sync_claude_rules() {
    local repo_root="$1"
    local config_file="$2"
    local output_dir="$3"

    while IFS= read -r src; do
        [ -z "$src" ] && continue
        local dir
        dir="$(resolve_source_dir "$repo_root" "$src")"
        [ -d "$dir" ] || continue
        for f in "$dir"/*.md; do
            [ -f "$f" ] || continue
            cp "$f" "$output_dir/rules/"
            normalize_file_to_lf "$output_dir/rules/$(basename "$f")"
            echo "  rule: $(basename "$f")"
        done
    done < <(read_yaml_list "$config_file" "rules")
}

# Sync skills to Claude format (copy SKILL.md directories)
sync_claude_skills() {
    local repo_root="$1"
    local config_file="$2"
    local output_dir="$3"

    while IFS= read -r src; do
        [ -z "$src" ] && continue
        local dir
        dir="$(resolve_source_dir "$repo_root" "$src")"
        [ -d "$dir" ] || continue
        for d in "$dir"/*/; do
            [ -d "$d" ] || continue
            local skill_name
            skill_name="$(basename "$d")"
            [ -f "$d/SKILL.md" ] || continue
            mkdir -p "$output_dir/skills/$skill_name"
            cp "$d/SKILL.md" "$output_dir/skills/$skill_name/SKILL.md"
            normalize_file_to_lf "$output_dir/skills/$skill_name/SKILL.md"
            echo "  skill: $skill_name"
        done
    done < <(read_yaml_list "$config_file" "skills")
}

# Sync a single agent file to Claude format
sync_claude_agent() {
    local src="$1"
    local config_file="$2"
    local output_dir="$3"
    local name
    name="$(basename "$src")"

    local tier access
    tier=$(get_frontmatter_value "tier" "$src")
    access=$(get_frontmatter_value "access" "$src")

    local model tools extra
    model=$(get_model "$config_file" "claude" "$tier")
    tools=$(map_access_to_claude_tools "$access")
    extra=$(map_access_to_claude_disallowed "$access")

    # Transform: remove tier/access, inject tools/model/disallowedTools before closing ---
    awk -v model="$model" -v tools="$tools" -v extra="$extra" '
        BEGIN { count=0 }
        /^tier:/  { next }
        /^access:/ { next }
        {
            sub(/\r$/, "")
        }
        /^---$/ { count++ }
        count==2 && /^---$/ {
            print "tools: " tools
            if (extra != "") print "disallowedTools: " extra
            print "model: " model
        }
        { print }
    ' "$src" > "$output_dir/agents/$name"
    normalize_file_to_lf "$output_dir/agents/$name"
    echo "  agent: $name (tier=$tier -> model=$model, access=$access)"
}

# Sync all agents to Claude format
sync_claude_agents() {
    local repo_root="$1"
    local config_file="$2"
    local output_dir="$3"

    while IFS= read -r src; do
        [ -z "$src" ] && continue
        local dir
        dir="$(resolve_source_dir "$repo_root" "$src")"
        [ -d "$dir" ] || continue
        for f in "$dir"/*.md; do
            [ -f "$f" ] || continue
            sync_claude_agent "$f" "$config_file" "$output_dir"
        done
    done < <(read_yaml_list "$config_file" "agents")
}

# Main entry point for Claude adapter
sync_to_claude() {
    local repo_root="$1"
    local config_file="$2"
    local output_dir="$3"

    echo "=== Claude Code ==="

    # Clean generated content only — preserve any project-level files
    # the user manages directly (settings.json, settings.local.json,
    # commands/, statusline.sh, etc.).
    rm -rf "$output_dir/rules" "$output_dir/agents"
    if [ -d "$output_dir/skills" ]; then
        find "$output_dir/skills" -mindepth 1 -maxdepth 1 -type d | while read -r d; do
            rm -rf "$d"
        done
    fi
    mkdir -p "$output_dir/rules" "$output_dir/skills" "$output_dir/agents"

    sync_claude_rules "$repo_root" "$config_file" "$output_dir"
    sync_claude_skills "$repo_root" "$config_file" "$output_dir"
    sync_claude_agents "$repo_root" "$config_file" "$output_dir"

    local rules_count skills_count agents_count
    rules_count=$(find "$output_dir/rules" -name "*.md" 2>/dev/null | wc -l)
    skills_count=$(find "$output_dir/skills" -name "SKILL.md" 2>/dev/null | wc -l)
    agents_count=$(find "$output_dir/agents" -name "*.md" 2>/dev/null | wc -l)
    echo "  -> Rules: $rules_count, Skills: $skills_count, Agents: $agents_count"
}
