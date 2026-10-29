import { readFile } from 'node:fs/promises';
import { OperatorError } from './errors.ts';

/** What a run takes from a Codex agent definition (`.codex/agents/<name>.toml`). */
export interface CodexAgent {
  model?: string;
  reasoningEffort?: string;
  instructions?: string;
}

const ESCAPES: Record<string, string> = { b: '\b', t: '\t', n: '\n', f: '\f', r: '\r', '"': '"', '\\': '\\' };

/**
 * Reads the top-level keys of a Codex agent definition. Only the TOML such a definition uses is
 * understood - basic, literal and multi-line strings, with booleans and numbers skipped - and
 * anything else is refused with its line, so a definition is never half-read.
 */
export function parseCodexAgent(text: string, source: string): CodexAgent {
  const values = new Map<string, string>();
  let pos = 0;
  const lineAt = (at: number): number => text.slice(0, at).split('\n').length;
  const fail = (message: string, at = pos): never => {
    throw new OperatorError('CODEX_AGENT_INVALID', `${source}: ${message} on line ${lineAt(at)}`);
  };
  const skipSpaces = (): void => { while (text[pos] === ' ' || text[pos] === '\t') pos += 1; };
  const escape = (): string => {
    const code = text[pos + 1] ?? '';
    if (code in ESCAPES) { pos += 2; return ESCAPES[code] ?? ''; }
    const width = code === 'u' ? 4 : code === 'U' ? 8 : 0;
    const hex = text.slice(pos + 2, pos + 2 + width);
    if (width === 0 || !/^[0-9A-Fa-f]+$/.test(hex) || hex.length !== width) fail('unsupported escape');
    pos += 2 + width;
    return String.fromCodePoint(Number.parseInt(hex, 16));
  };
  const basic = (): string => {
    let out = '';
    pos += 1;
    for (;;) {
      const char = text[pos];
      if (char === undefined || char === '\n') fail('unterminated string');
      if (char === '"') { pos += 1; return out; }
      if (char === '\\') out += escape();
      else { out += char; pos += 1; }
    }
  };
  const multiline = (quote: '"' | "'"): string => {
    const fence = quote.repeat(3);
    let out = '';
    pos += 3;
    if (text[pos] === '\n') pos += 1;
    else if (text.startsWith('\r\n', pos)) pos += 2;
    for (;;) {
      if (pos >= text.length) fail('unterminated multi-line string');
      if (text.startsWith(fence, pos)) {
        let run = 3;
        while (text[pos + run] === quote && run < 5) run += 1;
        out += quote.repeat(run - 3);
        pos += run;
        return out;
      }
      const char = text[pos] ?? '';
      if (quote === '"' && char === '\\') {
        const rest = /^\\[ \t]*\r?\n/.exec(text.slice(pos));
        if (rest) {
          pos += rest[0].length;
          while (/[ \t\r\n]/.test(text[pos] ?? '')) pos += 1;
        } else out += escape();
        continue;
      }
      out += char;
      pos += 1;
    }
  };

  while (pos < text.length) {
    const char = text[pos];
    if (char === ' ' || char === '\t' || char === '\r' || char === '\n') { pos += 1; continue; }
    if (char === '#') { while (pos < text.length && text[pos] !== '\n') pos += 1; continue; }
    // Top-level keys come before the first table; nothing in a table is the agent's own setting.
    if (char === '[') break;
    const key = /^[A-Za-z0-9_-]+/.exec(text.slice(pos))?.[0];
    if (!key) fail('expected a key');
    const keyAt = pos;
    pos += key?.length ?? 0;
    skipSpaces();
    if (text[pos] !== '=') fail(`expected = after ${key}`);
    pos += 1;
    skipSpaces();
    let value: string | undefined;
    if (text.startsWith('"""', pos)) value = multiline('"');
    else if (text.startsWith("'''", pos)) value = multiline("'");
    else if (text[pos] === '"') value = basic();
    else if (text[pos] === "'") {
      const end = text.indexOf("'", pos + 1);
      if (end === -1 || text.slice(pos + 1, end).includes('\n')) fail('unterminated string');
      value = text.slice(pos + 1, end);
      pos = end + 1;
    } else {
      const scalar = /^(true|false|[+-]?[0-9][0-9_]*(\.[0-9_]+)?)/.exec(text.slice(pos))?.[0];
      if (!scalar) fail(`unsupported value for ${key}`);
      pos += scalar?.length ?? 0;
    }
    skipSpaces();
    if (text[pos] === '#') while (pos < text.length && text[pos] !== '\n') pos += 1;
    if (pos < text.length && text[pos] !== '\n' && text[pos] !== '\r') fail(`unexpected text after ${key}`);
    if (key && value !== undefined) {
      if (values.has(key)) fail(`${key} is defined twice`, keyAt);
      values.set(key, value);
    }
  }

  const model = values.get('model');
  const reasoningEffort = values.get('model_reasoning_effort');
  const instructions = values.get('developer_instructions')?.trim();
  return {
    ...(model ? { model } : {}),
    ...(reasoningEffort ? { reasoningEffort } : {}),
    ...(instructions ? { instructions } : {}),
  };
}

export async function readCodexAgent(path: string): Promise<CodexAgent> {
  return parseCodexAgent(await readFile(path, 'utf8'), path);
}
