export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export type LogFields = Record<string, string | number | boolean | null | undefined>;

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  child(fields: LogFields): Logger;
}

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function formatValue(value: string | number | boolean | null): string {
  const text = String(value);
  return /[\s"=]/.test(text) ? JSON.stringify(text) : text;
}

/** One line per event: `<iso time> <LEVEL> <message> key=value ...`, written to stdout or stderr. */
export function createLogger(options: { level?: LogLevel; fields?: LogFields; write?: (line: string, level: LogLevel) => void } = {}): Logger {
  const threshold = ORDER[options.level ?? 'info'];
  const base = options.fields ?? {};
  const write = options.write ?? ((line, level) => {
    (level === 'error' || level === 'warn' ? process.stderr : process.stdout).write(`${line}\n`);
  });

  const emit = (level: LogLevel, message: string, fields: LogFields = {}): void => {
    if (ORDER[level] < threshold) return;
    const parts = [new Date().toISOString(), level.toUpperCase().padEnd(5), message];
    for (const [key, value] of Object.entries({ ...base, ...fields })) {
      if (value !== undefined) parts.push(`${key}=${formatValue(value)}`);
    }
    write(parts.join(' '), level);
  };

  return {
    debug: (message, fields) => emit('debug', message, fields),
    info: (message, fields) => emit('info', message, fields),
    warn: (message, fields) => emit('warn', message, fields),
    error: (message, fields) => emit('error', message, fields),
    child: (fields) => createLogger({ level: options.level ?? 'info', fields: { ...base, ...fields }, write }),
  };
}

export function errorText(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause = error.cause === undefined ? '' : ` (cause: ${errorText(error.cause)})`;
  return `${error.message}${cause}`;
}
