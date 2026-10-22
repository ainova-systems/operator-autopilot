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

# --- Layout tokens -----------------------------------------------------------
#
# The umbrella folder is named by the project (`intelligence/`, `Intelligence/`,
# a codename) — so an artifact SHIPPED BY THE ENGINE cannot write that name
# down. A rule that scopes itself to the intelligence layer needs `paths:` to
# say "the umbrella", and an agent body needs to name the sync command. Both are
# spelled with tokens, expanded here at output time:
#
#   <umbrella>  ->  the repo-relative umbrella dir   (e.g. `Intelligence`)
#   <module>    ->  the repo-relative engine module  (e.g. `Intelligence/sync`)
#
# Values come from IS_UMBRELLA_REL / IS_MODULE_REL, which sync.sh derives from
# the detected layout (never hardcoded) and exports before any adapter runs.
# Expansion happens in EVERY generated file, frontmatter and body alike, so a
# scoped rule reaches Claude's `paths:`, Cursor's `globs:` and Copilot's
# `applyTo:` already carrying the project's real folder name.

# finalize_output_file <file>
# The single exit gate for every file an adapter writes: expand layout tokens,
# then normalize CRLF -> LF. Adapters MUST call this (not normalize_file_to_lf)
# on each output — a missed call ships a literal `<umbrella>` into an IDE.
finalize_output_file() {
    local target="$1"
    local umb="${IS_UMBRELLA_REL:-intelligence}"
    local mod="${IS_MODULE_REL:-intelligence/sync}"
    local tmp_file="$target.tmp"
    # Literal (index-based) substitution, not gsub: a regex replacement would
    # give `&` in a path its special meaning, and POSIX awk has no way to pass a
    # replacement string verbatim.
    awk -v umb="$umb" -v mod="$mod" '
        function repl(s, from, to,   out, i) {
            out = ""
            while ((i = index(s, from)) > 0) {
                out = out substr(s, 1, i - 1) to
                s = substr(s, i + length(from))
            }
            return out s
        }
        {
            sub(/\r$/, "")
            $0 = repl($0, "<module>", mod)
            $0 = repl($0, "<umbrella>", umb)
            print
        }
    ' "$target" > "$tmp_file"
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

# True (0) if a source token references a pack declared under `packs:`
# (`@<name>` or `@<name>/<subpath>`).
source_is_pack() {
    case "$1" in
        @?*) return 0 ;;
        *)   return 1 ;;
    esac
}

# True (0) if a source token is a plain repo-relative path — i.e. NOT a pack
# reference and NOT an inline remote spec. The inverse of "resolves through a
# clone", which is what every caller that pattern-matches a token against a
# real directory needs.
source_is_local_path() {
    source_is_pack "$1" && return 1
    source_is_remote "$1" && return 1
    return 0
}

# Map an absolute file path to a repo-root-relative path for use as a link
# target inside a COMMITTED file (e.g. AGENTS.md). A file under $repo_root gets
# its repo-relative path. A file resolved OUTSIDE $repo_root comes from a remote
# source materialized in the transient clone cache and has NO stable,
# committable path, so this returns the empty string — callers MUST then emit
# the bare name, never the absolute path. The `${path#"$repo_root"/}` strip is a
# no-op when $path is not under $repo_root, which is how the out-of-repo case is
# detected.
repo_rel_link() {
    local repo_root="$1" path="$2" rel
    rel="${path#"$repo_root"/}"
    [ "$rel" = "$path" ] && return 0
    printf '%s' "$rel"
}

# Repo-root-relative path of an existing DIRECTORY — by identity, not spelling.
# `${dir#"$repo_root"/}` is a plain string strip, which silently yields the
# unchanged absolute path when the two were produced from different spellings of
# the same location. That is not hypothetical: Git Bash reaches the Windows temp
# dir through two mounts (`/tmp/...` and `/c/Users/.../Temp/...`) and `pwd`
# prints whichever one you arrived through, so `REPO_ROOT` (from `git
# rev-parse`) and `LS_UMBRELLA_DIR` (from the invocation path) can disagree
# character-by-character while naming the same directory. AGENTS.md is
# committed, so a failed strip would bake a machine-specific absolute path into
# version control.
#
# Walks up from <dir> comparing each ancestor to <repo_root> with `-ef`
# (device+inode — identity, immune to spelling), collecting basenames.
# Echoes "" when <dir> is not inside <repo_root>, or does not exist.
# Usage: rel="$(repo_rel_dir "$repo_root" "$LS_MODULE_DIR")"   # -> intelligence/sync
repo_rel_dir() {
    local repo_root="$1" dir="$2"
    local cur rel="" parent base depth=0
    cur="$(cd "$dir" 2>/dev/null && pwd)" || return 0
    [ -d "$repo_root" ] || return 0
    while [ "$depth" -lt 64 ]; do
        if [ "$cur" -ef "$repo_root" ]; then
            printf '%s' "$rel"
            return 0
        fi
        parent="$(dirname "$cur")"
        base="$(basename "$cur")"
        [ "$parent" = "$cur" ] && return 0      # reached the filesystem root
        rel="$base${rel:+/$rel}"
        cur="$parent"
        depth=$((depth + 1))
    done
}

