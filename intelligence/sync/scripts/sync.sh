#!/bin/bash
# intelligence-sync: Unified sync entry point
# Reads config.yaml from the umbrella folder and syncs to all enabled targets.
#
# Usage:
#   bash <umbrella>/sync/scripts/sync.sh           # Sync all enabled targets
#   bash <umbrella>/sync/scripts/sync.sh claude    # Sync only Claude
#   bash <umbrella>/sync/scripts/sync.sh cursor    # Sync only Cursor
#
# Layout-agnostic: detect_layout finds the umbrella (the dir holding
# config.yaml; name not hardcoded) and migrates a pre-0.3.1 flat layout into
# the <umbrella>/sync/ module. REPO_ROOT: auto-detected from git, or via env.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

source "$SCRIPT_DIR/lib/common.sh"
source "$SCRIPT_DIR/lib/layout.sh"
source "$SCRIPT_DIR/lib/migrations.sh"

# Umbrella = whatever folder holds config.yaml (name not hardcoded). The
# module is wherever this script lives — sync.sh self-locates and does NOT
# assume a folder name.
detect_layout "$SCRIPT_DIR"
INTELLIGENCE_DIR="$LS_UMBRELLA_DIR"

# sync.sh is a PURE synchronizer — it is not a migrator. Migration across a
# breaking-change gap is owned solely by the intelligence-update flow
# (update.sh + skill). sync refuses to run across an un-applied gap so a
# stale/mismatched engine can never generate against a newer layout.
if [ "$LS_LAYOUT" != "modular" ]; then
    is_status needs-update "layout=$LS_LAYOUT"
    echo "ERROR: engine is not in the modular layout (layout=$LS_LAYOUT)." >&2
    echo "       Run the update flow: tell your agent \"Update intelligence-sync\"." >&2
    exit "$IS_RC_NEEDS_UPDATE"
fi

# Schema version lives in config.yaml (the frozen contract key).
_cf="${CONFIG_FILE:-$INTELLIGENCE_DIR/config.yaml}"

# Stale engine vs project schema stamped NEWER (ahead-of-engine) → refuse.
_vc_rc=0
check_version_compat "$_cf" || _vc_rc=$?
if [ "$_vc_rc" -ne 0 ]; then exit "$_vc_rc"; fi

# Schema gap → refuse; the update flow must apply the migration chain first.
# Per the contract, an ABSENT stamp means pre-0.3.1 / un-applied schema — a
# modular tree with no `sync_version` must NOT silently sync
# (that would bypass migrations). A correctly bootstrapped project always has
# the key (INIT emits it; update.sh stamps it).
_stamp="$(read_engine_stamp "$_cf")"
_eng="$(engine_version)"
if [ -z "$_stamp" ]; then
    is_status needs-update "stamped= engine=$_eng (no sync_version)"
    echo "ERROR: config.yaml has no sync_version — schema un-applied." >&2
    echo "       Run the update flow first: tell your agent \"Update intelligence-sync\"." >&2
    exit "$IS_RC_NEEDS_UPDATE"
elif [ -n "$_eng" ] && _ver_gt "$_eng" "$_stamp"; then
    is_status needs-update "stamped=$_stamp engine=$_eng"
    echo "ERROR: project at $_stamp but engine is $_eng — pending breaking changes." >&2
    echo "       Run the update flow first: tell your agent \"Update intelligence-sync\"." >&2
    exit "$IS_RC_NEEDS_UPDATE"
fi

# Normalize REPO_ROOT to the same `cd && pwd` style as INTELLIGENCE_DIR so
# prefix-stripping in path comparisons works (Git Bash on Windows: git
# rev-parse returns `D:/...` while cd && pwd returns `/d/...`; the styles
# do not match without normalization).
REPO_ROOT_RAW="${REPO_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null || (cd "$INTELLIGENCE_DIR/.." && pwd))}"
REPO_ROOT="$(cd "$REPO_ROOT_RAW" && pwd)"
unset REPO_ROOT_RAW

# Layout tokens for generated output (see finalize_output_file in common.sh).
# Engine-shipped rules/agents cannot hardcode the umbrella's name — the project
# chooses it — so they write `<umbrella>` / `<module>` and every adapter expands
# them to these repo-relative paths on the way out.
IS_UMBRELLA_REL="$(repo_rel_dir "$REPO_ROOT" "$LS_UMBRELLA_DIR")"
IS_MODULE_REL="$(repo_rel_dir "$REPO_ROOT" "$LS_MODULE_DIR")"
IS_UMBRELLA_REL="${IS_UMBRELLA_REL:-intelligence}"
IS_MODULE_REL="${IS_MODULE_REL:-intelligence/sync}"
export IS_UMBRELLA_REL IS_MODULE_REL

# Config: explicit env > config.yaml in the umbrella folder
if [ -n "${CONFIG_FILE:-}" ]; then
    CONFIG_FILE="$CONFIG_FILE"
