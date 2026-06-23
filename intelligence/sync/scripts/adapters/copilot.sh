#!/bin/bash
# intelligence-sync: GitHub Copilot adapter
# Transforms source prompts to .github/ format
#
# Rules:
#   - Path-scoped (with `paths:`) -> .github/instructions/{name}.instructions.md (applyTo:)
#   - Always-on (no `paths:`)     -> SKIPPED here. Copilot reads AGENTS.md
#     natively, and the `agents` adapter inlines always-on rule content
#     into AGENTS.md. We also do not generate .github/copilot-instructions.md
#     because Copilot bug copilot-cli#489 makes AGENTS.md ignored when
#     copilot-instructions.md is present.
# Skills: copy SKILL.md to .github/skills/{name}/SKILL.md
# Agents: -> .github/agents/{name}.agent.md (description, tools, model)

source "$(dirname "${BASH_SOURCE[0]}")/../lib/common.sh"

# Sync rules to Copilot format. Only path-scoped rules are emitted —
# always-on rules live in AGENTS.md (read by Copilot natively).
sync_copilot_rules() {
    local repo_root="$1"
    local config_file="$2"
    local output_dir="$3"

    local instructions_dir="$output_dir/instructions"
    mkdir -p "$instructions_dir"

    local scoped_count=0

    while IFS= read -r src; do
        [ -z "$src" ] && continue
        local dir
        dir="$(resolve_source_dir "$repo_root" "$src")"
        [ -d "$dir" ] || continue
        for f in "$dir"/*.md; do
            [ -f "$f" ] || continue
            local hp
            hp=$(has_paths "$f")

            # Skip always-on rules: AGENTS.md carries them.
            [ "$hp" -eq 0 ] && continue

            local base
            base="$(basename "$f" .md)"

            local paths_line
            paths_line=$(awk '
                { sub(/\r$/, "") }
                /^paths:/ { in_paths=1; next }
                in_paths && /^  - / {
                    val = $0
                    sub(/^  - /, "", val)
                    gsub(/["\047]/, "", val)
                    printf "%s%s", sep, val
                    sep = ","
                }
                in_paths && !/^  - / && !/^$/ { exit }
                END { print "" }
            ' "$f")

            {
                echo "---"
                echo "applyTo: \"$paths_line\""
                echo "---"
                echo ""
                awk '
                    BEGIN { in_fm=0; past_fm=0 }
                    { sub(/\r$/, "") }
                    /^---$/ {
                        if (!past_fm) { in_fm = !in_fm; if (!in_fm) { past_fm=1 }; next }
                    }
                    past_fm || !in_fm { print }
                ' "$f"
            } > "$instructions_dir/$base.instructions.md"
            normalize_file_to_lf "$instructions_dir/$base.instructions.md"
            scoped_count=$((scoped_count + 1))
            echo "  rule: $base.instructions.md (scoped)"
        done
    done < <(read_yaml_list "$config_file" "rules")

    echo "  rules: $scoped_count scoped"
}

# Sync skills to Copilot format (SKILL.md in .github/skills/)
sync_copilot_skills() {
    local repo_root="$1"
    local config_file="$2"
    local output_dir="$3"

    local count=0
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
            count=$((count + 1))
            echo "  skill: $skill_name"
        done
    done < <(read_yaml_list "$config_file" "skills")

    echo "  -> Skills: $count"
}

# Sync agents to Copilot format (.github/agents/{name}.agent.md)
sync_copilot_agents() {
    local repo_root="$1"
    local config_file="$2"
    local output_dir="$3"

    local count=0
    while IFS= read -r src; do
        [ -z "$src" ] && continue
        local dir
        dir="$(resolve_source_dir "$repo_root" "$src")"
        [ -d "$dir" ] || continue
        for f in "$dir"/*.md; do
            [ -f "$f" ] || continue
            local name
            name="$(basename "$f" .md)"

            local tier access description
            tier=$(get_frontmatter_value "tier" "$f")
            access=$(get_frontmatter_value "access" "$f")
            description=$(get_frontmatter_value "description" "$f")

            local model
            model=$(get_model "$config_file" "copilot" "$tier")

            # Build tools list based on access. Tool aliases per Copilot custom-agent
            # spec: `read`, `search`, `edit`, `execute`, `agent`, `web`, `todo`, `*`.
            # Omitting `tools:` grants all; restrict to read/search for readonly access.
            local tools_line=""
            if [ "$access" = "readonly" ]; then
                tools_line="tools: [\"read\", \"search\"]"
            fi

            local description_escaped
            description_escaped=$(yaml_dq_escape "$description")

            # Generate .agent.md: replace tier/access with description/model/tools
            {
                echo "---"
                echo "description: \"$description_escaped\""
                echo "model: $model"
                [ -n "$tools_line" ] && echo "$tools_line"
                echo "---"
                echo ""
                # Strip original frontmatter, keep body
                awk '
                    BEGIN { in_fm=0; past_fm=0 }
                    { sub(/\r$/, "") }
                    /^---$/ {
                        if (!past_fm) { in_fm = !in_fm; if (!in_fm) { past_fm=1 }; next }
                    }
                    past_fm { print }
                ' "$f"
            } > "$output_dir/agents/$name.agent.md"
            normalize_file_to_lf "$output_dir/agents/$name.agent.md"
            count=$((count + 1))
            echo "  agent: $name.agent.md (tier=$tier -> model=$model)"
        done
    done < <(read_yaml_list "$config_file" "agents")

    echo "  -> Agents: $count"
}

# Main entry point for Copilot adapter
sync_to_copilot() {
    local repo_root="$1"
    local config_file="$2"
    local output_dir="$3"

    echo "=== GitHub Copilot ==="

    # Clean generated content (preserve workflows, etc.)
    rm -rf "$output_dir/instructions" "$output_dir/prompts"
    if [ -d "$output_dir/skills" ]; then
        find "$output_dir/skills" -mindepth 1 -maxdepth 1 -type d | while read -r d; do
            rm -rf "$d"
        done
    fi
    rm -rf "$output_dir/agents"
    mkdir -p "$output_dir" "$output_dir/skills" "$output_dir/agents"

    sync_copilot_rules "$repo_root" "$config_file" "$output_dir"
    sync_copilot_skills "$repo_root" "$config_file" "$output_dir"
    sync_copilot_agents "$repo_root" "$config_file" "$output_dir"
}
