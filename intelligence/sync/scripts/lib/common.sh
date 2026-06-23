#!/bin/bash
# intelligence-sync: Core library functions
# Source this file — never execute directly.
#
# Usage: source "$(dirname "$0")/lib/common.sh"

# --- File Utilities ---

# Convert CRLF to LF in a file (safe for Windows/Git Bash)
normalize_file_to_lf() {
    local target="$1"
    local tmp_file="$target.tmp"
    awk '{ sub(/\r$/, ""); print }' "$target" > "$tmp_file"
    mv "$tmp_file" "$target"
}

# Escape a string for safe interpolation into a TOML basic string ("..").
# Backslash and double-quote are escaped; control chars stripped.
toml_escape() {
    local s="$1"
    s="${s//\\/\\\\}"
    s="${s//\"/\\\"}"
    # Strip any literal newline / carriage return — TOML basic strings
    # do not allow them; multi-line content belongs in `"""..."""`.
    s="${s//$'\n'/ }"
    s="${s//$'\r'/}"
    printf '%s' "$s"
}

# Escape a string for safe interpolation into a YAML double-quoted scalar.
yaml_dq_escape() {
    local s="$1"
    s="${s//\\/\\\\}"
    s="${s//\"/\\\"}"
    s="${s//$'\n'/ }"
    s="${s//$'\r'/}"
    printf '%s' "$s"
}

# --- Source Resolution -------------------------------------------------------
#
# A `sources.*` entry is normally a LOCAL path resolved as `$repo_root/<entry>`.
# It may instead be a REMOTE git spec, which is materialized (shallow-cloned)
# and resolved to a local directory inside the clone. This is the SINGLE point
# where remote sources are detected and fetched — every adapter and sync.sh
# routes its `$repo_root/$src` through resolve_source_dir, so no other file
# needs to know about remote sources.
#
# Spec format (inline string, so read_yaml_list parses it unchanged):
#   git+<url>[@<ref>][#<subpath>]
#     <url>      explicit-scheme URL (https/http/ssh/git/file). Other transports
#                (notably the command-executing ext::/fd::) are rejected.
#     @<ref>     optional tag / branch / SHA — the segment after the last `@` in
#                the post-scheme part, accepted only if it has no `/` (so
#                userinfo like `ssh://git@host/...` is not mistaken for a ref;
#                branch names containing `/` are unsupported — use a tag, SHA,
#                or slashless branch, which is the recommended pin anyway).
#     #<subpath> optional dir inside the clone holding rules/agents/skills.

# True (0) if a source token is a remote git spec.
source_is_remote() {
    case "$1" in
        git+*) return 0 ;;
        *)     return 1 ;;
    esac
}