# Resolve a single source token to an absolute local directory.
#   Local token  -> "$repo_root/$token".
#   Remote token -> shallow-clone into the run cache, echo "<clone>/<subpath>".
# ALWAYS returns 0 (echoes nothing on failure) so `set -e` callers using
# `dir="$(resolve_source_dir ...)"` never abort; the caller's existing
# `[ -d "$dir" ] || continue` guard then skips an unresolved source.
# Usage: dir="$(resolve_source_dir "$repo_root" "$src")"
resolve_source_dir() {
    local repo_root="$1" token="$2" config_file="${3:-${IS_CONFIG_FILE:-}}"

    # A declared pack (`@<name>[/<subpath>]`) keeps its url / ref / mirror in
    # config.yaml, so the token itself carries nothing but the reference.
    if source_is_pack "$token"; then
        resolve_pack_source "$repo_root" "$config_file" "$token"
        return 0
    fi

    if ! source_is_remote "$token"; then
        printf '%s' "$repo_root/$token"
        return 0
    fi

    # --- parse: git+<url>[@<ref>][#<subpath>] ---
    # An inline spec is an ANONYMOUS pack: it has no declared name and no
    # mirror, so it is always transient. Declare it under `packs:` to commit it.
    local rest="${token#git+}"
    local subpath="" urlref="$rest"
    case "$rest" in
        *\#*) subpath="${rest#*#}"; urlref="${rest%%#*}" ;;
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

    fetch_remote_source "$token" "$url" "$ref" "$subpath" ""
}

# Resolve `@<name>[/<subpath>]` against the `packs:` block and fetch it.
# An undeclared name is a HARD error: unlike a mistyped local path (which the
# caller's `[ -d ]` guard silently skips), a pack reference names something the
# config claims to know, so a typo must not quietly drop a whole rule set.
# Usage: resolve_pack_source "$repo_root" "$config_file" "@shared/rules"
resolve_pack_source() {
    local repo_root="$1" config_file="$2" token="$3"

    local rest="${token#@}" name subpath=""
    case "$rest" in
        */*) name="${rest%%/*}"; subpath="${rest#*/}" ;;
        *)   name="$rest" ;;
    esac

    local url ref mirror_rel mirror_abs=""
    url="$(get_pack_field "$config_file" "$name" "url")"
    # Defensive only: validate_pack_refs has already failed the run for an
    # undeclared pack. It has to, because every caller invokes this inside `$( )`
    # — an exit here would end the substitution subshell, not the sync.
    if [ -z "$url" ]; then
        echo "  WARN: pack '$name' is not declared under 'packs:': $token" >&2
        return 0
    fi
    ref="$(get_pack_field "$config_file" "$name" "ref")"
    mirror_rel="$(get_pack_field "$config_file" "$name" "mirror")"
    [ -n "$mirror_rel" ] && mirror_abs="$(resolve_mirror_dir "$repo_root" "$config_file" "$name" "$mirror_rel")"

    fetch_remote_source "$token" "$url" "$ref" "$subpath" "$mirror_abs" "$mirror_rel"
}

# Shallow-clone <url>@<ref> into the run cache, echo "<clone>/<subpath>", and —
# when <mirror_abs> is set — additionally materialize it there so the content is
# committed. <token> is only used for messages.
# ALWAYS returns 0 (echoes nothing on failure), per resolve_source_dir's contract.
# Usage: fetch_remote_source <token> <url> <ref> <subpath> <mirror_abs> [<mirror_rel>]
fetch_remote_source() {
    local token="$1" url="$2" ref="$3" subpath="$4" mirror="$5" mirror_rel="${6:-}"

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
    case "$url" in
        https://*|http://*|ssh://*|git://*|file://*) ;;
        *)
            echo "  WARN: remote source rejected (unsupported scheme): $token" >&2
            return 0
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
        #
        # Line endings are pinned for the same reason the engine's own
        # `.gitattributes` pins them: the checkout must not depend on the host's
        # `core.autocrlf`. On Windows that default rewrites a pack declaring no
        # attributes to CRLF, `materialize_pack` copies bytes verbatim, and the
        # mirror lands CRLF inside the project repo — a phantom diff that returns
        # on every sync. `autocrlf=false` covers packs with no attributes,
        # `eol=lf` covers those that mark files `text`.
        local git_cfg=(-c core.symlinks=false -c core.autocrlf=false -c core.eol=lf)
        local ok=0
        if [ -n "$ref" ]; then
            if GIT_TERMINAL_PROMPT=0 git "${git_cfg[@]}" clone --depth 1 --branch "$ref" --quiet \
                "$url" "$dest" 2>/dev/null; then
                ok=1
            else
                # ref is likely a SHA (not a branch/tag) — full clone + checkout.
                rm -rf "$dest"
                if GIT_TERMINAL_PROMPT=0 git "${git_cfg[@]}" clone --quiet "$url" "$dest" 2>/dev/null \
                    && git -C "$dest" "${git_cfg[@]}" checkout --quiet "$ref" 2>/dev/null; then
                    ok=1
                fi
            fi
        elif GIT_TERMINAL_PROMPT=0 git "${git_cfg[@]}" clone --depth 1 --quiet "$url" "$dest" 2>/dev/null; then
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

    # No `mirror:` -> the clone stays in the transient run cache and nothing
    # lands in the repo. This is every inline `git+` spec, and any pack that
    # declares no mirror.
    if [ -z "$mirror" ]; then
        printf '%s' "$out"
        return 0
    fi
    materialize_pack "$dest" "$out" "$url" "$ref" "$subpath" "$mirror" "$mirror_rel"
    return 0
}

