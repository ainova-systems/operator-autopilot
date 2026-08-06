import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resolveCursorWinLauncher,
  resolveClaudeWinLauncher,
  effectiveLauncher,
} from "./win-launcher.js";

async function makeVersion(home: string, ver: string): Promise<string> {
  const dir = join(home, "versions", ver);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "node.exe"), "", "utf-8");
  await writeFile(join(dir, "index.js"), "", "utf-8");
  return dir;
}

/**
 * Reproduce an npm-global claude install: the `.cmd` shim on PATH plus the
 * native `.exe` it delegates to, inside the package's own `node_modules`.
 * `dp0` picks which self-directory macro the shim uses — both shapes ship.
 */
async function makeClaudeShim(
  binDir: string,
  dp0: "%dp0%" | "%~dp0" = "%dp0%",
): Promise<string> {
  const exeDir = join(binDir, "node_modules", "@anthropic-ai", "claude-code", "bin");
  await mkdir(exeDir, { recursive: true });
  const exe = join(exeDir, "claude.exe");
  await writeFile(exe, "", "utf-8");
  await writeFile(
    join(binDir, "claude.cmd"),
    `@ECHO off\r\n"${dp0}\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe"   %*\r\n`,
    "utf-8",
  );
  return exe;
}

describe("resolveCursorWinLauncher", () => {
  let home: string;
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "cursor-home-"));
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it("resolves to the version dir's node.exe + index.js", async () => {
    const dir = await makeVersion(home, "2026.01.28-fd13201");
    const r = resolveCursorWinLauncher(home);
    expect(r).toEqual({ command: join(dir, "node.exe"), prependArgs: [join(dir, "index.js")] });
  });

  it("picks the newest version by date, not lexical order", async () => {
    await makeVersion(home, "2026.01.28-aaaaaaa");
    const newer = await makeVersion(home, "2026.2.3-bbbbbbb"); // later date, lexically "smaller" month
    const r = resolveCursorWinLauncher(home);
    expect(r?.prependArgs[0]).toBe(join(newer, "index.js"));
  });

  it("resolves the newer YYYY.MM.DD-HH-MM-SS-hash version-dir shape", async () => {
    const dir = await makeVersion(home, "2026.06.19-20-24-33-653a7fb");
    const r = resolveCursorWinLauncher(home);
    expect(r).toEqual({ command: join(dir, "node.exe"), prependArgs: [join(dir, "index.js")] });
  });

  // Regression: the old date-only regex did not match the `-HH-MM-SS-hash`
  // shape, so a host with both an old `2026.01.28-...` build and newer
  // timestamped builds silently ran the five-month-stale January one — the
  // version that hit cursor-agent long-session http/2 cancellations.
  it("picks a newer timestamped build over an old date-only build", async () => {
    await makeVersion(home, "2026.01.28-fd13201");
    const june = await makeVersion(home, "2026.06.19-20-24-33-653a7fb");
    const r = resolveCursorWinLauncher(home);
    expect(r?.prependArgs[0]).toBe(join(june, "index.js"));
  });

  it("breaks a same-day tie by the HH-MM-SS build time", async () => {
    await makeVersion(home, "2026.06.19-08-00-00-aaaaaaa");
    const later = await makeVersion(home, "2026.06.19-20-24-33-bbbbbbb");
    const r = resolveCursorWinLauncher(home);
    expect(r?.prependArgs[0]).toBe(join(later, "index.js"));
  });

  it("prefers a direct node.exe + index.js in home (already inside a version dir)", async () => {
    await writeFile(join(home, "node.exe"), "", "utf-8");
    await writeFile(join(home, "index.js"), "", "utf-8");
    const r = resolveCursorWinLauncher(home);
    expect(r).toEqual({ command: join(home, "node.exe"), prependArgs: [join(home, "index.js")] });
  });

  it("returns null when no versions directory exists", () => {
    expect(resolveCursorWinLauncher(home)).toBeNull();
  });

  it("returns null when a version dir lacks node.exe / index.js", async () => {
    await mkdir(join(home, "versions", "2026.01.28-fd13201"), { recursive: true });
    expect(resolveCursorWinLauncher(home)).toBeNull();
  });

  it("ignores directories that do not match the version pattern", async () => {
    await mkdir(join(home, "versions", "not-a-version"), { recursive: true });
    expect(resolveCursorWinLauncher(home)).toBeNull();
  });
});

describe("resolveClaudeWinLauncher", () => {
  let binDir: string;
  beforeEach(async () => {
    binDir = await mkdtemp(join(tmpdir(), "npm-bin-"));
  });
  afterEach(async () => {
    await rm(binDir, { recursive: true, force: true });
  });

  it("resolves the .exe quoted inside the .cmd shim", async () => {
    const exe = await makeClaudeShim(binDir);
    expect(resolveClaudeWinLauncher(binDir)).toEqual({ command: exe, prependArgs: [] });
  });

  it("expands the %~dp0 shim self-directory form too", async () => {
    const exe = await makeClaudeShim(binDir, "%~dp0");
    expect(resolveClaudeWinLauncher(binDir)).toEqual({ command: exe, prependArgs: [] });
  });

  it("prefers a native claude.exe sitting directly on PATH", async () => {
    await makeClaudeShim(binDir);
    const native = join(binDir, "claude.exe");
    await writeFile(native, "", "utf-8");
    expect(resolveClaudeWinLauncher(binDir)).toEqual({ command: native, prependArgs: [] });
  });

  it("walks PATH in order and skips entries without a claude install", async () => {
    const empty = await mkdtemp(join(tmpdir(), "empty-bin-"));
    const exe = await makeClaudeShim(binDir);
    try {
      expect(resolveClaudeWinLauncher(`${empty};"${binDir}"`))
        .toEqual({ command: exe, prependArgs: [] });
    } finally {
      await rm(empty, { recursive: true, force: true });
    }
  });

  it("returns null when the shim points at an .exe that is gone", async () => {
    await writeFile(
      join(binDir, "claude.cmd"),
      `"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe" %*\r\n`,
      "utf-8",
    );
    expect(resolveClaudeWinLauncher(binDir)).toBeNull();
  });

  it("returns null when the shim quotes no .exe target", async () => {
    await writeFile(join(binDir, "claude.cmd"), "@ECHO off\r\nnode index.js %*\r\n", "utf-8");
    expect(resolveClaudeWinLauncher(binDir)).toBeNull();
  });

  it("returns null for an empty or absent PATH", () => {
    expect(resolveClaudeWinLauncher(undefined)).toBeNull();
    expect(resolveClaudeWinLauncher(";  ;")).toBeNull();
  });
});