# Resolve a single source token to an absolute local directory.
#   Local token  -> "$repo_root/$token".
#   Remote token -> shallow-clone into the run cache, echo "<clone>/<subpath>".
# ALWAYS returns 0 (echoes nothing on failure) so `set -e` callers using
# `dir="$(resolve_source_dir ...)"` never abort; the caller's existing
# `[ -d "$dir" ] || continue` guard then skips an unresolved source.
# Usage: dir="$(resolve_source_dir "$repo_root" "$src")"
resolve_source_dir() {
    local repo_root="$1" token="$2"

    if ! source_is_remote "$token"; then
        printf '%s' "$repo_root/$token"
        return 0
    fi

    # --- parse: git+<url>[@<ref>][#<subpath>] ---
    local rest="${token#git+}"
    local subpath="" urlref="$rest"
    case "$rest" in
        *\#*) subpath="${rest#*#}"; urlref="${rest%%#*}" ;;
    esac

    # Reject path traversal in the subpath: a remote spec must not be able to
    # escape the clone dir (e.g. `#../../etc`). Checked before any clone.
    case "/$subpath/" in
        */../*)
            echo "  WARN: remote source rejected (subpath traversal '..'): $token" >&2
            return 0
            ;;
    esac

    # Scheme whitelist — reject everything but plain fetch transports. The
    # ext::/fd:: transports execute arbitrary commands on clone, so a malicious
    # or mistyped config must never reach `git clone` with them.
    case "$urlref" in
        https://*|http://*|ssh://*|git://*|file://*) ;;
        *)
            echo "  WARN: remote source rejected (unsupported scheme): $token" >&2
            return 0
            ;;
    esac

    # ref = segment after the last `@` in the post-scheme part, only if it has
    # no `/` (else it is userinfo such as `git@host`, not a ref).
    local url="$urlref" ref="" after_scheme="${urlref#*://}"
    case "$after_scheme" in
        *@*)
            local cand="${after_scheme##*@}"
            case "$cand" in
                */*|"") ;;                        # userinfo / empty -> no ref
                *) ref="$cand"; url="${urlref%@$ref}" ;;
            esac
            ;;
    esac

    if ! command -v git >/dev/null 2>&1; then
        echo "  WARN: remote source needs git, which is not installed: $token" >&2
        return 0
    fi

    # Cache root: run-scoped (set + cleaned by sync.sh) or a stable fallback so
    # direct adapter calls still avoid re-cloning the same spec within a run.
    local cache_root="${IS_REMOTE_CACHE:-${TMPDIR:-/tmp}/intelligence-sync-remotes}"
    mkdir -p "$cache_root" 2>/dev/null || true
    # Key on repo URL + ref ONLY (not the subpath): sources that point at the
    # same repo@ref but different subpaths (e.g. `...repo.git@main#rules` and
    # `...repo.git@main#skills`) share a SINGLE clone; the subpath only selects
    # a directory inside it. Different ref → different clone (distinct versions).
    local key
    key="$(printf '%s' "$url@$ref" | cksum | awk '{print $1 "-" $2}')"
    local dest="$cache_root/$key"

    if [ ! -d "$dest/.git" ]; then
        rm -rf "$dest"
        # Untrusted remote content: never materialize symlinks from the cloned
        # repo. With core.symlinks=false git writes each symlink as a plain text
        # file holding its target path, so a hostile link like `skills -> /etc`
        # cannot make the copy pipeline read host files outside the clone.
        local ok=0
        if [ -n "$ref" ]; then
            if GIT_TERMINAL_PROMPT=0 git -c core.symlinks=false clone --depth 1 --branch "$ref" --quiet \
                "$url" "$dest" 2>/dev/null; then
                ok=1
            else
                # ref is likely a SHA (not a branch/tag) — full clone + checkout.
                rm -rf "$dest"
                if GIT_TERMINAL_PROMPT=0 git -c core.symlinks=false clone --quiet "$url" "$dest" 2>/dev/null \
                    && git -C "$dest" -c core.symlinks=false checkout --quiet "$ref" 2>/dev/null; then
                    ok=1
                fi
            fi
        elif GIT_TERMINAL_PROMPT=0 git -c core.symlinks=false clone --depth 1 --quiet "$url" "$dest" 2>/dev/null; then
            ok=1
        fi
        if [ "$ok" -ne 1 ]; then
            rm -rf "$dest"
            echo "  WARN: remote source clone failed (url=$url ref=${ref:-<default>}): $token" >&2
            return 0
        fi
        echo "  remote: cloned $url${ref:+ @$ref}" >&2
    fi

    local out="$dest"
    [ -n "$subpath" ] && out="$dest/$subpath"
    if [ ! -d "$out" ]; then
        echo "  WARN: remote source subpath not found ('${subpath:-/}') in $url: $token" >&2
        return 0
    fi
    # Containment (defense in depth on top of the `..` reject + symlink-free
    # checkout): the resolved dir must stay inside the clone. Canonicalize both
    # with `pwd -P` so a symlinked TMPDIR (e.g. macOS /tmp -> /private/tmp)
    # resolves consistently on each side.
    local real_dest real_out
    real_dest="$(cd "$dest" 2>/dev/null && pwd -P)"
    real_out="$(cd "$out" 2>/dev/null && pwd -P)"
    case "${real_out:-/nonexistent}" in
        "$real_dest"|"$real_dest"/*) ;;
        *)
            echo "  WARN: remote source subpath escapes the clone ('${subpath:-/}'): $token" >&2
            return 0
            ;;
    esac
    printf '%s' "$out"
    return 0
}

# Copy a markdown file with frontmatter, ensuring free-text string fields are
# wrapped in double quotes. Used by adapters that feed strict-YAML consumers
# (Codex CLI rejects unquoted colons / booleans). Idempotent — already-quoted
# values pass through untouched. Operates only inside the first `---` ... `---`
# block; body is preserved verbatim.
#
# Quoted fields: description, argument-hint
# When wrapping an unquoted value, literal `\` and `"` inside it are escaped
# (`\\`, `\"`) so an inner quote — e.g. `Use as a quick "what do we have" view`
# — cannot prematurely terminate the generated double-quoted scalar. Values the
# author already wrapped (in `"` or `'`) pass through untouched.
#
# Usage: copy_md_with_quoted_frontmatter "src.md" "dst.md"
copy_md_with_quoted_frontmatter() {
    local src="$1"
    local dst="$2"
    awk '
        function yamlq(s,    out, i, c) {
            out = ""
            for (i = 1; i <= length(s); i++) {
                c = substr(s, i, 1)
                if (c == "\\") out = out "\\\\"
                else if (c == "\"") out = out "\\\""
                else out = out c
            }
            return out
        }
        BEGIN { state = "before" }
        { sub(/\r$/, "") }
        state == "before" {
            if (NR == 1 && $0 == "---") { state = "in_fm"; print; next }
            state = "after"; print; next
        }
        state == "in_fm" {
            if ($0 == "---") { state = "after"; print; next }
            idx = index($0, ":")
            if (idx == 0) { print; next }
            key = substr($0, 1, idx - 1)
            sub(/^[[:space:]]+/, "", key); sub(/[[:space:]]+$/, "", key)
            if (key != "description" && key != "argument-hint") { print; next }
            val = substr($0, idx + 1)
            sub(/^[[:space:]]+/, "", val); sub(/[[:space:]]+$/, "", val)
            if (val == "") { print; next }
            first = substr(val, 1, 1)
            last = substr(val, length(val), 1)
            if ((first == "\"" && last == "\"") || (first == "\047" && last == "\047")) { print; next }
            print key ": \"" yamlq(val) "\""
            next
        }
        state == "after" { print }
    ' "$src" > "$dst"
}

# Copy SKILL.md directories into an Agent Skills open-standard location.
# The destination is a directory whose immediate children are skill folders
# containing SKILL.md (e.g. .agents/skills/<name>/SKILL.md). Free-text
# frontmatter fields are quoted for strict YAML consumers; lenient consumers
# accept the result unchanged, so this one copy can be shared across tools.
#
# Owns the full lifecycle of `$output_dir`: removes every existing skill
# subfolder, recreates the directory, then populates it. Sibling FILES at
# `$output_dir` are preserved (only immediate subdirectories are pruned).
# Multiple adapters may target the same path (e.g. Codex + Pi both write to
# `.agents/skills/`); calls are idempotent because every caller writes the
# same content from `intelligence/skills/`. Adapters MUST NOT do their own
# clean / mkdir for this dir — the helper is the single owner.
#
# Usage: sync_open_skill_dirs "$REPO_ROOT" "$CONFIG_FILE" "$dest_dir"
sync_open_skill_dirs() {
    local repo_root="$1"
    local config_file="$2"
    local output_dir="$3"

    if [ -d "$output_dir" ]; then
        # Prune both real subdirectories and symlinks (incl. dir-symlinks):
        # "-type d" alone would leave a stale symlinked skill in place and
        # break the "helper owns the full lifecycle" contract.
        find "$output_dir" -mindepth 1 -maxdepth 1 \( -type d -o -type l \) -exec rm -rf {} +
    fi
    mkdir -p "$output_dir"

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
            mkdir -p "$output_dir/$skill_name"
            copy_md_with_quoted_frontmatter "$d/SKILL.md" "$output_dir/$skill_name/SKILL.md"
            normalize_file_to_lf "$output_dir/$skill_name/SKILL.md"
            count=$((count + 1))
            echo "  skill: $skill_name"
        done
    done < <(read_yaml_list "$config_file" "skills")

    echo "  -> Skills: $count"
}

# Lint YAML frontmatter for common pitfalls (unquoted colons, leading tabs).
# Print warnings to stderr; do not fail. Strict consumers (Codex CLI) reject
# these files with cryptic messages — catching them in sync gives better DX.
# Usage: lint_frontmatter "path/to/file.md"
lint_frontmatter() {
    local file="$1"
    awk -v f="$file" '
        BEGIN { in_fm = 0; line = 0 }
        { sub(/\r$/, ""); line++ }
        line == 1 && $0 != "---" { exit }
        line == 1 { in_fm = 1; next }
        in_fm && $0 == "---" { exit }
        in_fm && /^\t/ {
            printf "  WARN: %s:%d leading tab in frontmatter (use spaces)\n", f, line > "/dev/stderr"
        }
        in_fm && /^[a-zA-Z0-9_-]+:[[:space:]]+[^"\047|>[{]/ {
            value_start = index($0, ":") + 1
            value = substr($0, value_start)
            sub(/^[[:space:]]+/, "", value)
            if (value ~ /:[[:space:]]/ || value ~ /:$/) {
                col = index(value, ":") + value_start
                printf "  WARN: %s:%d unquoted colon in value at column %d — wrap value in quotes\n", f, line, col > "/dev/stderr"
            }
            if (value ~ /"/) {
                printf "  WARN: %s:%d literal double quote in unquoted value — wrap value in single quotes or escape as \\\" so strict-YAML targets accept it\n", f, line > "/dev/stderr"
            }
        }
    ' "$file"
}

# --- Frontmatter Parsing ---

# Extract a single value from YAML frontmatter by key.
# Splits on the FIRST colon only, so values containing additional colons
# (e.g. `description: "Use when: fixing APIs"`) are preserved. Reads only
# inside the first `---` ... `---` frontmatter block; body content is ignored.
# Strips surrounding double or single quotes from the value.
# Usage: get_frontmatter_value "tier" "path/to/file.md"
get_frontmatter_value() {
    local key="$1"
    local file="$2"
    awk -v k="$key" '
        { sub(/\r$/, "") }
        NR == 1 && $0 != "---" { exit }
        NR == 1 { in_fm = 1; next }
        in_fm && $0 == "---" { exit }
        !in_fm { next }

        {
            idx = index($0, ":")
            if (idx == 0) next
            line_key = substr($0, 1, idx - 1)
            if (line_key != k) next
            val = substr($0, idx + 1)
            sub(/^[[:space:]]+/, "", val)
            sub(/[[:space:]]+$/, "", val)
            n = length(val)
            if (n >= 2) {
                first = substr(val, 1, 1)
                last = substr(val, n, 1)
                if ((first == "\"" && last == "\"") || (first == "\047" && last == "\047")) {
                    val = substr(val, 2, n - 2)
                }
            }
            print val
            exit
        }
    ' "$file"
}

# Check if a file starts with YAML frontmatter (---)
has_frontmatter() {
    local file="$1"
    awk 'NR==1 { sub(/\r$/, ""); if ($0 == "---") print 1; else print 0; exit }' "$file"
}

# Strip YAML frontmatter, print body only.
# Reads the first `---` ... `---` block at the top of the file and emits
# everything after the closing fence verbatim. CRLF-safe (trailing \r stripped
# per line). If the file has no frontmatter, the entire file is printed.
# Shared by adapters that wrap source agent bodies into IDE-native templates
# (currently pi.sh, opencode.sh) — do NOT inline-duplicate this awk block.
# Usage: body="$(strip_frontmatter "path/to/file.md")"
strip_frontmatter() {
    local file="$1"
    awk '
        BEGIN { in_fm = 0; past_fm = 0 }
        { sub(/\r$/, "") }
        # No frontmatter: first line is not a `---` fence — treat the whole
        # file as body so the helper honors its "print everything if no
        # frontmatter" contract instead of emitting nothing.
        NR == 1 && $0 != "---" { past_fm = 1 }
        /^---$/ {
            if (!past_fm) {
                in_fm = !in_fm
                if (!in_fm) { past_fm = 1 }
                next
            }
        }
        past_fm { print }
    ' "$file"
}

# Check if a file has a paths: field in frontmatter.
# Scoped to the first `---` ... `---` block — body content like a code
# example referencing `paths: foo` will not be miscounted.
has_paths() {
    local file="$1"
    awk '
        { sub(/\r$/, "") }
        NR == 1 && $0 != "---" { print 0; done=1; exit }
        NR == 1 { in_fm = 1; next }
        in_fm && $0 == "---" { print c+0; done=1; exit }
        in_fm && /^paths:/ { c++ }
        END { if (!done) print c+0 }
    ' "$file"
}

# --- Tier/Access Mappings ---

# Hardcoded defaults: ide:tier -> model name.
# When you bump these, run `bash intelligence/scripts/sync.sh` in projects;
# any project whose config.yaml `models:` section diverges from these will
# print a drift warning so users know their override is now stale.
get_model_default() {
    local ide="$1"
    local tier="$2"
    case "$ide:$tier" in
        claude:heavy)     echo "opus" ;;
        claude:standard)  echo "sonnet" ;;
        claude:light)     echo "haiku" ;;
        cursor:heavy)     echo "inherit" ;;
        cursor:standard)  echo "inherit" ;;
        cursor:light)     echo "fast" ;;
        copilot:heavy)    echo "gpt-5.5" ;;
        copilot:standard) echo "gpt-5.5-codex" ;;
        copilot:light)    echo "gpt-5.5-mini" ;;
        codex:heavy)      echo "gpt-5.5" ;;
        codex:standard)   echo "gpt-5.5-codex" ;;
        codex:light)      echo "gpt-5.5-mini" ;;
        opencode:heavy)    echo "anthropic/claude-opus-4-8" ;;
        opencode:standard) echo "anthropic/claude-sonnet-4-6" ;;
        opencode:light)    echo "anthropic/claude-haiku-4-5-20251001" ;;
        *)                echo "" ;;
    esac
}

# Read a nested key from config.yaml: section -> sub -> key.
# Used to resolve `models.<ide>.<tier>` overrides.
get_nested_yaml_value() {
    local file="$1"
    local section="$2"
    local sub="$3"
    local key="$4"
    awk -v section="$section" -v subname="$sub" -v key="$key" '
        { sub(/\r$/, "") }
        $0 ~ "^" section ":[[:space:]]*$" { in_section=1; in_sub=0; next }
        in_section && /^[a-zA-Z]/ && $0 !~ "^" section ":" { in_section=0; in_sub=0 }
        in_section && $0 ~ "^  " subname ":[[:space:]]*$" { in_sub=1; next }
        in_section && in_sub && /^  [a-zA-Z]/ { in_sub=0 }
        in_section && in_sub && $0 ~ "^    " key ":" {
            val = $0
            sub(/.*:[[:space:]]*["\047]?/, "", val)
            sub(/["\047]?[[:space:]]*$/, "", val)
            print val
            exit
        }
    ' "$file"
}

# Resolve a model: config.yaml `models:` override wins, otherwise default.
# Usage: get_model "$CONFIG_FILE" "claude" "$tier"
get_model() {
    local config_file="$1"
    local ide="$2"
    local tier="${3:-heavy}"
    local override
    if [ -n "$config_file" ] && [ -f "$config_file" ]; then
        override=$(get_nested_yaml_value "$config_file" "models" "$ide" "$tier")
    fi
    if [ -n "${override:-}" ]; then
        echo "$override"
    else
        get_model_default "$ide" "$tier"
    fi
}

# Print info message for each model override that differs from the
# hardcoded default. Helps users notice when a script update brings new
# defaults that their config still overrides with the old value.
# One awk pass extracts every `<ide>.<tier>=<value>` triple under `models:`;
# comparison against defaults happens in shell.
report_model_drift() {
    local config_file="$1"
    [ -f "$config_file" ] || return 0

    local triples
    triples=$(awk '
        { sub(/\r$/, "") }
        /^models:[[:space:]]*$/ { in_models=1; next }
        in_models && /^[a-zA-Z]/ { in_models=0; in_ide="" }
        in_models && /^  [a-zA-Z][a-zA-Z0-9_-]*:[[:space:]]*$/ {
            line=$0
            sub(/^  /, "", line); sub(/:[[:space:]]*$/, "", line)
            in_ide=line
            next
        }
        in_models && in_ide && /^    [a-zA-Z][a-zA-Z0-9_-]*:/ {
            line=$0; sub(/^    /, "", line)
            key=line; sub(/:.*/, "", key)
            val=line; sub(/[^:]+:[[:space:]]*/, "", val)
            gsub(/^["\047]|["\047][[:space:]]*$/, "", val)
            print in_ide "\t" key "\t" val
        }
    ' "$config_file")

    [ -z "$triples" ] && return 0

    local printed_header=0
    while IFS=$'\t' read -r ide tier from_config; do
        [ -z "$from_config" ] && continue
        local default
        default=$(get_model_default "$ide" "$tier")
        [ "$from_config" = "$default" ] && continue
        if [ $printed_header -eq 0 ]; then
            echo ""
            echo "=== Model overrides (config.yaml differs from intelligence-sync defaults) ==="
            printed_header=1
        fi
        printf "  %-8s %-9s config=%-20s default=%s\n" "$ide" "$tier" "\"$from_config\"" "\"$default\""
    done <<< "$triples"

    if [ $printed_header -eq 1 ]; then
        echo "  (To accept new defaults: remove the entry from config.yaml \`models:\` section.)"
    fi
}

