import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLIAgentProvider, buildChildEnv } from "./cli.js";
import type { CLIProviderConfig } from "./cli.js";
import type { Logger } from "../../logging/logger.js";

vi.mock("node:child_process", () => ({
  spawn: vi.fn(),
}));

const mockSpawn = vi.mocked(spawn);

const CLAUDE_CONFIG: CLIProviderConfig = {
  command: "claude",
  defaultArgs: ["--dangerously-skip-permissions"],
  promptArg: "-p",
  modelArg: "--model",
  toolsArg: "--tools",
  maxBudgetArg: "--max-budget-usd",
  systemPromptFileArg: "--append-system-prompt-file",
};

const MINIMAL_CONFIG: CLIProviderConfig = {
  command: "simple-agent",
  defaultArgs: [],
  promptArg: "--prompt",
};

// Mirrors the shipped cursor-agent provider — note the deliberate absence of
// `systemPromptFileArg`: cursor-agent has no system-prompt flag, so the
// runtime-built system prompt must be folded into the prompt body instead.
const CURSOR_CONFIG: CLIProviderConfig = {
  command: "cursor-agent",
  defaultArgs: ["--force", "--output-format", "text"],
  promptArg: "-p",
  modelArg: "--model",
};

const DEFAULT_OPTIONS = {
  model: "opus",
  timeoutMs: 60_000,
  cwd: "/workspace",
};

interface FakeChild extends EventEmitter {
  pid: number;
  stdout: EventEmitter;
  stderr: EventEmitter;
  stdin: EventEmitter & { end: ReturnType<typeof vi.fn> };
  kill: ReturnType<typeof vi.fn>;
}

/** Create a fake ChildProcess that emits close after stdout data. */
function fakeChild(stdout: string, code: number, stderr = ""): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.pid = 12345;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = Object.assign(new EventEmitter(), { end: vi.fn() });
  child.kill = vi.fn();

  process.nextTick(() => {
    if (stdout) child.stdout.emit("data", Buffer.from(stdout));
    if (stderr) child.stderr.emit("data", Buffer.from(stderr));
    child.emit("close", code);
  });

  return child;
}

/** Create a fake child that never closes until killed (for timeout tests). */
function hangingChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.pid = 99999;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = Object.assign(new EventEmitter(), { end: vi.fn() });
  child.kill = vi.fn(() => {
    // Emit close synchronously — in real life SIGKILL causes immediate exit
    child.emit("close", null);
  });
  return child;
}

function _stubLogger(): Logger {
  const noop = () => {};
  const logger: Logger = { debug: noop, info: noop, warn: noop, error: noop, child: () => logger };
  return logger;
}

function captureLogger(): { logger: Logger; calls: Array<{ level: string; msg: string; data?: Record<string, unknown> }> } {
  const calls: Array<{ level: string; msg: string; data?: Record<string, unknown> }> = [];
  const logger: Logger = {
    debug: (msg: string, data?: Record<string, unknown>) => calls.push({ level: "debug", msg, data }),
    info: (msg: string, data?: Record<string, unknown>) => calls.push({ level: "info", msg, data }),
    warn: (msg: string, data?: Record<string, unknown>) => calls.push({ level: "warn", msg, data }),
    error: (msg: string, data?: Record<string, unknown>) => calls.push({ level: "error", msg, data }),
    child: () => logger,
  };
  return { logger, calls };
}