# Copy a resolved remote source out of the transient clone into the pack's
# declared `mirror:` directory, so pack content is committed and an upstream
# bump shows up in `git diff` instead of only in the generated output. Echoes
# the materialized directory; on any failure echoes the clone dir instead, so a
# broken mirror degrades to the transient behaviour rather than losing the
# source.
#
# The directory is DECLARED, never derived — `mirror:` says exactly where the
# pack lives, so there is no name to sanitize and no collision to resolve.
#
# The FIRST token to touch a pack in a run wipes it (clearing content left by a
# previous ref, or by a source entry that has since been removed); later tokens
# for the same pack only replace their own subpath. The claim is recorded in the
# clone cache, which is what makes "wipe once per run" work across the separate
# subshells each resolve_source_dir call runs in.
#
# The wipe is guarded by the stamp: a NON-EMPTY directory with no `.pack` in it
# is never deleted — it belongs to the project, not to us.
# <mirror_rel> is the path as authored in config.yaml, used only in messages.
# Usage: materialize_pack <clone> <src_dir> <url> <ref> <subpath> <mirror> <mirror_rel>
materialize_pack() {
    local clone="$1" src_dir="$2" url="$3" ref="$4" subpath="$5" pack_dir="$6" mirror_rel="${7:-}"

    # The claim is keyed on the DIRECTORY, not on url@ref: it records "this run
    # already cleared this path". Keying it on the clone would let two packs
    # that share a url@ref but declare different mirrors claim each other's,
    # leaving the second mirror unstamped and never pruned.
    #
    # Same cache-root fallback as the clone: the claim must exist even when the
    # caller is not sync.sh, or every token would re-wipe the pack and only the
    # last subpath would survive. That fallback root is NOT run-scoped, though,
    # so the claim carries `$$` — stable across the command-substitution
    # subshells of one run, different for the next. A claim left behind by an
    # earlier run must never suppress this run's wipe: that would rebuild the
    # mirror with no `.pack` in it and freeze it against the guard below.
    local cache_root claim
    cache_root="${IS_REMOTE_CACHE:-${TMPDIR:-/tmp}/intelligence-sync-remotes}"
    mkdir -p "$cache_root" 2>/dev/null || true
    claim="$cache_root/$$-$(printf '%s' "$pack_dir" | cksum | awk '{print $1 "-" $2}').packdir"

    if [ ! -f "$claim" ]; then
        # Refuse to wipe a directory that is not ours. Ownership is the PRESENCE
        # of the stamp, not the url inside it: a mirror is declared per pack, so
        # a stamped directory is this pack's even after its `url:` is edited —
        # a moved or renamed upstream must refresh the mirror, not freeze it at
        # the old content while the generated output silently follows the new.
        if [ -d "$pack_dir" ] && [ -n "$(find "$pack_dir" -mindepth 1 -maxdepth 1 2>/dev/null)" ] \
            && [ ! -f "$pack_dir/.pack" ]; then
            echo "  WARN: mirror '$pack_dir' holds content that is not a pack's (no .pack stamp) — skipping materialization" >&2
            printf '%s' "$src_dir"
            return 0
        fi

        rm -rf "$pack_dir"
        if ! mkdir -p "$pack_dir"; then
            echo "  WARN: cannot create mirror dir '$pack_dir' — using the run cache" >&2
            printf '%s' "$src_dir"
            return 0
        fi
        {
            printf 'url=%s\n' "$url"
            printf 'ref=%s\n' "${ref:-<default>}"
            printf 'sha=%s\n' "$(git -C "$clone" rev-parse HEAD 2>/dev/null || echo unknown)"
        } > "$pack_dir/.pack"
        printf '%s\n' "$pack_dir" > "$claim"
        echo "  pack: $url${ref:+ @$ref} -> ${mirror_rel:-$pack_dir}" >&2
    fi

    # Only a subpath is cleared here — clearing the pack root would delete the
    # `.pack` stamp written above (and any sibling subpath already copied in
    # this run). The root is already clean: the claim step wiped it.
    local dest="$pack_dir"
    if [ -n "$subpath" ]; then
        dest="$pack_dir/$subpath"
        rm -rf "$dest"
    fi
    mkdir -p "$dest"

    # Copy the subpath's contents, skipping `.git` — it only exists when the
    # source IS the clone root (no `#subpath`), and a nested `.git` inside the
    # project repo would be recorded as a gitlink, which is exactly the
    # untrackable state this whole feature exists to avoid.
    local entry base
    for entry in "$src_dir"/* "$src_dir"/.[!.]*; do
        [ -e "$entry" ] || continue
        base="${entry##*/}"
        [ "$base" = ".git" ] && continue
        cp -R "$entry" "$dest/"
    done

    printf '%s' "$dest"
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