# Map access level to Claude tools string
map_access_to_claude_tools() {
    local access="$1"
    case "$access" in
        readonly) echo "Read, Grep, Glob, Bash" ;;
        *)        echo "Read, Write, Edit, Glob, Grep, Bash, Agent" ;;
    esac
}

# Map access level to Claude disallowedTools (empty if full access)
map_access_to_claude_disallowed() {
    local access="$1"
    case "$access" in
        readonly) echo "Write, Edit" ;;
        *)        echo "" ;;
    esac
}

# --- Validation ---

# Refuse to operate on output paths that could clobber repo content.
# Adapters call `rm -rf` on subdirectories of $output_dir; if config.yaml
# accidentally points an adapter at the repo root, the intelligence source
# tree (whatever the user named it), or any configured source directory,
# that cleanup would delete real work. Call this from sync.sh before
# invoking each adapter.
#
# All forbidden paths are derived dynamically — no folder name is
# hardcoded, so projects that renamed `intelligence/` (capital I, custom
# name) are protected the same way.
#
# Exits 1 with a clear message on rejection.
# Usage: validate_output_path "$REPO_ROOT" "$CONFIG_FILE" "$adapter" "$output_dir"
validate_output_path() {
    local repo_root="$1"
    local config_file="$2"
    local adapter="$3"
    local output_dir="$4"

    # Empty / dotted paths.
    case "$output_dir" in
        ""|"."|"/"|"./"|"$repo_root"|"$repo_root/"|"$repo_root/.")
            echo "ERROR: targets.$adapter.output resolves to repo root or empty path: '$output_dir'" >&2
            echo "  Refusing to run — adapter cleanup would destroy repository content." >&2
            exit 1
            ;;
    esac

    # Resolve to canonical path. If the resolved output equals or is an
    # ancestor of the repo root, refuse.
    local resolved
    resolved=$(cd "$output_dir" 2>/dev/null && pwd) || resolved=""
    if [ -n "$resolved" ] && [ "$resolved" = "$repo_root" ]; then
        echo "ERROR: targets.$adapter.output resolves to repo root: '$output_dir'" >&2
        exit 1
    fi

    local rel="${output_dir#$repo_root/}"

    # Reject the intelligence source directory itself (parent of config.yaml).
    # Folder name is whatever the user chose — we read it from the filesystem.
    local intel_dir intel_rel
    intel_dir="$(cd "$(dirname "$config_file")" && pwd)"
    intel_rel="${intel_dir#$repo_root/}"
    if [ -n "$intel_rel" ]; then
        case "$rel" in
            "$intel_rel"|"$intel_rel/"|"$intel_rel"/*)
                echo "ERROR: targets.$adapter.output points into the intelligence source tree ('$intel_rel'): '$rel'" >&2
                echo "  Adapter cleanup would delete rules / agents / skills source files." >&2
                exit 1
                ;;
        esac
    fi

    # Reject any configured source directory (rules, agents, skills).
    local section src
    for section in rules agents skills; do
        while IFS= read -r src; do
            [ -z "$src" ] && continue
            # Remote sources never resolve to a local output path — skip them
            # so a `git+...` spec is not pattern-matched against the output dir.
            source_is_remote "$src" && continue
            case "$rel" in
                "$src"|"$src/"|"$src"/*)
                    echo "ERROR: targets.$adapter.output ('$rel') overlaps a configured source ('$src')." >&2
                    echo "  Adapter cleanup would delete source content." >&2
                    exit 1
                    ;;
            esac
        done < <(read_yaml_list "$config_file" "$section")
    done
}

# Warn about prompt directories not listed in sources.
# Scans for `rules/` / `agents/` / `skills/` directories anywhere under the
# intelligence source tree and any sibling tree with the same basename
# (e.g. nested per-component intelligence folders). Anything found that is
# not in `sources.*` is flagged. No folder name is hardcoded — the
# intelligence directory is whatever holds `config.yaml`.
warn_unsynced() {
    local repo_root="$1"
    local config_file="$2"

    # Collect all configured source paths (local only — remote git specs are
    # not filesystem dirs and cannot collide with an unsynced local directory).
    local all_sources=()
    for section in rules agents skills; do
        while IFS= read -r src; do
            [ -z "$src" ] && continue
            source_is_remote "$src" && continue
            all_sources+=("$src")
        done < <(read_yaml_list "$config_file" "$section")
    done

    # Collect ignore + submodule patterns.
    local ignores=()
    while IFS= read -r ign; do
        [ -z "$ign" ] && continue
        ignores+=("$ign")
    done < <(read_yaml_list "$config_file" "ignore")
    while IFS= read -r sub; do
        [ -z "$sub" ] && continue
        ignores+=("$sub")
    done < <(read_yaml_list "$config_file" "submodules")

    # Derive the intelligence folder basename from config.yaml's location —
    # whatever the user named it (`intelligence`, `Intelligence`, `prompts`).
    local intel_basename
    intel_basename="$(basename "$(dirname "$config_file")")"

    local warnings=0

    while IFS= read -r found_dir; do
        local rel_dir="${found_dir#$repo_root/}"

        # Skip generated output directories and common excludes.
        case "$rel_dir" in
            .claude/*|.cursor/*|.github/*|.codex/*|.agents/*|*/node_modules/*|*/vendor/*|*/dist/*) continue ;;
        esac

        # Skip ignore/submodule patterns.
        local skip=false
        for ign in "${ignores[@]+"${ignores[@]}"}"; do
            case "$rel_dir" in
                "$ign"/*|*/"$ign"/*) skip=true; break ;;
            esac
        done
        [ "$skip" = true ] && continue

        # Only flag directories whose ancestry includes a folder with the
        # same basename as the intelligence source dir (so we catch
        # `Intelligence/rules`, `apps/billing/intelligence/rules`, etc.,
        # but not unrelated `rules/` / `agents/` directories elsewhere).
        case "/$rel_dir/" in
            *"/$intel_basename/"*) ;;
            *) continue ;;
        esac

        # Check if directory has content worth syncing.
        local has_content=false
        if [ -n "$(find "$found_dir" -maxdepth 1 -name '*.md' 2>/dev/null | head -1)" ]; then
            has_content=true
        fi
        if [ -n "$(find "$found_dir" -maxdepth 2 -name 'SKILL.md' 2>/dev/null | head -1)" ]; then
            has_content=true
        fi
        [ "$has_content" = false ] && continue

        # Check if this directory is in any source array.
        local matched=false
        for src in "${all_sources[@]+"${all_sources[@]}"}"; do
            if [ "$rel_dir" = "$src" ]; then
                matched=true
                break
            fi
        done

        if [ "$matched" = false ]; then
            if [ $warnings -eq 0 ]; then
                echo ""
                echo "=== WARNING: Unsynced directories ==="
            fi
            echo "  NOT SYNCED: $rel_dir"
            warnings=$((warnings + 1))
        fi
    done < <(find "$repo_root" -type d \( -name "rules" -o -name "agents" -o -name "skills" -o -name "Rules" -o -name "Agents" -o -name "Skills" \) 2>/dev/null)

    if [ $warnings -gt 0 ]; then
        echo "  Add these paths to sources: in $(basename "$config_file")"
    fi
}

# --- Config Parsing ---

# Read a simple list from config.yaml
# Format: key:\n  - "value1"\n  - "value2"
# Usage: readarray -t arr < <(read_yaml_list "config.yaml" "rules")
read_yaml_list() {
    local file="$1"
    local section="$2"
    awk -v section="$section" '
        {
            sub(/\r$/, "")
        }
        /^[a-z]/ { current_section = ""; depth = 0 }
        /^  [a-z]/ { current_section = ""; depth = 0 }
        $0 ~ "^" section ":" { current_section = section; depth = 0; next }
        $0 ~ "^  " section ":" { current_section = section; depth = 2; next }
        current_section == section && depth == 0 && /^  - / {
            val = $0
            sub(/^  - /, "", val)
            gsub(/["\047]/, "", val)
            print val
        }
        current_section == section && depth == 2 && /^    - / {
            val = $0
            sub(/^    - /, "", val)
            gsub(/["\047]/, "", val)
            print val
        }
    ' "$file"
}

# Check if a target is enabled in config.yaml (scoped to targets: section)
# Usage: is_target_enabled "config.yaml" "claude"
is_target_enabled() {
    local file="$1"
    local target="$2"
    awk -v target="$target" '
        { sub(/\r$/, "") }

        # Enter/leave the targets: section
        /^targets:[[:space:]]*$/ { in_targets = 1; next }
        /^[a-zA-Z]/ { in_targets = 0 }

        in_targets && $0 ~ "^  " target ":" {
            if ($0 ~ /enabled:[[:space:]]*true/) { print 1; exit }
            if ($0 ~ /enabled:[[:space:]]*false/) { print 0; exit }
            in_target = 1; next
        }
        in_target && /enabled:/ {
            if ($0 ~ /true/) { print 1 } else { print 0 }
            exit
        }
        in_target && /^  [a-zA-Z]/ { print 0; exit }
    ' "$file"
}

# Get an arbitrary field from a target's config block.
# Handles both inline (`claude: { enabled: true, output: ".claude" }`)
# and block form. Uses POSIX awk only — no gawk-specific 3-arg match().
# Usage: get_target_field "config.yaml" "claude" "output"
get_target_field() {
    local file="$1"
    local target="$2"
    local field="$3"
    awk -v target="$target" -v field="$field" '
        { sub(/\r$/, "") }
        /^targets:[[:space:]]*$/ { in_targets = 1; next }
        /^[a-zA-Z]/ { in_targets = 0 }

        in_targets && $0 ~ "^  " target ":" {
            line = $0
            inline_pat = "[ {,]" field ":[[:space:]]*"
            if (match(line, inline_pat)) {
                # Strip everything up to and including the field key.
                rest = substr(line, RSTART + RLENGTH)
                # Cut at the next comma or closing brace.
                if (match(rest, /[,}]/)) {
                    rest = substr(rest, 1, RSTART - 1)
                }
                # Strip surrounding quotes and trailing space.
                gsub(/^["\047]|["\047][[:space:]]*$/, "", rest)
                sub(/[[:space:]]+$/, "", rest)
                if (rest != "") { print rest; exit }
            }
            in_target = 1; next
        }
        in_target && $0 ~ "^    " field ":[[:space:]]*" {
            val = $0
            sub(/.*:[[:space:]]*["\047]?/, "", val)
            sub(/["\047]?[[:space:]]*$/, "", val)
            print val
            exit
        }
        in_target && /^  [a-zA-Z]/ { exit }
    ' "$file"
}

# Get output directory for a target (scoped to targets: section).
# POSIX awk — no 3-arg match().
# Usage: get_target_output "config.yaml" "claude"
get_target_output() {
    local file="$1"
    local target="$2"
    awk -v target="$target" '
        { sub(/\r$/, "") }

        /^targets:[[:space:]]*$/ { in_targets = 1; next }
        /^[a-zA-Z]/ { in_targets = 0 }

        in_targets && $0 ~ "^  " target ":" {
            line = $0
            if (match(line, /output:[[:space:]]*/)) {
                rest = substr(line, RSTART + RLENGTH)
                if (match(rest, /[,}]/)) {
                    rest = substr(rest, 1, RSTART - 1)
                }
                gsub(/^["\047]|["\047][[:space:]]*$/, "", rest)
                sub(/[[:space:]]+$/, "", rest)
                if (rest != "") { print rest; exit }
            }
            in_target = 1; next
        }
        in_target && /output:/ {
            val = $0
            sub(/.*output:[[:space:]]*["\047]?/, "", val)
            sub(/["\047]?[[:space:]]*}?$/, "", val)
            print val
            exit
        }
        in_target && /^  [a-zA-Z]/ { exit }
    ' "$file"
}

# Read a multi-line block scalar (| or > style) from a target's field.
# Usage: get_target_block "config.yaml" "agents" "header"
# Reads YAML of the shape:
#   targets:
#     agents:
#       header: |
#         # Project
#         one-liner
# Strips the common content indent from all lines in the block.
get_target_block() {
    local file="$1"
    local target="$2"
    local field="$3"
    awk -v target="$target" -v field="$field" '
        { sub(/\r$/, "") }

        /^targets:[[:space:]]*$/ { in_targets = 1; next }
        /^[a-zA-Z]/ { in_targets = 0 }

        # State 0: looking for "  <target>:" under targets
        state == 0 && in_targets && $0 ~ "^  " target ":[[:space:]]*$" {
            state = 1
            next
        }

        # State 1: inside target block, looking for "    <field>: |"
        state == 1 {
            if ($0 ~ /^[^ ]/) { exit }             # top-level key — exit
            if ($0 ~ /^  [a-zA-Z]/) { exit }       # another target — exit
            if ($0 ~ "^[[:space:]]+" field ":[[:space:]]*[|>][[:space:]]*$") {
                match($0, /^[[:space:]]+/)
                field_indent = RLENGTH
                state = 2
                block_indent = 0
            }
            next
        }

        # State 2: collecting block contents
        state == 2 {
            if ($0 ~ /^[[:space:]]*$/) {
                print ""
                next
            }
            match($0, /^[[:space:]]*/)
            cur_indent = RLENGTH
            if (cur_indent <= field_indent) { exit }
            if (block_indent == 0) { block_indent = cur_indent }
            if (cur_indent < block_indent) { exit }
            print substr($0, block_indent + 1)
        }
    ' "$file"
}

# Get project name from config.yaml (project.name)
get_project_name() {
    local file="$1"
    awk '
        { sub(/\r$/, "") }
        /^project:/ { in_p = 1; next }
        in_p && /^  name:/ {
            val = $0
            sub(/.*name:[[:space:]]*["\047]?/, "", val)
            sub(/["\047]?[[:space:]]*$/, "", val)
            print val
            exit
        }
        in_p && /^[a-z]/ { exit }
    ' "$file"
}
