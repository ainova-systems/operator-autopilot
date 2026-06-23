#!/bin/bash
# shellcheck disable=SC2034  # LS_* are this lib's public API, consumed by the scripts that source it
# intelligence-sync: layout detection
# Source this file — never execute directly.
#
# The intelligence umbrella folder name is NOT hardcoded. It is whatever
# directory holds config.yaml — `intelligence/`, `Intelligence/`, `prompts/`,
# anything. The only fixed name is the module's own subfolder (`sync`), which
# is the module's identity, not the project's choice.
#
# Two layouts exist during the 0.3.x transition:
#   legacy  : <umbrella>/scripts/         (config.yaml at <umbrella>/config.yaml)
#   modular : <umbrella>/sync/scripts/    (config.yaml at <umbrella>/config.yaml)
#
# detect_layout sets these globals:
#   LS_LAYOUT        legacy | modular | unknown
#   LS_MODULE_DIR    dir that contains scripts/ (legacy: == umbrella; modular: <umbrella>/<module>)
#   LS_MODULE_NAME   basename of LS_MODULE_DIR — messages only, never branched on
#   LS_UMBRELLA_DIR  dir that holds (or will hold) config.yaml + project content
#   LS_CONFIG_FILE   absolute path to config.yaml, or "" if none found yet

# detect_layout <scripts_dir>
detect_layout() {
    local scripts_dir="$1"
    local module_dir
    module_dir="$(cd "$scripts_dir/.." && pwd)"

    if [ -f "$module_dir/../config.yaml" ]; then
        # <umbrella>/<module>/scripts — umbrella is two levels up.
        LS_LAYOUT="modular"
        LS_UMBRELLA_DIR="$(cd "$module_dir/.." && pwd)"
    elif [ -f "$module_dir/config.yaml" ]; then
        # <umbrella>/scripts — flat pre-0.3.1 layout.
        LS_LAYOUT="legacy"
        LS_UMBRELLA_DIR="$module_dir"
    else
        # No config.yaml yet (upstream repo template, or pre-bootstrap).
        # Assume the umbrella is the module's parent; callers that need a
        # config will error out with their own message.
        LS_LAYOUT="unknown"
        LS_UMBRELLA_DIR="$(cd "$module_dir/.." && pwd)"
    fi

    LS_MODULE_DIR="$module_dir"
    LS_MODULE_NAME="$(basename "$module_dir")"   # messages only
    if [ -f "$LS_UMBRELLA_DIR/config.yaml" ]; then
        LS_CONFIG_FILE="$LS_UMBRELLA_DIR/config.yaml"
    else
        LS_CONFIG_FILE=""
    fi
}
