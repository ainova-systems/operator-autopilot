import { OperatorError } from './errors.ts';

/** A five-field cron expression (minute hour day-of-month month day-of-week) evaluated in a time zone. */
export interface CronSchedule {
  readonly expression: string;
  readonly timezone: string;
  matches(at: Date): boolean;
}

const FIELDS = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'day-of-month', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12 },
  { name: 'day-of-week', min: 0, max: 7 },
] as const;

function parseField(text: string, index: number, expression: string): Set<number> {
  const field = FIELDS[index];
  if (!field) throw new OperatorError('INVALID_CRON', `cron ${JSON.stringify(expression)}: too many fields`);
  const values = new Set<number>();
  for (const part of text.split(',')) {
    const match = /^(\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/.exec(part);
    if (!match) throw new OperatorError('INVALID_CRON', `cron ${JSON.stringify(expression)}: cannot read ${field.name} ${JSON.stringify(part)}`);
    const from = match[1] === '*' ? field.min : Number(match[2]);
    const to = match[1] === '*' ? field.max : match[3] === undefined ? (match[4] === undefined ? from : field.max) : Number(match[3]);
    const step = match[4] === undefined ? 1 : Number(match[4]);
    if (from < field.min || to > field.max || from > to || step < 1) {
      throw new OperatorError('INVALID_CRON', `cron ${JSON.stringify(expression)}: ${field.name} ${JSON.stringify(part)} is outside ${field.min}-${field.max}`);
    }
    for (let value = from; value <= to; value += step) values.add(index === 4 && value === 7 ? 0 : value);
  }
  return values;
}

const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

export function parseCron(expression: string, timezone: string): CronSchedule {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) throw new OperatorError('INVALID_CRON', `cron ${JSON.stringify(expression)}: expected 5 fields, got ${parts.length}`);
  const [minutes, hours, days, months, weekdays] = parts.map((part, index) => parseField(part, index, expression)) as [Set<number>, Set<number>, Set<number>, Set<number>, Set<number>];
  const dayRestricted = parts[2] !== '*';
  const weekdayRestricted = parts[4] !== '*';
  let format: Intl.DateTimeFormat;
  try {
    format = new Intl.DateTimeFormat('en-US', { timeZone: timezone, hourCycle: 'h23', minute: 'numeric', hour: 'numeric', day: 'numeric', month: 'numeric', weekday: 'short' });
  } catch (error) {
    throw new OperatorError('INVALID_TIMEZONE', `unknown time zone ${JSON.stringify(timezone)}`, { cause: error });
  }
  return {
    expression,
    timezone,
    matches(at: Date): boolean {
      const local: Record<string, string> = {};
      for (const part of format.formatToParts(at)) local[part.type] = part.value;
      const dayMatch = days.has(Number(local['day']));
      const weekdayMatch = weekdays.has(WEEKDAYS[local['weekday'] ?? ''] ?? -1);
      // Standard cron: when both day fields are restricted, either one matching is enough.
      const dateMatch = dayRestricted && weekdayRestricted ? dayMatch || weekdayMatch : dayMatch && weekdayMatch;
      return minutes.has(Number(local['minute'])) && hours.has(Number(local['hour'])) && months.has(Number(local['month'])) && dateMatch;
    },
  };
}
