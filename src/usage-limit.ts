/**
 * An engine that ran out of usage, and when it said the limit resets. A run that meets the limit
 * does no work and would only wait out its timeout, so the runtime starts no job on that engine
 * until then.
 */
export interface UsageLimit {
  engine: string;
  /** When the engine said the limit resets; absent when it did not say in a form read here. */
  resetsAt?: Date;
}

/** How long an engine stays out when its message names no reset this module can read, or a past one. */
export const USAGE_LIMIT_RECHECK_MS = 30 * 60_000;

/** How many of a text's last non-empty lines can hold the engine's message: it is the newest thing shown. */
export const PANE_TAIL = 8;
/** A run's output ends with the engine's message and the wrapper's closing lines. */
export const OUTPUT_TAIL = 5;

/**
 * Each engine's own limit message: a line that starts with `line` (after the glyphs a terminal UI
 * puts in front) and, somewhere in the same tail, one of `companion` - its reset, its retry hint or
 * its limit menu. Both together are the engine speaking, not a diff, a test or a log quoting it. An
 * engine with no entry is never judged out.
 */
const LIMIT_MESSAGES: Record<string, { line: RegExp; companion: RegExp }> = {
  claude: {
    line: /^(?:you'?ve hit your\b[^\n]{0,40}?\blimit\b|(?:claude ai )?usage limit reached\b)/i,
    companion: /\bresets\s+\S|continuing automatically at|limit reached\|\d{10}\b|stop and wait for limit to reset/i,
  },
  codex: {
    line: /^you'?ve hit your usage limit\b/i,
    companion: /\btry again (?:in|at)\b/i,
  },
};

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/**
 * The usage limit `text` reports for `engine`, or undefined when it reports none. `text` is what the
 * run printed or what its terminal shows; only the engine's own message in its last `tail` lines counts.
 */
export function detectUsageLimit(engine: string, text: string, now: Date = new Date(), tail = PANE_TAIL): UsageLimit | undefined {
  const message = LIMIT_MESSAGES[engine];
  if (!message) return undefined;
  const lines = tailLines(text, tail);
  if (!lines.some((line) => message.line.test(line))) return undefined;
  const shown = lines.join('\n');
  if (!message.companion.test(shown)) return undefined;
  const resetsAt = parseReset(shown, now);
  return { engine, ...(resetsAt ? { resetsAt } : {}) };
}

/**
 * The last non-empty lines, each without the glyphs and indentation a terminal UI puts in front. A
 * JSON line (a streamed result) contributes its `result`, `error` and `message` strings instead, where
 * a headless engine puts its message.
 */
function tailLines(text: string, count: number): string[] {
  const lines: string[] = [];
  for (const raw of text.split(/\r?\n/).filter((line) => line.trim() !== '').slice(-count)) {
    const trimmed = raw.trim();
    if (trimmed.startsWith('{')) {
      try {
        const parsed = JSON.parse(trimmed) as Record<string, unknown>;
        for (const key of ['result', 'error', 'message']) {
          const value = parsed[key];
          if (typeof value === 'string') lines.push(...value.split(/\r?\n/).map(strip));
        }
        continue;
      } catch {
        // Not JSON after all: read it as text.
      }
    }
    lines.push(strip(raw));
  }
  return lines;
}

function strip(line: string): string {
  return line.replace(/^[\s●⎿■✻·•*>│|─-]+/u, '').trim();
}

/**
 * The reset time a limit message names: an epoch after `|` (`... limit reached|1762344000`), a UTC
 * wall time (`resets Nov 5, 12pm (UTC)`, `resets 12pm (UTC)`), or a duration (`try again in 4 days
 * 18 hours 33 minutes`). The last occurrence wins, since a terminal shows the newest message last. A
 * time in another zone is not guessed at: the caller re-checks after a fixed delay instead.
 */
export function parseReset(text: string, now: Date = new Date()): Date | undefined {
  const epoch = last(text.matchAll(/limit reached\|(\d{10})\b/gi));
  if (epoch) return new Date(Number(epoch[1]) * 1000);

  const wall = last(text.matchAll(/resets\s+(?:([a-z]{3})[a-z]*\s+(\d{1,2}),?\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s*\(([^)]+)\)/gi));
  if (wall && /^(utc|gmt|etc\/utc)$/i.test(wall[6] ?? '')) {
    let hour = Number(wall[3]) % 12;
    if (wall[5]?.toLowerCase() === 'pm') hour += 12;
    const minute = Number(wall[4] ?? 0);
    if (wall[1] && wall[2]) {
      const month = MONTHS.indexOf(wall[1].toLowerCase());
      if (month < 0) return undefined;
      let at = Date.UTC(now.getUTCFullYear(), month, Number(wall[2]), hour, minute);
      // A reset named for a date months behind is next year's: a limit lasts days, not seasons.
      if (at < now.getTime() - 180 * 86_400_000) at = Date.UTC(now.getUTCFullYear() + 1, month, Number(wall[2]), hour, minute);
      return new Date(at);
    }
    let at = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hour, minute);
    if (at <= now.getTime()) at += 86_400_000;
    return new Date(at);
  }

  const relative = last(text.matchAll(/try again in((?:\s+\d+\s+(?:days?|hours?|minutes?|seconds?),?)+)/gi));
  if (relative) {
    const units: Record<string, number> = { day: 86_400_000, hour: 3_600_000, minute: 60_000, second: 1000 };
    let ms = 0;
    for (const part of (relative[1] ?? '').matchAll(/(\d+)\s+(day|hour|minute|second)s?/gi)) ms += Number(part[1]) * (units[(part[2] ?? '').toLowerCase()] ?? 0);
    if (ms > 0) return new Date(now.getTime() + ms);
  }
  return undefined;
}

/** When the engine is back: the reset its message names, or a re-check when it names none or one already past. */
export function availableAgainAt(limit: UsageLimit, now: number): number {
  const reset = limit.resetsAt?.getTime();
  return reset !== undefined && reset > now ? reset : now + USAGE_LIMIT_RECHECK_MS;
}

function last<T>(matches: IterableIterator<T>): T | undefined {
  let found: T | undefined;
  for (const match of matches) found = match;
  return found;
}