describe("CLIAgentProvider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("has correct id", () => {
    const provider = new CLIAgentProvider("claude", CLAUDE_CONFIG);
    expect(provider.id).toBe("claude");
  });

  // ── Flag mapping ──────────────────────────────────────────────────

  describe("flag mapping", () => {
    it("builds full agentic mode args", async () => {
      mockSpawn.mockReturnValue(fakeChild("agent output", 0) as never);
      const provider = new CLIAgentProvider("claude", CLAUDE_CONFIG);

      await provider.execute("Fix the bug", {
        ...DEFAULT_OPTIONS,
        tools: ["Read", "Edit", "Bash"],
        maxBudgetUsd: 5.0,
        systemPromptFile: "/tmp/system.md",
      });

      const callArgs = mockSpawn.mock.calls[0];
      expect(callArgs[0]).toBe("claude");
      const args = callArgs[1] as string[];
      expect(args).toContain("--dangerously-skip-permissions");
      expect(args).toContain("--model");
      expect(args[args.indexOf("--model") + 1]).toBe("opus");
      expect(args).toContain("--append-system-prompt-file");
      expect(args[args.indexOf("--append-system-prompt-file") + 1]).toBe("/tmp/system.md");
      expect(args).toContain("--tools");
      expect(args[args.indexOf("--tools") + 1]).toBe("Read,Edit,Bash");
      expect(args).toContain("--max-budget-usd");
      expect(args[args.indexOf("--max-budget-usd") + 1]).toBe("5");
      expect(args).toContain("-p");
      expect(args[args.indexOf("-p") + 1]).toBe("Fix the bug");
    });

    it("omits optional flags when not configured", async () => {
      mockSpawn.mockReturnValue(fakeChild("output", 0) as never);
      const provider = new CLIAgentProvider("simple", MINIMAL_CONFIG);

      await provider.execute("Do task", DEFAULT_OPTIONS);

      const args = mockSpawn.mock.calls[0][1] as string[];
      expect(args).not.toContain("--model");
      expect(args).not.toContain("--tools");
      expect(args).not.toContain("--max-budget-usd");
      expect(args).toContain("--prompt");
      expect(args[args.indexOf("--prompt") + 1]).toBe("Do task");
    });

    it("omits tools flag when tools array is empty", async () => {
      mockSpawn.mockReturnValue(fakeChild("output", 0) as never);
      const provider = new CLIAgentProvider("claude", CLAUDE_CONFIG);

      await provider.execute("Task", { ...DEFAULT_OPTIONS, tools: [] });

      const args = mockSpawn.mock.calls[0][1] as string[];
      expect(args).not.toContain("--tools");
    });

    it("omits systemPromptFile flag when not provided", async () => {
      mockSpawn.mockReturnValue(fakeChild("output", 0) as never);
      const provider = new CLIAgentProvider("claude", CLAUDE_CONFIG);

      await provider.execute("Task", DEFAULT_OPTIONS);

      const args = mockSpawn.mock.calls[0][1] as string[];
      expect(args).not.toContain("--append-system-prompt-file");
    });
  });

  // ── Execution ─────────────────────────────────────────────────────

  describe("execution", () => {
    it("returns stdout and exit code 0 on success", async () => {
      mockSpawn.mockReturnValue(fakeChild("Hello from agent", 0) as never);
      const provider = new CLIAgentProvider("claude", CLAUDE_CONFIG);

      const result = await provider.execute("Task", DEFAULT_OPTIONS);

      expect(result.stdout).toBe("Hello from agent");
      expect(result.exitCode).toBe(0);
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });

    it("returns stdout with non-zero exit code on error", async () => {
      mockSpawn.mockReturnValue(fakeChild("partial output", 1, "error output") as never);
      const provider = new CLIAgentProvider("claude", CLAUDE_CONFIG);

      const result = await provider.execute("Task", DEFAULT_OPTIONS);

      expect(result.stdout).toBe("partial output");
      expect(result.exitCode).toBe(1);
    });

    it("rejects on timeout and kills process tree", async () => {
      const child = hangingChild();
      mockSpawn.mockReturnValue(child as never);
      const provider = new CLIAgentProvider("claude", CLAUDE_CONFIG);

      await expect(
        provider.execute("Task", { ...DEFAULT_OPTIONS, timeoutMs: 10 }),
      ).rejects.toThrow("CLI timeout");
    });

    it("passes cwd and env to spawn", async () => {
      mockSpawn.mockReturnValue(fakeChild("ok", 0) as never);
      const provider = new CLIAgentProvider("claude", CLAUDE_CONFIG);

      await provider.execute("Task", {
        ...DEFAULT_OPTIONS,
        env: { GH_TOKEN: "ghp_test" },
      });

      const opts = mockSpawn.mock.calls[0][2] as Record<string, unknown>;
      expect(opts.cwd).toBe("/workspace");
      expect((opts.env as Record<string, string>).GH_TOKEN).toBe("ghp_test");
    });

    it("uses detached process group on non-win32", async () => {
      mockSpawn.mockReturnValue(fakeChild("ok", 0) as never);
      const provider = new CLIAgentProvider("claude", CLAUDE_CONFIG);

      await provider.execute("Task", DEFAULT_OPTIONS);

      const opts = mockSpawn.mock.calls[0][2] as Record<string, unknown>;
      // Detached is true on linux, false on win32
      expect(typeof opts.detached).toBe("boolean");
    });

    it("logs CLI spawn details through structured logger", async () => {
      mockSpawn.mockReturnValue(fakeChild("ok", 0) as never);
      const { logger, calls } = captureLogger();
      const provider = new CLIAgentProvider("claude", CLAUDE_CONFIG, logger);

      await provider.execute("Task", DEFAULT_OPTIONS);

      const spawnLog = calls.find((c) => c.msg === "CLI spawn");
      expect(spawnLog).toBeDefined();
      expect(spawnLog!.data?.provider).toBe("claude");
      expect(spawnLog!.data?.model).toBe("opus");
    });

    it("logs CLI exit details on error through structured logger", async () => {
      mockSpawn.mockReturnValue(fakeChild("partial", 1, "error output") as never);
      const { logger, calls } = captureLogger();
      const provider = new CLIAgentProvider("claude", CLAUDE_CONFIG, logger);

      await provider.execute("Task", DEFAULT_OPTIONS);

      const exitLog = calls.find((c) => c.msg === "CLI exit");
      expect(exitLog).toBeDefined();
      expect(exitLog!.data?.exitCode).toBe(1);
    });

    it("logs timeout error through structured logger", async () => {
      const child = hangingChild();
      mockSpawn.mockReturnValue(child as never);
      const { logger, calls } = captureLogger();
      const provider = new CLIAgentProvider("claude", CLAUDE_CONFIG, logger);

      await expect(
        provider.execute("Task", { ...DEFAULT_OPTIONS, timeoutMs: 10 }),
      ).rejects.toThrow("CLI timeout");

      expect(calls.some((c) => c.level === "error" && c.msg.includes("timeout"))).toBe(true);
    });

    it("handles null exit code as 1", async () => {
      const child = new EventEmitter() as EventEmitter & { pid: number; stdout: EventEmitter; stderr: EventEmitter; kill: ReturnType<typeof vi.fn> };
      child.pid = 12345;
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = vi.fn();
      process.nextTick(() => child.emit("close", null));
      mockSpawn.mockReturnValue(child as never);

      const provider = new CLIAgentProvider("claude", CLAUDE_CONFIG);
      const result = await provider.execute("Task", DEFAULT_OPTIONS);
      expect(result.exitCode).toBe(1);
    });

    it("rejects on spawn error", async () => {
      const child = new EventEmitter() as EventEmitter & { pid: number; stdout: EventEmitter; stderr: EventEmitter; kill: ReturnType<typeof vi.fn> };
      child.pid = 12345;
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = vi.fn();
      process.nextTick(() => child.emit("error", new Error("ENOENT")));
      mockSpawn.mockReturnValue(child as never);

      const provider = new CLIAgentProvider("claude", CLAUDE_CONFIG);
      await expect(provider.execute("Task", DEFAULT_OPTIONS)).rejects.toThrow("ENOENT");
    });

    it("logs stdout sample and elevates to warn on non-zero exit", async () => {
      mockSpawn.mockReturnValue(fakeChild("invalid api key: auth failed", 1) as never);
      const { logger, calls } = captureLogger();
      const provider = new CLIAgentProvider("claude", CLAUDE_CONFIG, logger);

      await provider.execute("Task", DEFAULT_OPTIONS);

      const exitLog = calls.find((c) => c.msg === "CLI exit");
      expect(exitLog).toBeDefined();
      expect(exitLog!.level).toBe("warn");
      expect(exitLog!.data?.exitCode).toBe(1);
      expect(exitLog!.data?.stdout).toBe("invalid api key: auth failed");
    });

    it("filters empty env vars so they cannot shadow CLI credential fallbacks", async () => {
      mockSpawn.mockReturnValue(fakeChild("ok", 0) as never);
      const provider = new CLIAgentProvider("claude", CLAUDE_CONFIG);

      const originalKey = process.env.ANTHROPIC_API_KEY;
      const originalOauth = process.env.CLAUDE_CODE_OAUTH_TOKEN;
      process.env.ANTHROPIC_API_KEY = "";
      process.env.CLAUDE_CODE_OAUTH_TOKEN = "oauth-value";
      try {
        await provider.execute("Task", DEFAULT_OPTIONS);
      } finally {
        if (originalKey === undefined) delete process.env.ANTHROPIC_API_KEY;
        else process.env.ANTHROPIC_API_KEY = originalKey;
        if (originalOauth === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
        else process.env.CLAUDE_CODE_OAUTH_TOKEN = originalOauth;
      }

      const opts = mockSpawn.mock.calls[0][2] as { env: Record<string, string> };
      expect(opts.env.ANTHROPIC_API_KEY).toBeUndefined();
      expect(opts.env.CLAUDE_CODE_OAUTH_TOKEN).toBe("oauth-value");
    });
  });

  // ── system prompt folding (providers without a system-prompt flag) ─

  describe("system prompt folding", () => {
    let dir: string;
    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), "cli-fold-"));
      // Point cursor-agent's launcher resolution at a non-existent install so
      // these folding tests assert the same argv on any host (no win32 launcher
      // rewrite). Launcher resolution itself is covered in win-launcher.test.ts.
      vi.stubEnv("CURSOR_AGENT_HOME", join(dir, "no-cursor-install"));
    });
    afterEach(async () => {
      vi.unstubAllEnvs();
      await rm(dir, { recursive: true, force: true });
    });

    it("folds the system prompt into the prompt body when provider has no systemPromptFileArg", async () => {
      const sysFile = join(dir, "system.md");
      await writeFile(sysFile, "ROLE: creator\nContext: base", "utf-8");
      // Construct the fake child at spawn time (after execute's async file
      // read) so its close event fires AFTER the close listener attaches.
      mockSpawn.mockImplementation(() => fakeChild("ok", 0) as never);
      const provider = new CLIAgentProvider("cursor", CURSOR_CONFIG);

      await provider.execute("Fix the bug", { ...DEFAULT_OPTIONS, systemPromptFile: sysFile });

      const args = mockSpawn.mock.calls[0][1] as string[];
      const promptValue = args[args.indexOf("-p") + 1];
      expect(promptValue).toContain("ROLE: creator");
      expect(promptValue).toContain("Fix the bug");
      // System prompt precedes the user prompt in the folded body.
      expect(promptValue.indexOf("ROLE: creator")).toBeLessThan(promptValue.indexOf("Fix the bug"));
      // cursor-agent exposes no system-prompt flag, so none is emitted.
      expect(args).not.toContain("--append-system-prompt-file");
    });

    it("does not fold when the provider exposes systemPromptFileArg (claude passes by reference)", async () => {
      const sysFile = join(dir, "system.md");
      await writeFile(sysFile, "ROLE: creator", "utf-8");
      mockSpawn.mockReturnValue(fakeChild("ok", 0) as never);
      const provider = new CLIAgentProvider("claude", CLAUDE_CONFIG);

      await provider.execute("Fix the bug", { ...DEFAULT_OPTIONS, systemPromptFile: sysFile });

      const args = mockSpawn.mock.calls[0][1] as string[];
      expect(args[args.indexOf("-p") + 1]).toBe("Fix the bug");
      expect(args).toContain("--append-system-prompt-file");
      expect(args[args.indexOf("--append-system-prompt-file") + 1]).toBe(sysFile);
    });

    it("folds the system prompt into the stdin body in promptFromStdin mode", async () => {
      const sysFile = join(dir, "system.md");
      await writeFile(sysFile, "SYSTEM CTX", "utf-8");
      let captured: FakeChild | undefined;
      mockSpawn.mockImplementation(() => {
        captured = fakeChild("ok", 0);
        return captured as never;
      });
      const provider = new CLIAgentProvider("cursor-stdin", { ...CURSOR_CONFIG, promptFromStdin: true });

      await provider.execute("Do work", { ...DEFAULT_OPTIONS, systemPromptFile: sysFile });

      const folded = captured!.stdin.end.mock.calls[0][0] as string;
      expect(folded).toContain("SYSTEM CTX");
      expect(folded).toContain("Do work");
      // Bare flag in argv, full body via stdin.
      const args = mockSpawn.mock.calls[0][1] as string[];
      expect(args).not.toContain("Do work");
    });

    it("degrades to the original prompt and warns when the system prompt file is unreadable", async () => {
      mockSpawn.mockImplementation(() => fakeChild("ok", 0) as never);
      const { logger, calls } = captureLogger();
      const provider = new CLIAgentProvider("cursor", CURSOR_CONFIG, logger);

      await provider.execute("Bare prompt", {
        ...DEFAULT_OPTIONS,
        systemPromptFile: join(dir, "missing.md"),
      });

      const args = mockSpawn.mock.calls[0][1] as string[];
      expect(args[args.indexOf("-p") + 1]).toBe("Bare prompt");
      expect(calls.some((c) => c.level === "warn" && c.msg.includes("fold system prompt"))).toBe(true);
    });

    it("ignores an empty system prompt file and keeps the original prompt", async () => {
      const sysFile = join(dir, "empty.md");
      await writeFile(sysFile, "   \n  ", "utf-8");
      mockSpawn.mockImplementation(() => fakeChild("ok", 0) as never);
      const provider = new CLIAgentProvider("cursor", CURSOR_CONFIG);

      await provider.execute("Only user", { ...DEFAULT_OPTIONS, systemPromptFile: sysFile });

      const args = mockSpawn.mock.calls[0][1] as string[];
      expect(args[args.indexOf("-p") + 1]).toBe("Only user");
    });
  });

  // ── stdin mode (argv limit bypass) ────────────────────────────────

  describe("promptFromStdin", () => {
    it("emits promptArg as a bare flag and feeds prompt via stdin", async () => {
      const child = fakeChild("ok", 0);
      mockSpawn.mockReturnValue(child as never);
      const provider = new CLIAgentProvider("claude-stdin", {
        ...CLAUDE_CONFIG,
        promptFromStdin: true,
      });

      const hugePrompt = "x".repeat(200_000);
      await provider.execute(hugePrompt, DEFAULT_OPTIONS);

      const args = mockSpawn.mock.calls[0][1] as string[];
      expect(args).toContain("-p");
      expect(args).not.toContain(hugePrompt);
      expect(child.stdin.end).toHaveBeenCalledWith(hugePrompt);

      const opts = mockSpawn.mock.calls[0][2] as { stdio: unknown };
      expect(opts.stdio).toEqual(["pipe", "pipe", "pipe"]);
    });

    it("keeps argv path when promptFromStdin is absent", async () => {
      mockSpawn.mockReturnValue(fakeChild("ok", 0) as never);
      const provider = new CLIAgentProvider("claude", CLAUDE_CONFIG);

      await provider.execute("short prompt", DEFAULT_OPTIONS);

      const args = mockSpawn.mock.calls[0][1] as string[];
      expect(args).toContain("-p");
      expect(args).toContain("short prompt");
      const opts = mockSpawn.mock.calls[0][2] as { stdio: unknown };
      expect(opts.stdio).toEqual(["ignore", "pipe", "pipe"]);
    });
  });
});