describe("effectiveLauncher", () => {
  let home: string;
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "cursor-home-"));
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it("is the identity on non-Windows platforms", () => {
    const r = effectiveLauncher("cursor-agent", "linux", { CURSOR_AGENT_HOME: home });
    expect(r).toEqual({ command: "cursor-agent", prependArgs: [] });
  });

  // Regression: claude IS on PATH as `claude` / `claude.cmd` / `claude.ps1`,
  // yet `spawn("claude")` fails ENOENT because CreateProcess resolves only
  // `.exe` — which killed every analyst run (research 20260806: "all 11
  // analyzers failed" in 80ms) once the standalone claude.exe was gone.
  // Returning the bare command here is the bug, not a safe default.
  it("resolves claude on win32 to the .exe its PATH shim points at", async () => {
    const exe = await makeClaudeShim(home);
    const r = effectiveLauncher("claude", "win32", { PATH: home });
    expect(r).toEqual({ command: exe, prependArgs: [] });
  });

  it("reads PATH case-insensitively, as Windows itself does", async () => {
    const exe = await makeClaudeShim(home);
    const r = effectiveLauncher("claude", "win32", { Path: home });
    expect(r).toEqual({ command: exe, prependArgs: [] });
  });

  it("resolves a configured shim path against its own directory, not PATH", async () => {
    const exe = await makeClaudeShim(home);
    const r = effectiveLauncher(join(home, "claude.cmd"), "win32", {});
    expect(r).toEqual({ command: exe, prependArgs: [] });
  });

  it("leaves an explicitly configured claude.exe alone", () => {
    const exe = join(home, "claude.exe");
    expect(effectiveLauncher(exe, "win32", { PATH: home })).toEqual({
      command: exe, prependArgs: [],
    });
  });

  it("is the identity for claude on Linux, where the CLI spawns by name", async () => {
    await makeClaudeShim(home);
    expect(effectiveLauncher("claude", "linux", { PATH: home })).toEqual({
      command: "claude", prependArgs: [],
    });
  });

  it("falls back to the bare claude command when no install is on PATH", () => {
    const r = effectiveLauncher("claude", "win32", { PATH: join(home, "nope") });
    expect(r).toEqual({ command: "claude", prependArgs: [] });
  });

  it("falls back to the bare claude command when the env carries no PATH at all", () => {
    expect(effectiveLauncher("claude", "win32", {})).toEqual({
      command: "claude", prependArgs: [],
    });
  });

  it("is the identity for an unknown command on win32", () => {
    const r = effectiveLauncher("codex", "win32", { PATH: home });
    expect(r).toEqual({ command: "codex", prependArgs: [] });
  });

  it("resolves the cursor launcher on win32 via CURSOR_AGENT_HOME", async () => {
    const dir = await makeVersion(home, "2026.01.28-fd13201");
    const r = effectiveLauncher("cursor-agent", "win32", { CURSOR_AGENT_HOME: home });
    expect(r).toEqual({ command: join(dir, "node.exe"), prependArgs: [join(dir, "index.js")] });
  });

  it("matches the command regardless of path prefix or shim extension", async () => {
    const dir = await makeVersion(home, "2026.01.28-fd13201");
    const r = effectiveLauncher("C:\\tools\\cursor-agent.cmd", "win32", { CURSOR_AGENT_HOME: home });
    expect(r).toEqual({ command: join(dir, "node.exe"), prependArgs: [join(dir, "index.js")] });
  });

  it("falls back to the bare command on win32 when the install is missing", () => {
    const r = effectiveLauncher("cursor-agent", "win32", { CURSOR_AGENT_HOME: join(home, "nope") });
    expect(r).toEqual({ command: "cursor-agent", prependArgs: [] });
  });

  it("falls back to LOCALAPPDATA/cursor-agent when CURSOR_AGENT_HOME is unset", async () => {
    const localAppData = await mkdtemp(join(tmpdir(), "localappdata-"));
    try {
      const dir = await makeVersion(join(localAppData, "cursor-agent"), "2026.01.28-fd13201");
      const r = effectiveLauncher("cursor-agent", "win32", { LOCALAPPDATA: localAppData });
      expect(r).toEqual({ command: join(dir, "node.exe"), prependArgs: [join(dir, "index.js")] });
    } finally {
      await rm(localAppData, { recursive: true, force: true });
    }
  });

  it("falls back to the bare cursor command when neither home env var is set", () => {
    expect(effectiveLauncher("cursor-agent", "win32", {})).toEqual({
      command: "cursor-agent", prependArgs: [],
    });
  });
});