elif [ -f "$INTELLIGENCE_DIR/config.yaml" ]; then
    CONFIG_FILE="$INTELLIGENCE_DIR/config.yaml"
else
    CONFIG_FILE=""
fi

if [ -z "$CONFIG_FILE" ] || [ ! -f "$CONFIG_FILE" ]; then
    is_status config-missing "umbrella=$INTELLIGENCE_DIR"
    echo "ERROR: Config file not found."
    echo "Looked for: config.yaml (in $INTELLIGENCE_DIR)"
    echo "Run INIT.md bootstrap or create config.yaml manually."
    exit "$IS_RC_CONFIG_MISSING"
fi

TARGET_FILTER="${1:-}"

echo "=== intelligence-sync ==="
echo "  Config: $CONFIG_FILE"
echo "  Root:   $REPO_ROOT"
echo ""

# Invariant: AGENTS.md is the canonical carrier of always-on rules for
# Cursor / Copilot / Codex / Pi / opencode (their adapters skip always-on
# rules to avoid duplication, since each tool reads AGENTS.md natively for
# baseline project context). If those targets are enabled, `agents` must
# also be enabled — otherwise always-on rules go nowhere for those tools.
# Skip the check when the user requested a single target via $TARGET_FILTER:
# they may be syncing only one IDE intentionally.
if [ -z "$TARGET_FILTER" ]; then
    agents_enabled=$(is_target_enabled "$CONFIG_FILE" "agents")
    if [ "$agents_enabled" != "1" ]; then
        # AGENTS.md-dependent adapters: any tool whose adapter skips always-on
        # rule emission (because the tool reads AGENTS.md natively) must be
        # listed here. Add new adapters to this list when they ship.
        for tool in cursor copilot codex pi opencode; do
            if [ "$(is_target_enabled "$CONFIG_FILE" "$tool")" = "1" ]; then
                echo "ERROR: targets.$tool is enabled but targets.agents is not." >&2
                echo "  $tool relies on AGENTS.md to deliver always-on rules — without it," >&2
                echo "  always-on rules would be invisible to $tool." >&2
                echo "  Either enable targets.agents in $CONFIG_FILE, or disable targets.$tool." >&2
                exit 1
            fi
        done
    fi
fi

# Remote sources (declared `packs:` reached via `@<pack>`, and inline `git+`
# specs in sources.*) are shallow-cloned on demand by resolve_source_dir. Give
# it a run-scoped cache dir so each spec is fetched at most once per sync and is
# removed on exit. Honors $TMPDIR (never hardcodes /tmp), mirroring update.sh.
IS_REMOTE_CACHE="$(mktemp -d -t intelligence-sync-remotes-XXXXXX 2>/dev/null || mktemp -d)"
export IS_REMOTE_CACHE
trap 'rm -rf "$IS_REMOTE_CACHE"' EXIT INT TERM

# A `@<pack>` token carries only the reference; its url / ref / mirror live in
# config.yaml. resolve_source_dir keeps its published two-argument contract so
# project-owned adapters written against it keep working, so the config path
# reaches it the same way the clone cache does — through the environment.
IS_CONFIG_FILE="$CONFIG_FILE"
export IS_CONFIG_FILE

# Fail closed on an undeclared pack reference or an unsafe mirror, before any
# adapter runs — see validate_pack_refs for why this cannot live in the resolver.
validate_pack_refs "$REPO_ROOT" "$CONFIG_FILE"

# A pack that declares `mirror:` is additionally materialized into a tracked
# directory in the repo, so an upstream bump is visible in `git diff` rather
# than only in the generated output. Without it, the pack stays transient.
while IFS= read -r mirror_rel; do
    [ -n "$mirror_rel" ] && echo "  Pack mirror: $mirror_rel"
done < <(list_pack_mirrors "$REPO_ROOT" "$CONFIG_FILE")