# Copy a skill directory in full: SKILL.md plus any bundled resources
# (references/, scripts/, assets/ — the Agent Skills standard lets a skill
# ship support files beside SKILL.md, and SKILL.md bodies point at them by
# relative path, so dropping them breaks the skill at runtime). Markdown is
# normalized to LF; every other file is copied byte-for-byte so potentially
# binary assets survive. `cp -R` copies symlinks as symlinks (POSIX), so a
# link inside a source skill never leaks host file content into the output.
#
# SKILL.md frontmatter is quoted for EVERY consumer, not only the strict-YAML
# ones. `argument-hint: [pr-number]` is a YAML *flow sequence*, so an unquoted
# hint arrives as a list and Claude Code refuses the whole skill with
# "argument-hint must be a string" — the skill silently disappears from the
# picker. Quoting is idempotent: an already-quoted value passes through
# untouched.
# Usage: copy_skill_bundle "src/skill/dir" "dest/skill/dir"
copy_skill_bundle() {
    local src_dir="${1%/}"
    local dest_dir="$2"
    mkdir -p "$dest_dir"
    cp -R "$src_dir/." "$dest_dir/"
    # A symlinked SKILL.md is left exactly as `cp -R` produced it — a symlink.
    # `[ -f ]` follows links, so quoting it would read the link's TARGET and
    # write that content into a real file, turning `skills/x/SKILL.md -> /etc/…`
    # into a copy of a host file inside the output. That is the leak the
    # symlink-preserving copy exists to prevent, so skip the rewrite and say so
    # (the same reason `find -type f` below never matches a symlink).
    if [ -L "$dest_dir/SKILL.md" ]; then
        echo "  WARN: $(basename "$dest_dir")/SKILL.md is a symlink — emitted as-is (frontmatter not quoted, tokens not expanded)" >&2
    elif [ -f "$dest_dir/SKILL.md" ]; then
        copy_md_with_quoted_frontmatter "$dest_dir/SKILL.md" "$dest_dir/SKILL.md.tmp-q"
        mv "$dest_dir/SKILL.md.tmp-q" "$dest_dir/SKILL.md"
    fi
    while IFS= read -r f; do
        [ -n "$f" ] || continue
        finalize_output_file "$f"
    done < <(find "$dest_dir" -type f -name '*.md')
}

# Copy skill directories into an Agent Skills open-standard location.
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
            # copy_skill_bundle now owns the frontmatter-quoting pass, so every
            # target gets it — not just this open-standard dir.
            copy_skill_bundle "$d" "$output_dir/$skill_name"
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
        # Field-length limits. Both Claude Code and the Agent Skills standard
        # reject an over-long description outright ("Skill description must be
        # at most 1024 characters") and the skill vanishes from the picker with
        # no other signal, so catching it at sync time is the only cheap warning
        # the author ever gets. Measured on the value, quotes excluded; a block
        # scalar (`description: |`) is skipped — its length is not on this line.
        in_fm && /^(description|name):[[:space:]]*[^|>[:space:]]/ {
            key = substr($0, 1, index($0, ":") - 1)
            val = substr($0, index($0, ":") + 1)
            sub(/^[[:space:]]+/, "", val); sub(/[[:space:]]+$/, "", val)
            first = substr(val, 1, 1); last = substr(val, length(val), 1)
            if ((first == "\"" && last == "\"") || (first == "\047" && last == "\047")) {
                val = substr(val, 2, length(val) - 2)
            }
            limit = (key == "name") ? 64 : 1024
            if (length(val) > limit) {
                printf "  WARN: %s:%d %s is %d chars — over the %d-char limit; the skill/agent will be REJECTED at load time\n", f, line, key, length(val), limit > "/dev/stderr"
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
# When you bump these, re-run sync in projects; any project whose config.yaml
# `models:` section diverges from these will print a drift warning so users
# know their override is now stale.
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
        copilot:heavy)    echo "gpt-5.6-sol" ;;
        copilot:standard) echo "gpt-5.6-terra" ;;
        copilot:light)    echo "gpt-5.6-luna" ;;
        codex:heavy)      echo "gpt-5.6-sol" ;;
        codex:standard)   echo "gpt-5.6-terra" ;;
        codex:light)      echo "gpt-5.6-luna" ;;
        opencode:heavy)    echo "anthropic/claude-opus-4-8" ;;
        opencode:standard) echo "anthropic/claude-sonnet-5" ;;
        opencode:light)    echo "anthropic/claude-haiku-4-5-20251001" ;;
        *)                echo "" ;;
    esac
}

