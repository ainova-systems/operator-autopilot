#!/bin/bash
# intelligence-sync: Cursor adapter
# Transforms source prompts to .cursor/ format
#
# Rules:
#   - Path-scoped (with `paths:`)  -> .cursor/rules/<name>.mdc with `globs:`
#   - Always-on (no `paths:`)      -> SKIPPED here. Cursor reads AGENTS.md
#     natively for project-level context, and the `agents` adapter inlines
#     always-on rule content into AGENTS.md. Generating .mdc copies of the
#     same rules would cause double-loading and burn the context window.
# Skills: copy as-is (universal SKILL.md format)
# Agents: strip tier/access/tools/disallowedTools, add model + readonly:true

source "$(dirname "${BASH_SOURCE[0]}")/../lib/common.sh"

# Sync rules to Cursor format (.md -> .mdc, paths -> globs)
sync_cursor_rules() {
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
            local hp
            hp=$(has_paths "$f")

            # Skip always-on rules: AGENTS.md (canonical) carries them.
            if [ "$hp" -eq 0 ]; then
                continue
            fi

            local base
            base="$(basename "$f" .md)"

            # Path-scoped rule -> Auto Attached (paths -> globs)
            awk '
                {
                    sub(/\r$/, "")
                    sub(/^paths:/, "globs:")
                }
                NR==1 { print; print "alwaysApply: false"; next }
                { print }
            ' "$f" > "$output_dir/rules/$base.mdc"
            normalize_file_to_lf "$output_dir/rules/$base.mdc"
            echo "  rule: $base.mdc (scoped)"
        done
    done < <(read_yaml_list "$config_file" "rules")
}

# Sync skills to Cursor format (copy as-is)
sync_cursor_skills() {
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

# Sync agents to Cursor format
sync_cursor_agents() {
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
            local name
            name="$(basename "$f")"

            local tier access
            tier=$(get_frontmatter_value "tier" "$f")
            access=$(get_frontmatter_value "access" "$f")

            local cursor_model cursor_readonly
            cursor_model=$(get_model "$config_file" "cursor" "$tier")
            cursor_readonly=""
            [ "$access" = "readonly" ] && cursor_readonly="readonly: true"

            # Always emit model: line (even when value matches Cursor's default)
            # so config is explicit and grep-able.
            awk -v cm="$cursor_model" -v cr="$cursor_readonly" '
                BEGIN { count=0 }
                /^tier:/  { next }
                /^access:/ { next }
                /^tools:/ { next }
                /^disallowedTools:/ { next }
                {
                    sub(/\r$/, "")
                }
                /^---$/ { count++ }
                count==2 && /^---$/ {
                    print "model: " cm
                    if (cr != "") print cr
                }
                { print }
            ' "$f" > "$output_dir/agents/$name"
            normalize_file_to_lf "$output_dir/agents/$name"
            echo "  agent: $name (tier=$tier -> cursor)"
        done
    done < <(read_yaml_list "$config_file" "agents")
}

# Main entry point for Cursor adapter
sync_to_cursor() {
    local repo_root="$1"
    local config_file="$2"
    local output_dir="$3"

    echo "=== Cursor ==="

    rm -rf "$output_dir/rules" "$output_dir/agents" "$output_dir/skills"
    mkdir -p "$output_dir/rules" "$output_dir/skills" "$output_dir/agents"

    sync_cursor_rules "$repo_root" "$config_file" "$output_dir"
    sync_cursor_skills "$repo_root" "$config_file" "$output_dir"
    sync_cursor_agents "$repo_root" "$config_file" "$output_dir"

    local rules_count skills_count agents_count
    rules_count=$(find "$output_dir/rules" -name "*.mdc" 2>/dev/null | wc -l)
    skills_count=$(find "$output_dir/skills" -name "SKILL.md" 2>/dev/null | wc -l)
    agents_count=$(find "$output_dir/agents" -name "*.md" 2>/dev/null | wc -l)
    echo "  -> Rules: $rules_count (.mdc), Skills: $skills_count, Agents: $agents_count"
}