# Lint frontmatter across all source files (rules, agents, skills).
# Catches issues like unquoted colons that strict YAML consumers reject.
for section in rules agents skills; do
    while IFS= read -r src; do
        [ -z "$src" ] && continue
        src_dir="$(resolve_source_dir "$REPO_ROOT" "$src")"
        [ -d "$src_dir" ] || continue
        if [ "$section" = "skills" ]; then
            while IFS= read -r f; do
                [ -n "$f" ] && lint_frontmatter "$f"
            done < <(find "$src_dir" -mindepth 2 -maxdepth 2 -name 'SKILL.md' 2>/dev/null)
        else
            for f in "$src_dir"/*.md; do
                [ -f "$f" ] && lint_frontmatter "$f"
            done
        fi
    done < <(read_yaml_list "$CONFIG_FILE" "$section")
done

# Adapters come from two places, discovered by filename (minus `.sh`,
# `_template` excluded):
#
#   1. Built-in   — <module>/scripts/adapters/   (upstream-owned; update.sh
#                   replaces this directory wholesale on every engine update)
#   2. Project    — <umbrella>/adapters/         (project-owned; update.sh
#                   never touches it)
#
# A custom adapter therefore belongs in the umbrella's `adapters/` — put one in
# the engine's own adapters/ and the next update deletes it. A project adapter
# whose name matches a built-in overrides it (an escape hatch for patching a
# built-in without forking the engine — announced, never silent).
ADAPTERS=()
ADAPTER_FILES=()

register_adapter() {
    local name="$1" file="$2"
    local n=${#ADAPTERS[@]} i=0
    while [ "$i" -lt "$n" ]; do
        if [ "${ADAPTERS[$i]}" = "$name" ]; then
            ADAPTER_FILES[$i]="$file"
            echo "  NOTE: project adapter '$name' overrides the built-in one ($(basename "$INTELLIGENCE_DIR")/adapters/$(basename "$file"))"
            return 0
        fi
        i=$((i + 1))
    done
    ADAPTERS+=("$name")
    ADAPTER_FILES+=("$file")
}

for adapters_dir in "$SCRIPT_DIR/adapters" "$INTELLIGENCE_DIR/adapters"; do
    [ -d "$adapters_dir" ] || continue
    for adapter_file in "$adapters_dir"/*.sh; do
        [ -f "$adapter_file" ] || continue
        adapter_name="$(basename "$adapter_file" .sh)"
        [ "$adapter_name" = "_template" ] && continue
        register_adapter "$adapter_name" "$adapter_file"
    done
done

synced=0
adapter_count=${#ADAPTERS[@]}
adapter_idx=0

while [ "$adapter_idx" -lt "$adapter_count" ]; do
    adapter="${ADAPTERS[$adapter_idx]}"
    adapter_file="${ADAPTER_FILES[$adapter_idx]}"
    adapter_idx=$((adapter_idx + 1))

    # Skip if user requested specific target and this isn't it
    if [ -n "$TARGET_FILTER" ] && [ "$adapter" != "$TARGET_FILTER" ]; then
        continue
    fi

    # Check if target is enabled in config
    enabled=$(is_target_enabled "$CONFIG_FILE" "$adapter")
    if [ "$enabled" != "1" ] && [ -z "$TARGET_FILTER" ]; then
        continue
    fi

    # Get output directory
    output=$(get_target_output "$CONFIG_FILE" "$adapter")
    if [ -z "$output" ]; then
        output=".$adapter"
    fi
    output_dir="$REPO_ROOT/$output"

    # Refuse to run if the output would clobber content — `output: "."`,
    # `output: "intelligence"`, or a `../` path that escapes the repo. Applies
    # to EVERY adapter, `agents` included: dir-writing adapters `rm -rf` their
    # output, and `agents` overwrites whatever single file it is handed. Both
    # turn a bad config line into a destructive write.
    validate_output_path "$REPO_ROOT" "$CONFIG_FILE" "$adapter" "$output_dir"

    # Source adapter and run.
    # shellcheck source=/dev/null
    source "$adapter_file"
    "sync_to_$adapter" "$REPO_ROOT" "$CONFIG_FILE" "$output_dir"
    echo ""
    synced=$((synced + 1))
done

if [ $synced -eq 0 ]; then
    if [ -n "$TARGET_FILTER" ]; then
        echo "ERROR: Adapter '$TARGET_FILTER' not found."
        echo "Available: ${ADAPTERS[*]}"
    else
        echo "WARNING: No targets enabled in $CONFIG_FILE"
    fi
    exit 1
fi

# Warn about unsynced directories
warn_unsynced "$REPO_ROOT" "$CONFIG_FILE"

# Report model overrides that drift from intelligence-sync defaults
# (helpful when defaults move forward — e.g., gpt-5.5 -> gpt-5.6).
report_model_drift "$CONFIG_FILE"

# This is the final vendored line; development continues in the intelligence
# CLI. A short stderr block keeps IS_STATUS stdout parsing (skills, CI)
# untouched and is suppressible for pipelines. The move is the update skill's step 7 and
# needs your explicit approval — nothing here changes on its own.
if [ -z "${IS_SUPPRESS_CLI_NOTE:-}" ]; then
    echo "NEXT: Intelligence Sync is now the archived vendored line. Its supported successor is:" >&2
    echo "      https://github.com/ainova-systems/intelligence" >&2
    echo "      Install the stable CLI: npm install -g @ainova-systems/intelligence@latest" >&2
    echo "      To migrate now, tell your agent: \"Update intelligence-sync and migrate this project to the Intelligence CLI.\"" >&2
    echo "      It will explain the one-way changes, run 'intelligence init --preview', and ask before applying them." >&2
fi

echo ""
# sync.sh never migrates (the update flow owns that), so success is always ok.
is_status ok "synced=$synced"
echo "=== Done: $synced target(s) synced ==="
