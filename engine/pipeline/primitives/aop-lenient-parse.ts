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
 */

/** Matches a top-level `key:` line (key at column 0, value optional). */
const KEY_LINE = /^([A-Za-z_][A-Za-z0-9_-]*):(?:[ \t]+(.*))?$/;
/** Matches a YAML block-scalar indicator, capturing `|` (literal) or `>` (folded). */
const BLOCK_SCALAR_INDICATOR = /^([|>])[+-]?$/;

/**
 * Re-parse a block body strict YAML threw on. Reads each top-level `key:`
 * line and takes the remainder of the line literally (so an embedded colon
 * survives), honouring `key: |` (literal) and `key: >` (folded) block
 * scalars and coercing integer/boolean scalars exactly as YAML would.
 *
 * Returns `null` when no `key:` line was found — genuinely malformed output
 * (unclosed flow collections, ASCII garbage) then falls through to the
 * caller's `yaml-parse-error` rather than being masked.
 */
export function lenientParseBlock(lines: ReadonlyArray<string>): Record<string, unknown> | null {
  const out: Record<string, unknown> = {};
  let matched = false;
  let i = 0;
  while (i < lines.length) {
    const keyMatch = lines[i].match(KEY_LINE);
    if (!keyMatch) {
      i++;
      continue;
    }
    matched = true;
    const key = keyMatch[1];
    const inline = (keyMatch[2] ?? "").trim();
    const indicator = inline.match(BLOCK_SCALAR_INDICATOR);
    if (indicator) {
      const collected: string[] = [];
      let indent: number | null = null;
      i++;
      while (i < lines.length) {
        const line = lines[i];
        if (line.trim() === "") {
          collected.push("");
          i++;
          continue;
        }
        const lead = line.length - line.trimStart().length;
        if (lead === 0) break;
        if (indent === null) indent = lead;
        collected.push(line.slice(Math.min(indent, lead)));
        i++;
      }
      // Clip trailing blank lines but keep one trailing newline, matching
      // js-yaml's clip chomping. `>` folds (see foldLines); `|` is literal.
      const rendered = indicator[1] === ">" ? foldLines(collected) : collected.join("\n").replace(/\n+$/, "");
      out[key] = `${rendered}\n`;
    } else {
      out[key] = coerceScalar(stripSurroundingQuotes(inline));
      i++;
    }
  }
  return matched ? out : null;
}

/**
 * Fold a `>` block scalar the way strict YAML would: join consecutive
 * non-blank lines with a single space, and collapse each run of blank lines
 * into a single newline (a paragraph break). Faithful for the shapes agents
 * actually emit; the degraded recovery path never needs exotic chomping.
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

/** Strip a single pair of matching surrounding quotes, if present. */
function stripSurroundingQuotes(value: string): string {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1);
    }
  }
  return value;
}

/**
 * Coerce a bare scalar to the type strict YAML would have inferred, so the
 * lenient path feeds Zod the same shapes: integers → number, `true`/`false`
 * → boolean, everything else stays a string.
 */
function coerceScalar(value: string): unknown {
  if (value === "true") return true;
  if (value === "false") return false;
  if (/^-?\d+$/.test(value)) return Number(value);
  return value;
}