// ── buildChildEnv ───────────────────────────────────────────────────

describe("buildChildEnv", () => {
  it("drops empty-string vars from the parent env", () => {
    const result = buildChildEnv({ FOO: "bar", EMPTY: "", NESTED: "value" });
    expect(result.FOO).toBe("bar");
    expect(result.NESTED).toBe("value");
    expect(result.EMPTY).toBeUndefined();
  });

  it("drops undefined vars from the parent env", () => {
    const result = buildChildEnv({ FOO: "bar", MISSING: undefined });
    expect(result.FOO).toBe("bar");
    expect(result.MISSING).toBeUndefined();
  });

  it("applies overrides on top of parent env", () => {
    const result = buildChildEnv({ FOO: "bar" }, { BAZ: "qux" });
    expect(result.FOO).toBe("bar");
    expect(result.BAZ).toBe("qux");
  });

  it("treats empty-string overrides as a deletion", () => {
    const result = buildChildEnv({ FOO: "bar", BAZ: "qux" }, { BAZ: "" });
    expect(result.FOO).toBe("bar");
    expect(result.BAZ).toBeUndefined();
  });

  it("overrides win over parent values", () => {
    const result = buildChildEnv({ FOO: "parent" }, { FOO: "override" });
    expect(result.FOO).toBe("override");
  });

  it("strips GitHub credential vars so the agent cannot authenticate gh against the PR", () => {
    // Regression: an agent inheriting these auth'd `gh` and overwrote the
    // orchestrator-authored PR description (2026-06-19). The orchestrator owns
    // the PR; the agent must never reach the GitHub PR API.
    const result = buildChildEnv({
      FOO: "bar",
      GH_TOKEN: "ghp_secret",
      GITHUB_TOKEN: "ghs_secret",
      GH_ENTERPRISE_TOKEN: "x",
      GITHUB_ENTERPRISE_TOKEN: "y",
    });
    expect(result.FOO).toBe("bar");
    expect(result.GH_TOKEN).toBeUndefined();
    expect(result.GITHUB_TOKEN).toBeUndefined();
    expect(result.GH_ENTERPRISE_TOKEN).toBeUndefined();
    expect(result.GITHUB_ENTERPRISE_TOKEN).toBeUndefined();
  });
});
