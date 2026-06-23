#!/bin/bash
# intelligence-sync: Adapter template
# Copy this file to create a new IDE adapter.
#
# This file is NOT executable as-is — `<name>` placeholders below would be
# parsed by bash as input redirection (`<` operator). Replace every
# occurrence with your adapter name before sourcing.
#
# Required:
#   1. Name the file: <ide-name>.sh (e.g., myide.sh)
#   2. Replace every `<name>` placeholder with your adapter name
#   3. Implement sync_to_<name>() function
#   4. Add target to config.yaml:
#      targets:
#        <name>: { enabled: true, output: ".<name>" }
#
# The sync_to_<name>() function receives:
#   $1 = repo_root     — absolute path to the project root
#   $2 = config_file   — absolute path to config.yaml
#   $3 = output_dir    — absolute path to the output directory (e.g., .myide/)
#
# Available library functions (from lib/common.sh):
#   normalize_file_to_lf(file)          — fix CRLF line endings
#   lint_frontmatter(file)              — warn about unquoted colons / leading tabs
#   get_frontmatter_value(key, file)    — extract YAML frontmatter value
#   has_frontmatter(file)               — check if file has --- header
#   has_paths(file)                     — check if file has paths: field
#   get_model(config, ide, tier)        — resolve model from config or default
#   get_model_default(ide, tier)        — hardcoded default for ide:tier
#   map_access_to_claude_tools(access)  — full->all tools, readonly->restricted
#   map_access_to_claude_disallowed(access) — readonly->"Write, Edit", full->""
#   read_yaml_list(config, section)     — read list from config.yaml
#   get_target_field(config, target, field) — read a target's config field

source "$(dirname "${BASH_SOURCE[0]}")/../lib/common.sh"

# Sync rules for <agent-name>
# Typical transformations:
#   - Copy as-is (like Claude)
#   - Convert paths: to globs: (like Cursor)
#   - Merge into single file (like Copilot)
sync_<name>_rules() {
    local repo_root="$1"
    local config_file="$2"
    local output_dir="$3"

    # TODO: Implement rule sync logic
    echo "  rules: not implemented"
}

# Sync skills for <agent-name>
sync_<name>_skills() {
    local repo_root="$1"
    local config_file="$2"
    local output_dir="$3"

    # TODO: Implement skill sync logic
    echo "  skills: not implemented"
}

# Sync agents for <agent-name>
sync_<name>_agents() {
    local repo_root="$1"
    local config_file="$2"
    local output_dir="$3"

    # TODO: Implement agent sync logic
    echo "  agents: not implemented"
}

# Main entry point
sync_to_<name>() {
    local repo_root="$1"
    local config_file="$2"
    local output_dir="$3"

    echo "=== <Agent Name> ==="

    # Clean and create output directories
    rm -rf "$output_dir/rules" "$output_dir/agents" "$output_dir/skills"
    mkdir -p "$output_dir/rules" "$output_dir/skills" "$output_dir/agents"

    sync_<name>_rules "$repo_root" "$config_file" "$output_dir"
    sync_<name>_skills "$repo_root" "$config_file" "$output_dir"
    sync_<name>_agents "$repo_root" "$config_file" "$output_dir"
}
