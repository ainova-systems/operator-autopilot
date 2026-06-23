import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveCursorWinLauncher, effectiveLauncher } from "./win-launcher.js";

async function makeVersion(home: string, ver: string): Promise<string> {
  const dir = join(home, "versions", ver);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "node.exe"), "", "utf-8");
  await writeFile(join(dir, "index.js"), "", "utf-8");
  return dir;
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

  it("is the identity for a non-cursor command on win32 (e.g. claude)", () => {
    const r = effectiveLauncher("claude", "win32", { CURSOR_AGENT_HOME: home });
    expect(r).toEqual({ command: "claude", prependArgs: [] });
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
});