# Read a nested key from config.yaml: section -> sub -> key.
# Resolves `models.<ide>.<tier>` overrides and `packs.<name>.<field>`.
#
# The value strip is anchored at the FIRST colon (`[^:]*:`), never a greedy
# `.*:` — a greedy match cuts at the LAST colon on the line, which turns
# `url: https://host/repo.git` into `//host/repo.git`. An unquoted value also
# drops a trailing ` # comment`, per YAML; inside quotes a `#` is content.
#
# The sub-key is matched LITERALLY (`index(...) == 1`), never interpolated into
# a regex: a pack name may contain `.`, which as a pattern is any character, so
# `packs.a.b` would happily read a pack named `axb`.
get_nested_yaml_value() {
    local file="$1"
    local section="$2"
    local sub="$3"
    local key="$4"
    awk -v section="$section" -v subname="$sub" -v key="$key" '
        { sub(/\r$/, "") }
        $0 ~ "^" section ":[[:space:]]*$" { in_section=1; in_sub=0; next }
        in_section && /^[a-zA-Z]/ && $0 !~ "^" section ":" { in_section=0; in_sub=0 }
        in_section && index($0, "  " subname ":") == 1 {
            if (substr($0, length(subname) + 4) ~ /^[[:space:]]*$/) { in_sub=1; next }
        }
        in_section && in_sub && /^  [A-Za-z0-9_]/ { in_sub=0 }
        in_section && in_sub && index($0, "    " key ":") == 1 {
            val = $0
            sub(/^[[:space:]]*[^:]*:[[:space:]]*/, "", val)
            if (val ~ /^"/ || val ~ /^\047/) {
                q = substr(val, 1, 1)
                val = substr(val, 2)
                i = index(val, q)
                if (i > 0) val = substr(val, 1, i - 1)
            } else {
                sub(/[[:space:]]+#.*$/, "", val)
                sub(/[[:space:]]+$/, "", val)
            }
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
        # full: emit NO tools list at all. Confirmed empirically in Copilot (VSCode,
        # reading .claude/agents): a closed tools list restricts the agent to exactly
        # those tools and loses MCP; omitting the field lets it inherit every session
        # tool, MCP servers included. tools: ["*"] did NOT enable MCP - omission does.
        # (Claude Code behaves the same: no tools field = inherit all incl MCP.)
        # NOTE: omission also inherits Pylance + all built-ins, which can push the
        # request over Copilot's 128-tool cap and trigger virtual-tools grouping that
        # intermittently hides MCP. The durable fix is an explicit allowlist that
        # NAMES the MCP servers (umbraco-mcp/*, figma/*) and stays under 128; that
        # needs the project's MCP server list, so it is tracked, not encoded here yet.
        *)        echo "" ;;
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

# Lexically canonicalize a path: collapse `//`, `.` and `..` by pure string
# surgery, so a path that does not exist yet still normalizes (realpath -m is
# not POSIX and `cd` only works on dirs that exist). Symlinks are NOT resolved
# — validate_output_path pairs this with a `cd -P` check for paths that do
# exist.
# Usage: canon="$(normalize_path "/repo/a/../b")"   # -> /repo/b
normalize_path() {
    local path="$1" p out=""
    local -a parts
    IFS='/' read -r -a parts <<< "$path"
    for p in "${parts[@]+"${parts[@]}"}"; do
        case "$p" in
            ""|".") ;;
            "..")   out="${out%/*}" ;;
            *)      out="$out/$p" ;;
        esac
    done
    printf '%s' "${out:-/}"
}

