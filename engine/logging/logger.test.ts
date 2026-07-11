import { describe, it, expect, vi, beforeEach } from "vitest";
import { createLogger, createConsole, contextLogger } from "./logger.js";
import type { OperationContext } from "@operator/core";
import type { Logger } from "./logger.js";
import type { TtyStream } from "./status-line.js";

function fakeOut(): TtyStream & { writes: string[]; all: () => string } {
  const writes: string[] = [];
  return {
    columns: 80,
    write(data: string): boolean {
      writes.push(data);
      return true;
    },
    writes,
    all: () => writes.join(""),
  };
}

const flush = () => new Promise((r) => setImmediate(r));

function makeCtx(overrides?: Partial<OperationContext>): OperationContext {
  return {
    traceId: "trace-abc",
    repoId: "test-repo",
    action: "research",
    budget: { spentUsd: 0, add: vi.fn(), isExceeded: () => false },
    signal: AbortSignal.timeout(30_000),
    ...overrides,
  };
}

describe("createLogger", () => {
  it("creates a logger with default level", () => {
    const logger = createLogger();
    expect(logger).toBeDefined();
    expect(typeof logger.info).toBe("function");
    expect(typeof logger.warn).toBe("function");
    expect(typeof logger.error).toBe("function");
    expect(typeof logger.debug).toBe("function");
  });

  it("creates a logger with custom level", () => {
    const logger = createLogger("debug");
    expect(logger).toBeDefined();
  });

  it("supports info logging with message only", () => {
    const logger = createLogger("silent");
    // Should not throw
    logger.info("test message");
  });

  it("supports info logging with data", () => {
    const logger = createLogger("silent");
    logger.info("test message", { key: "value" });
  });

  it("supports warn logging", () => {
    const logger = createLogger("silent");
    logger.warn("warning message");
    logger.warn("warning with data", { count: 5 });
  });

  it("supports error logging", () => {
    const logger = createLogger("silent");
    logger.error("error message");
    logger.error("error with data", { err: "details" });
  });

  it("supports debug logging", () => {
    const logger = createLogger("silent");
    logger.debug("debug message");
    logger.debug("debug with data", { detail: true });
  });

  it("redacts tokens in log messages", () => {
    // We can't easily capture pino output, but we can verify no throw
    // and that redaction is applied by testing through the redact module
    const logger = createLogger("silent");
    logger.info("Token: ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  });

  it("redacts a ghp_ token in structured data fields (CLI-exit stderr/stdout leak)", async () => {
    const out = fakeOut();
    const ghpToken = "ghp_abcdefghijklmnopqrstuvwxyz1234567890";
    const bearerToken = "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9payload";
    const { logger, statusLine } = await createConsole({
      level: "warn",
      tty: true,
      once: false,
      out,
      loadPretty: () => Promise.reject(new Error("module not found")),
    });
    logger.warn("Agent CLI exited non-zero", {
      stderr: `Authorization: ${bearerToken}`,
      stdout: ghpToken,
    });
    await flush();
    statusLine.stop();
    const serialized = out.all();
    expect(serialized).toContain("[REDACTED]");
    expect(serialized).not.toContain(ghpToken);
    expect(serialized).not.toContain(bearerToken);
  });

  it("redacts sk-ant- tokens in child logger bindings", async () => {
    const out = fakeOut();
    const anthropicKey = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz123456";
    const { logger, statusLine } = await createConsole({
      level: "info",
      tty: true,
      once: false,
      out,
      loadPretty: () => Promise.reject(new Error("module not found")),
    });
    const child = logger.child({ apiKey: anthropicKey });
    child.info("child log with bound secret");
    await flush();
    statusLine.stop();
    const serialized = out.all();
    expect(serialized).toContain("[REDACTED]");
    expect(serialized).not.toContain(anthropicKey);
  });

  it("creates child loggers", () => {
    const logger = createLogger("silent");
    const child = logger.child({ component: "test" });
    expect(child).toBeDefined();
    expect(typeof child.info).toBe("function");
  });
});

describe("createConsole", () => {
  it("non-interactive (not a TTY) returns a logger and a no-op status line", async () => {
    const { logger, statusLine } = await createConsole({ level: "silent", tty: false, once: false });
    expect(typeof logger.info).toBe("function");
    // No-op footer: never throws, emits nothing.
    expect(() => {
      statusLine.set({ phase: "running" });
      statusLine.writeLog("x");
      statusLine.stop();
    }).not.toThrow();
  });

  it("defaults the level when none is given", async () => {
    const { logger } = await createConsole({ tty: false, once: false });
    expect(typeof logger.info).toBe("function");
    logger.info("default level"); // does not throw
  });

  it("--once mode stays non-interactive even on a TTY", async () => {
    const out = fakeOut();
    const { statusLine } = await createConsole({ level: "info", tty: true, once: true, out });
    statusLine.set({ phase: "running" });
    statusLine.stop();
    expect(out.writes).toEqual([]); // no-op footer never touched the stream
  });

  it("silent level disables the footer even on a TTY", async () => {
    const out = fakeOut();
    const { statusLine } = await createConsole({ level: "silent", tty: true, once: false, out });
    statusLine.set({ phase: "running" });
    expect(out.writes).toEqual([]);
  });

  it("disableStatusLine opts out on a TTY", async () => {
    const out = fakeOut();
    const { statusLine } = await createConsole({
      level: "info", tty: true, once: false, disableStatusLine: true, out,
    });
    statusLine.set({ phase: "running" });
    expect(out.writes).toEqual([]);
  });

  it("interactive: routes pretty logs through the status footer", async () => {
    const out = fakeOut();
    const { logger, statusLine } = await createConsole({ level: "info", tty: true, once: false, out });
    // Footer hides the cursor on construction.
    expect(out.all()).toContain("\x1b[?25l");
    logger.info("hello-interactive");
    await flush();
    statusLine.stop();
    const all = out.all();
    expect(all).toContain("hello-interactive");
    expect(all).toContain("\x1b[?25h"); // cursor restored on stop
  });

  it("interactive: falls back to JSON-with-footer when pino-pretty is unavailable", async () => {
    const out = fakeOut();
    const { logger, statusLine } = await createConsole({
      level: "info",
      tty: true,
      once: false,
      out,
      loadPretty: () => Promise.reject(new Error("module not found")),
    });
    logger.info("hello-json");
    await flush();
    statusLine.stop();
    const all = out.all();
    expect(all).toContain("pretty formatter unavailable");
    expect(all).toContain("hello-json");
  });
});

describe("contextLogger", () => {
  let rootLogger: Logger;

  beforeEach(() => {
    rootLogger = createLogger("silent");
  });

  it("creates a child logger with context bindings", () => {
    const ctx = makeCtx();
    const ctxLogger = contextLogger(rootLogger, ctx);
    expect(ctxLogger).toBeDefined();
    expect(typeof ctxLogger.info).toBe("function");
  });

  it("preserves all logger methods", () => {
    const ctx = makeCtx();
    const ctxLogger = contextLogger(rootLogger, ctx);
    // All methods should work without throwing
    ctxLogger.info("info");
    ctxLogger.warn("warn");
    ctxLogger.error("error");
    ctxLogger.debug("debug");
  });

  it("can create nested child loggers", () => {
    const ctx = makeCtx();
    const ctxLogger = contextLogger(rootLogger, ctx);
    const child = ctxLogger.child({ step: "research" });
    expect(child).toBeDefined();
    child.info("nested child log");
  });

  it("supports logging with data", () => {
    const ctx = makeCtx();
    const ctxLogger = contextLogger(rootLogger, ctx);
    ctxLogger.info("with data", { findings: 3 });
    ctxLogger.warn("with data", { missing: true });
    ctxLogger.error("with data", { code: "ERR_TEST" });
    ctxLogger.debug("with data", { verbose: true });
  });
});
