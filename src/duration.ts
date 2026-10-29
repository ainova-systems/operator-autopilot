import { OperatorError } from './errors.ts';

const UNITS: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };

/** Parses `250ms`, `30s`, `5m`, `2h`, `1d`, or a bare number of seconds, into milliseconds. */
export function parseDuration(value: unknown, field: string): number {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value * 1000;
  if (typeof value === 'string') {
    const match = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/.exec(value.trim());
    if (match?.[1] && match[2]) {
      const ms = Number(match[1]) * (UNITS[match[2]] ?? 0);
      if (ms > 0) return ms;
    }
  }
  throw new OperatorError('INVALID_DURATION', `${field}: expected a duration like 30s, 5m or 2h, got ${JSON.stringify(value)}`);
}
