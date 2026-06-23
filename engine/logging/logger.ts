import pino from "pino";
import { Writable } from "node:stream";
import type { OperationContext } from "@operator/core";
import { redactString } from "./redact.js";
import { createStatusLine, noopStatusLine } from "./status-line.js";
import type { StatusLine, TtyStream } from "./status-line.js";

/** pino-pretty's build factory, typed without statically loading the module. */
type PrettyFactory = (
  opts: import("pino-pretty").PrettyOptions,
) => import("pino-pretty").PrettyStream;

/**
 * Operator logger — thin wrapper around pino with OperationContext binding.
 *
 * Levels: debug, info, warn, error.
 * Debug only emitted when LOG_LEVEL=debug.
 * Repo context via OperationContext bindings.
 * Structured JSON output with secret redaction on messages.
 */
export interface Logger {
  debug(msg: string, data?: Record<string, unknown>): void;
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
  child(bindings: Record<string, unknown>): Logger;
}

/**
 * Wrap a pino instance to conform to our Logger interface,
 * applying string redaction to messages.
 */
function wrapPino(pinoLogger: pino.Logger): Logger {
  return {
    debug(msg: string, data?: Record<string, unknown>) {
      if (data) {
        pinoLogger.debug(data, redactString(msg));
      } else {
        pinoLogger.debug(redactString(msg));
      }
    },
    info(msg: string, data?: Record<string, unknown>) {
      if (data) {
        pinoLogger.info(data, redactString(msg));
      } else {
        pinoLogger.info(redactString(msg));
      }
    },
    warn(msg: string, data?: Record<string, unknown>) {
      if (data) {
        pinoLogger.warn(data, redactString(msg));
      } else {
        pinoLogger.warn(redactString(msg));
      }
    },
    error(msg: string, data?: Record<string, unknown>) {
      if (data) {
        pinoLogger.error(data, redactString(msg));
      } else {
        pinoLogger.error(redactString(msg));
      }
    },
    child(bindings: Record<string, unknown>): Logger {
      return wrapPino(pinoLogger.child(bindings));
    },
  };
}

/**
 * Create the root Operator logger.
 *
 * @param level — log level override (default: from `LOG_LEVEL` env var or "info")
 */
export function createLogger(level?: string): Logger {
  const resolvedLevel = level || process.env["LOG_LEVEL"] || "info";
  const usePretty = process.env["LOG_PRETTY"] === "true" || process.env["LOG_PRETTY"] === "1";

  const pinoLogger = usePretty
    ? pino({ level: resolvedLevel, transport: { target: "pino-pretty", options: { colorize: true } } })
    : pino({ level: resolvedLevel });

  return wrapPino(pinoLogger);
}

/** Root logger plus the status footer wired to share its output stream. */
export interface Console {
  readonly logger: Logger;
  readonly statusLine: StatusLine;
}

export interface ConsoleOptions {
  /** Log level override (default: `LOG_LEVEL` env var or "info"). */
  readonly level?: string;
  /** True only when stdout is an interactive terminal (`process.stdout.isTTY`). */
  readonly tty: boolean;
  /** True in single-cycle (`--once`) mode — no persistent footer. */
  readonly once: boolean;
  /** Opt-out of the footer even on a TTY (e.g. `NO_STATUS_LINE=1`). */
  readonly disableStatusLine?: boolean;
  /** Output stream — defaults to `process.stdout`. Injectable for tests. */
  readonly out?: TtyStream;
  /** pino-pretty loader — defaults to a dynamic import. Injectable for tests. */
  readonly loadPretty?: () => Promise<PrettyFactory>;
}

/**
 * Build the root logger and, when running interactively, a status footer
 * that shares stdout with the log stream.
 *
 * Interactive (TTY, long-lived, non-silent) → pino renders human-readable
 * lines through an in-process pino-pretty stream whose every chunk is routed
 * through the status line, so the footer is erased and redrawn around each
 * log line. Non-interactive (CI, systemd, Docker, piped stdout, `--once`,
 * silent) → the long-standing {@link createLogger} path, byte-for-byte
 * unchanged, paired with a {@link noopStatusLine} that emits nothing.
 */
export async function createConsole(opts: ConsoleOptions): Promise<Console> {
  const level = opts.level || process.env["LOG_LEVEL"] || "info";
  const interactive = opts.tty && !opts.once && !opts.disableStatusLine && level !== "silent";

  if (!interactive) {
    return { logger: createLogger(level), statusLine: noopStatusLine() };
  }

  const out = opts.out ?? process.stdout;
  const statusLine = createStatusLine({ out });
  // Every formatted log chunk flows through the status line, which erases the
  // footer, prints the chunk, then redraws the footer underneath it.
  const sink = new Writable({
    write(chunk: Buffer, _enc, cb): void {
      statusLine.writeLog(chunk.toString("utf8"));
      cb();
    },
  });

  const loadPretty = opts.loadPretty ?? (async () => (await import("pino-pretty")).default);
  try {
    const pretty = await loadPretty();
    const prettyStream = pretty({ colorize: true, sync: true, destination: sink });
    return { logger: wrapPino(pino({ level }, prettyStream)), statusLine };
  } catch (err) {
    // pino-pretty is a devDependency; a production install (`--omit=dev`)
    // legitimately lacks it. Keep the footer but fall back to raw NDJSON
    // routed through the same eraser rather than dropping the status line.
    const logger = wrapPino(pino({ level }, sink));
    logger.warn(
      `Status line: pretty formatter unavailable, logging JSON (${err instanceof Error ? err.message : String(err)})`,
    );
    return { logger, statusLine };
  }
}

/**
 * Create a child logger bound to an OperationContext.
 *
 * Adds traceId, repoId, and action to every log line — the V3 equivalent
 * of V1's `log_repo()` which prefixed messages with `[$repo_id]`.
 */
export function contextLogger(logger: Logger, ctx: OperationContext): Logger {
  return logger.child({
    traceId: ctx.traceId,
    repoId: ctx.repoId,
    action: ctx.action,
  });
}