# Refuse to operate on output paths that could clobber content.
# Adapters `rm -rf` subdirectories of $output_dir, and the `agents` adapter
# overwrites whatever single file it is pointed at; if config.yaml aims an
# adapter at the repo root, outside the repo, at the intelligence source tree
# (whatever the user named it), or at any configured source directory, that
# write would destroy real work. Call this from sync.sh before invoking EVERY
# adapter — `agents` included: writing one file to an arbitrary path is a
# config-file-to-arbitrary-write path, no less than a cleanup is.
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

    # Canonicalize FIRST. Every check below is a string comparison, so a `../`
    # left in the raw value would walk straight past all of them.
    local canon
    canon="$(normalize_path "$output_dir")"

    case "$canon" in
        ""|"/"|"$repo_root")
            echo "ERROR: targets.$adapter.output resolves to repo root or empty path: '$output_dir'" >&2
            echo "  Refusing to run — the adapter would destroy repository content." >&2
            exit 1
            ;;
    esac

    # Must stay inside the repository.
    case "$canon" in
        "$repo_root"/*) ;;
        *)
            echo "ERROR: targets.$adapter.output escapes the repository: '$output_dir'" >&2
            echo "  Resolves to '$canon', outside '$repo_root'." >&2
            exit 1
            ;;
    esac

    # A symlink ANYWHERE on the path can still lead out of the repo, which the
    # lexical pass above cannot see. The output itself usually does not exist on
    # a first sync, so checking only an existing final directory would miss the
    # common case (`.cursor` absent, but its parent `generated/` symlinked out).
    # Walk up to the deepest component that does exist and resolve THAT
    # physically. `-L` in the loop guard so a broken symlink is caught rather
    # than stepped over.
    local probe="$canon" parent
    while [ ! -e "$probe" ] && [ ! -L "$probe" ]; do
        parent="$(dirname "$probe")"
        [ "$parent" = "$probe" ] && break
        probe="$parent"
    done

    if [ -e "$probe" ] || [ -L "$probe" ]; then
        # A symlinked FILE target (e.g. `AGENTS.md` -> /etc/hosts, or a dangling
        # link) would be written straight through. Refuse rather than follow it;
        # a generated output is never legitimately a file symlink.
        if [ -L "$probe" ] && [ ! -d "$probe" ]; then
            echo "ERROR: targets.$adapter.output ('$output_dir') resolves through a symlink ('$probe')." >&2
            echo "  Refusing to write through it." >&2
            exit 1
        fi
        # Symlinked directory: allowed only while its physical target stays
        # inside the repo (`pwd -P` on both sides so a symlinked repo root
        # resolves consistently).
        local probe_dir phys repo_phys
        if [ -d "$probe" ]; then probe_dir="$probe"; else probe_dir="$(dirname "$probe")"; fi
        phys="$(cd "$probe_dir" 2>/dev/null && pwd -P)" || phys=""
        repo_phys="$(cd "$repo_root" && pwd -P)"
        case "${phys:-/nonexistent}" in
            "$repo_phys"|"$repo_phys"/*) ;;
            *)
                echo "ERROR: targets.$adapter.output ('$output_dir') resolves through a symlink to '$phys'," >&2
                echo "  which is outside the repository. Refusing to run." >&2
                exit 1
                ;;
        esac
    fi

    local rel="${canon#"$repo_root"/}"

    # Reject the intelligence source directory itself (parent of config.yaml).
    # Folder name is whatever the user chose — we read it from the filesystem.
    local intel_dir intel_rel
    intel_dir="$(cd "$(dirname "$config_file")" && pwd)"
    intel_rel="${intel_dir#"$repo_root"/}"
    if [ -n "$intel_rel" ] && [ "$intel_rel" != "$intel_dir" ]; then
        case "$rel" in
            "$intel_rel"|"$intel_rel"/*)
                echo "ERROR: targets.$adapter.output points into the intelligence source tree ('$intel_rel'): '$rel'" >&2
                echo "  The adapter would overwrite or delete rules / agents / skills source files." >&2
                exit 1
                ;;
        esac
    fi

    # Reject any configured source directory (rules, agents, skills).
    local section src src_rel
    for section in rules agents skills; do
        while IFS= read -r src; do
            [ -z "$src" ] && continue
            # Remote sources never resolve to a local output path — skip them
            # so a `git+...` spec or an `@pack` reference is not pattern-matched
            # against the output dir. A mirrored pack is covered separately,
            # below, by its declared `mirror:`.
            source_is_local_path "$src" || continue
            src_rel="$(normalize_path "$repo_root/$src")"
            src_rel="${src_rel#"$repo_root"/}"
            case "$rel" in
                "$src_rel"|"$src_rel"/*)
                    echo "ERROR: targets.$adapter.output ('$rel') overlaps a configured source ('$src')." >&2
                    echo "  The adapter would overwrite or delete source content." >&2
                    exit 1
                    ;;
            esac
        done < <(read_yaml_list "$config_file" "$section")
    done

    # Reject any pack mirror — materialized pack content is source, and it is
    # committed, so an adapter cleanup aimed at it would delete work that is not
    # regenerated until the next successful clone.
    local mirror_rel
    while IFS= read -r mirror_rel; do
        [ -z "$mirror_rel" ] && continue
        case "$rel" in
            "$mirror_rel"|"$mirror_rel"/*)
                echo "ERROR: targets.$adapter.output ('$rel') points into a pack mirror ('$mirror_rel')." >&2
                echo "  The adapter would delete materialized pack content." >&2
                exit 1
                ;;
        esac
    done < <(list_pack_mirrors "$repo_root" "$config_file")
}

# Resolve and validate one pack's `mirror:` into an absolute directory.
#
# materialize_pack `rm -rf`s this path, so the same class of check that guards
# adapter outputs applies — with one deliberate difference: a mirror is ALLOWED
# inside the intelligence umbrella, since `<umbrella>/external/<pack>` is the
# recommended place for it.
#
# Echoes the absolute path; exits 1 with a clear message on rejection.
# Usage: resolve_mirror_dir "$REPO_ROOT" "$CONFIG_FILE" <pack-name> <mirror-rel>
resolve_mirror_dir() {
    local repo_root="$1" config_file="$2" name="$3" rel="$4"

    local canon
    canon="$(normalize_path "$repo_root/$rel")"

    case "$canon" in
        ""|"/"|"$repo_root")
            echo "ERROR: packs.$name.mirror resolves to repo root or empty path: '$rel'" >&2
            exit 1
            ;;
    esac
    case "$canon" in
        "$repo_root"/*) ;;
        *)
            echo "ERROR: packs.$name.mirror escapes the repository: '$rel' (resolves to '$canon')." >&2
            exit 1
            ;;
    esac

    # Never inside a configured source tree: a pack directory created there
    # would be `rm -rf`d alongside authored rules / agents / skills.
    local canon_rel section src src_rel
    canon_rel="${canon#"$repo_root"/}"
    for section in rules agents skills; do
        while IFS= read -r src; do
            [ -z "$src" ] && continue
            source_is_local_path "$src" || continue
            src_rel="$(normalize_path "$repo_root/$src")"
            src_rel="${src_rel#"$repo_root"/}"
            case "$canon_rel" in
                "$src_rel"|"$src_rel"/*)
                    echo "ERROR: packs.$name.mirror ('$rel') is inside a configured source ('$src')." >&2
                    echo "  Materializing a pack there would overwrite authored content." >&2
                    exit 1
                    ;;
            esac
        done < <(read_yaml_list "$config_file" "$section")
    done

    printf '%s' "$canon"
}

# Fail the run on a `@<pack>` source that names a pack the config does not
# declare, and on a declared `mirror:` that is unsafe to `rm -rf`.
#
# This runs UP FRONT, before any adapter, because resolve_source_dir is always
# called inside `$( )`: an error raised down there would exit the substitution
# subshell only, and the caller's `[ -d "$dir" ] || continue` guard would turn a
# typo into a silently dropped rule set — the exact failure this feature exists
# to remove. A missing local path stays a warning; a bad pack reference does not,
# because the config claims to know that name.
#
# Exits 1 with a clear message on rejection.
# Usage: validate_pack_refs "$REPO_ROOT" "$CONFIG_FILE"
validate_pack_refs() {
    local repo_root="$1" config_file="$2"
    local section src name known bad=0

    for section in rules agents skills; do
        while IFS= read -r src; do
            [ -z "$src" ] && continue
            source_is_pack "$src" || continue
            name="${src#@}"
            name="${name%%/*}"
            if [ -z "$(get_pack_field "$config_file" "$name" "url")" ]; then
                echo "ERROR: sources.$section entry '$src' references pack '$name', which has no 'packs.$name.url' in $config_file." >&2
                bad=1
            fi
        done < <(read_yaml_list "$config_file" "$section")
    done

    if [ "$bad" -ne 0 ]; then
        known="$(read_yaml_keys "$config_file" "packs" | tr '\n' ' ')"
        echo "  Declared packs: ${known:-<none>}" >&2
        # `targets:` accepts the flow form, so a user reasonably writes
        # `packs:\n  shared: { url: … }` — which reads as zero declared packs and
        # makes the message above point at a typo that is not there. Scoped to
        # the `packs:` block: every shipped example writes `targets:` in flow
        # form, so an unscoped match would print this note on every failure.
        if awk '
            { sub(/\r$/, "") }
            /^packs:[[:space:]]*$/ { in_p = 1; next }
            /^[A-Za-z]/ { in_p = 0 }
            in_p && /^  [A-Za-z0-9_][A-Za-z0-9._-]*:[[:space:]]*\{/ { found = 1; exit }
            END { exit !found }
        ' "$config_file"; then
            echo "  Note: a pack must be declared in block form — 'name:' on its own line," >&2
            echo "        then indented 'url:' / 'ref:' / 'mirror:'. The '{ … }' form is not read here." >&2
        fi
        exit 1
    fi

    # Validate every declared mirror once, before a single clone runs, so an
    # unsafe path fails the run rather than being discovered mid-materialization.
    #
    # Two packs sharing one mirror is refused here too: the wipe is claimed per
    # DIRECTORY, so the second pack would skip the clear and copy its subpaths
    # in beside the first's, leaving one directory holding two packs' content
    # under a single `.pack`. Nothing downstream can untangle that.
    local rel canon i
    local mirror_dirs=() mirror_owners=()
    while IFS= read -r name; do
        [ -z "$name" ] && continue
        rel="$(get_pack_field "$config_file" "$name" "mirror")"
        [ -n "$rel" ] || continue
        canon="$(resolve_mirror_dir "$repo_root" "$config_file" "$name" "$rel")"
        i=0
        while [ "$i" -lt "${#mirror_dirs[@]}" ]; do
            if [ "${mirror_dirs[$i]}" = "$canon" ]; then
                echo "ERROR: packs.$name.mirror ('$rel') is already the mirror of pack '${mirror_owners[$i]}'." >&2
                echo "  Each pack needs its own directory — sharing one leaves a single '.pack' stamp" >&2
                echo "  naming one pack over a directory holding both packs' content." >&2
                exit 1
            fi
            i=$((i + 1))
        done
        mirror_dirs+=("$canon"); mirror_owners+=("$name")
    done < <(read_yaml_keys "$config_file" "packs")
}

# Every declared pack's `mirror:`, one repo-relative path per line (packs with
# no mirror contribute nothing). Used by the guards that must not mistake
# materialized pack content for either an adapter output or an unsynced source.
# Usage: readarray -t mirrors < <(list_pack_mirrors "$REPO_ROOT" "$CONFIG_FILE")
list_pack_mirrors() {
    local repo_root="$1" config_file="$2"
    local name rel canon
    while IFS= read -r name; do
        [ -z "$name" ] && continue
        rel="$(get_pack_field "$config_file" "$name" "mirror")"
        [ -n "$rel" ] || continue
        canon="$(normalize_path "$repo_root/$rel")"
        printf '%s\n' "${canon#"$repo_root"/}"
    done < <(read_yaml_keys "$config_file" "packs")
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

    # Collect all configured source paths (local only — a remote spec and an
    # `@pack` reference are not filesystem dirs and cannot collide with an
    # unsynced local directory).
    local all_sources=()
    for section in rules agents skills; do
        while IFS= read -r src; do
            [ -z "$src" ] && continue
            source_is_local_path "$src" || continue
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
    # Materialized packs hold rules/ agents/ skills/ dirs that are reached
    # through their `@<pack>` source entry, never listed as local sources — so
    # the scan below would flag every one of them as unsynced.
    local mirror_rel
    while IFS= read -r mirror_rel; do
        [ -n "$mirror_rel" ] && ignores+=("${mirror_rel%/}")
    done < <(list_pack_mirrors "$repo_root" "$config_file")

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

# Read a scalar field out of a top-level config block: `section:` -> `  key:`.
# The single two-level reader — `get_nested_yaml_value` and `get_target_field`
# cover the three-level shapes (`models.<ide>.<tier>`, `targets.<name>.<field>`).
# Usage: get_yaml_field "config.yaml" "external" "dir"
get_yaml_field() {
    local file="$1"
    local section="$2"
    local key="$3"
    awk -v section="$section" -v key="$key" '
        { sub(/\r$/, "") }
        $0 ~ "^" section ":" { in_section = 1; next }
        in_section && /^[a-zA-Z]/ { exit }
        in_section && $0 ~ "^  " key ":" {
            val = $0
            sub(/.*:[[:space:]]*["\047]?/, "", val)
            sub(/["\047]?[[:space:]]*$/, "", val)
            print val
            exit
        }
    ' "$file"
}

# Get project name from config.yaml (project.name)
get_project_name() {
    get_yaml_field "$1" "project" "name"
}

# One field of a declared pack: `packs.<name>.<url|ref|mirror>`.
# `mirror` empty means the pack is transient — cloned per run, never committed.
get_pack_field() {
    get_nested_yaml_value "$1" "packs" "$2" "$3"
}

# Immediate sub-keys of a top-level block, one per line (`packs:` → pack names).
# Block form only: a pack always spans several lines, so the inline `{...}` form
# that `get_target_field` accommodates has no use here.
# Usage: readarray -t names < <(read_yaml_keys "config.yaml" "packs")
read_yaml_keys() {
    local file="$1" section="$2"
    [ -f "$file" ] || return 0
    awk -v section="$section" '
        { sub(/\r$/, "") }
        $0 ~ "^" section ":[[:space:]]*$" { in_sec = 1; next }
        /^[A-Za-z]/ { in_sec = 0 }
        in_sec && /^  [A-Za-z0-9_][A-Za-z0-9._-]*:[[:space:]]*$/ {
            k = $0
            sub(/^[[:space:]]+/, "", k)
            sub(/:[[:space:]]*$/, "", k)
            print k
        }
    ' "$file"
}
