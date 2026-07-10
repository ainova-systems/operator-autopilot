/**
 * Lenient fallback parser for AOP text blocks that strict YAML rejected.
 *
 * AOP block bodies are flat `key: value` mappings, so the one structural
 * shape that trips an otherwise well-formed block is an unquoted scalar
 * value containing a colon-space — most commonly a `comment-reply` `note:`
 * that quotes code ("named argument: …") or a method signature. js-yaml
 * reads the inner `: ` as a nested mapping key and throws, which discarded
 * the whole record and forced the supervisor verdict to `failed` even when
 * the underlying fix was fine (PRs #1240/#1241, 2026-07-08).
 *
 * {@link parseAgentOutput} keeps YAML as the primary transport and only
 * calls this on a YAML throw. It lives beside `agent-output-protocol.ts`
 * so that primitive stays focused on the marker state-machine while this
 * file owns the recovery heuristics; ts-prune treats the colocated test as
 * a consumer for module reachability.
 *
 * Fidelity to strict YAML, so a recovered payload validates identically:
 *
 *   - **Bare** scalars are typed as YAML types them — integers → number,
 *     `true`/`false` → boolean, an empty value → `null`.
 *   - **Quoted** scalars stay strings; the quoting is what told YAML so
 *     (`flag: "true"` is the string `"true"`, never the boolean).
 *   - A wrapped plain scalar folds its continuation lines into the value
 *     with a single space, as YAML does.
 *   - Block scalars honour style (`|` literal / `>` folded) and chomping
 *     (`-` strip / `+` keep / default clip).
 *
 * The one thing it never does is mask malformation: content with no `key:`
 * line to attach to returns `null`, and the caller reports the original
 * `yaml-parse-error`.
 */

/** Matches a top-level `key:` line (key at column 0, value optional). */
const KEY_LINE = /^([A-Za-z_][A-Za-z0-9_-]*):(?:[ \t]+(.*))?$/;
/** Block-scalar header: style (`|` literal, `>` folded) + chomping (`-` strip, `+` keep). */
const BLOCK_SCALAR_HEADER = /^([|>])([+-]?)$/;

/**
 * Re-parse a block body strict YAML threw on. Reads each top-level `key:`
 * line and takes the remainder of the line literally, so an embedded colon
 * survives instead of being read as a nested mapping key.
 *
 * Returns `null` when the body has no `key:` line to anchor to — genuinely
 * malformed output (unclosed flow collections, ASCII garbage, a stray line
 * with nothing to continue) then falls through to the caller's
 * `yaml-parse-error` rather than being silently masked.
 */
export function lenientParseBlock(lines: ReadonlyArray<string>): Record<string, unknown> | null {
  const out: Record<string, unknown> = {};
  /** Key of the most recent plain scalar — the only thing a wrapped line may continue. */
  let lastPlainKey: string | null = null;
  let matched = false;
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const keyMatch = line.match(KEY_LINE);

    if (!keyMatch) {
      if (line.trim() === "") {
        // A blank line terminates a plain scalar in YAML; it never continues one.
        lastPlainKey = null;
        i++;
        continue;
      }
      if (lastPlainKey === null) {
        // Nothing to attach this line to — refuse rather than mask.
        return null;
      }
      // Plain-scalar continuation. Dropping it silently truncated long
      // colon-bearing notes — precisely the values this fallback exists to
      // recover, since a note long enough to quote a signature is the one a
      // model wraps.
      out[lastPlainKey] = joinContinuation(out[lastPlainKey], line);
      i++;
      continue;
    }

    matched = true;
    const key = keyMatch[1];
    const inline = (keyMatch[2] ?? "").trim();
    const header = inline.match(BLOCK_SCALAR_HEADER);

    if (header) {
      i++;
      const collected: string[] = [];
      let indent: number | null = null;
      while (i < lines.length) {
        const current = lines[i];
        if (current.trim() === "") {
          collected.push("");
          i++;
          continue;
        }
        const lead = current.length - current.trimStart().length;
        if (lead === 0) break;
        if (indent === null) indent = lead;
        collected.push(current.slice(Math.min(indent, lead)));
        i++;
      }
      out[key] = renderBlockScalar(collected, header[1] === ">", header[2]);
      lastPlainKey = null;
      continue;
    }

    const { value, quoted } = stripSurroundingQuotes(inline);
    out[key] = quoted ? value : coerceScalar(value);
    lastPlainKey = key;
    i++;
  }

  return matched ? out : null;
}

/** Fold a wrapped line into the scalar it continues, joined by a single space. */
function joinContinuation(previous: unknown, line: string): string {
  const text = previous === null || previous === undefined ? "" : String(previous);
  const addition = line.trim();
  return text.length > 0 ? `${text} ${addition}` : addition;
}

/**
 * Render a block scalar: `>` folds interior newlines to spaces (blank-line
 * runs become a single paragraph break), `|` keeps them literal. Chomping
 * then decides the trailing newlines — `-` strips them, `+` keeps every one,
 * and the default clips to exactly one.
 */
function renderBlockScalar(lines: ReadonlyArray<string>, folded: boolean, chomping: string): string {
  const trailingBlanks = countTrailingBlanks(lines);
  const body = folded ? foldLines(lines) : lines.join("\n").replace(/\n+$/, "");
  if (chomping === "-") return body;
  if (chomping === "+") return `${body}${"\n".repeat(trailingBlanks + 1)}`;
  return `${body}\n`;
}

/** Trailing blank lines represent trailing newlines a `+` (keep) chomp preserves. */
function countTrailingBlanks(lines: ReadonlyArray<string>): number {
  let count = 0;
  for (let k = lines.length - 1; k >= 0 && lines[k] === ""; k--) count++;
  return count;
}

/**
 * Fold a `>` block scalar: join consecutive non-blank lines with a single
 * space, and collapse each run of blank lines into one newline.
 */
function foldLines(lines: ReadonlyArray<string>): string {
  const paragraphs: string[] = [];
  let current: string[] = [];
  for (const line of lines) {
    if (line === "") {
      if (current.length > 0) {
        paragraphs.push(current.join(" "));
        current = [];
      }
    } else {
      current.push(line);
    }
  }
  if (current.length > 0) paragraphs.push(current.join(" "));
  return paragraphs.join("\n");
}

/**
 * Strip a single pair of matching surrounding quotes, reporting whether it
 * did. A quoted scalar must skip {@link coerceScalar} — the quotes are what
 * declared it a string.
 */
function stripSurroundingQuotes(value: string): { value: string; quoted: boolean } {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return { value: value.slice(1, -1), quoted: true };
    }
  }
  return { value, quoted: false };
}

/**
 * Type a bare scalar the way strict YAML would: empty → `null`, `true`/
 * `false` → boolean, integers → number, everything else stays a string.
 */
function coerceScalar(value: string): unknown {
  if (value === "") return null;
  if (value === "true") return true;
  if (value === "false") return false;
  if (/^-?\d+$/.test(value)) return Number(value);
  return value;
}
