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

/** How long an engine stays out when its message names no reset this module can read. */
export const USAGE_LIMIT_RECHECK_MS = 30 * 60_000;

/** What each engine prints when it is out of usage. An engine with no entry is never judged out. */
const LIMIT_PATTERNS: Record<string, RegExp[]> = {
  claude: [/you'?ve hit your\b[^\n]{0,40}?\blimit\b/i, /\busage limit reached\b/i],
  codex: [/you'?ve hit your usage limit\b/i],
};

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/**
 * The usage limit `text` reports for `engine`, or undefined when it reports none. `text` is what the
 * run printed or what its terminal shows; only the engine's own wording counts, so a permission
 * prompt or ordinary output never reads as a limit.
 */
export function detectUsageLimit(engine: string, text: string, now: Date = new Date()): UsageLimit | undefined {
  const patterns = LIMIT_PATTERNS[engine];
  if (!patterns || !patterns.some((pattern) => pattern.test(text))) return undefined;
  const resetsAt = parseReset(text, now);
  return { engine, ...(resetsAt ? { resetsAt } : {}) };
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

function last<T>(matches: IterableIterator<T>): T | undefined {
  let found: T | undefined;
  for (const match of matches) found = match;
  return found;
}
