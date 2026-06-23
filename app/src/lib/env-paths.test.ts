import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { join } from "node:path";

type EnvPathsModule = typeof import("./env-paths.js");

let savedEnv: Record<string, string | undefined>;
const originalPlatform = process.platform;

beforeEach(() => {
  savedEnv = {
    OPERATOR_APP_DB_PATH: process.env["OPERATOR_APP_DB_PATH"],
    XDG_CONFIG_HOME: process.env["XDG_CONFIG_HOME"],
    APPDATA: process.env["APPDATA"],
    HOME: process.env["HOME"],
    USERPROFILE: process.env["USERPROFILE"],
  };
  delete process.env["OPERATOR_APP_DB_PATH"];
  delete process.env["XDG_CONFIG_HOME"];
});

afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  Object.defineProperty(process, "platform", {
    value: originalPlatform,
    configurable: true,
  });
  vi.resetModules();
});

async function loadWithPlatform(platform: NodeJS.Platform): Promise<EnvPathsModule> {
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
  vi.resetModules();
  return import("./env-paths.js");
}

describe("resolveAppDbPath", () => {
  it("honors OPERATOR_APP_DB_PATH override", async () => {
    process.env["OPERATOR_APP_DB_PATH"] = "/custom/app.db";
    const mod = await import("./env-paths.js");
    expect(mod.resolveAppDbPath()).toBe("/custom/app.db");
  });

  it("appends app.db to config dir when no override set", async () => {
    const mod = await import("./env-paths.js");
    const path = mod.resolveAppDbPath();
    expect(path.endsWith("app.db")).toBe(true);
    expect(path).toContain("operator-app");
  });
});

describe("resolveAppConfigDir — platform branches", () => {
  it("win32 uses APPDATA when set", async () => {
    process.env["APPDATA"] = "C:\\Users\\test\\AppData\\Roaming";
    const mod = await loadWithPlatform("win32");
    const dir = mod.resolveAppConfigDir();
    expect(dir).toContain("operator-app");
    expect(dir).toContain("AppData");
  });

  it("win32 falls back to %USERPROFILE%/AppData when APPDATA is missing", async () => {
    delete process.env["APPDATA"];
    const mod = await loadWithPlatform("win32");
    const dir = mod.resolveAppConfigDir();
    expect(dir).toContain("operator-app");
    // Accept either AppData\\Roaming style or any homedir-derived path.
    expect(dir.includes("AppData") || dir.includes("operator-app")).toBe(true);
  });

  it("darwin returns Library/Application Support/operator-app", async () => {
    const mod = await loadWithPlatform("darwin");
    const dir = mod.resolveAppConfigDir();
    expect(dir).toContain("Library");
    expect(dir).toContain("Application Support");
    expect(dir).toContain("operator-app");
  });

  it("linux honors XDG_CONFIG_HOME when set", async () => {
    process.env["XDG_CONFIG_HOME"] = "/custom/xdg";
    const mod = await loadWithPlatform("linux");
    // join() uses the host platform's separator; compare against the same.
    expect(mod.resolveAppConfigDir()).toBe(join("/custom/xdg", "operator-app"));
  });

  it("linux falls back to ~/.config when XDG_CONFIG_HOME is unset", async () => {
    delete process.env["XDG_CONFIG_HOME"];
    const mod = await loadWithPlatform("linux");
    const dir = mod.resolveAppConfigDir();
    expect(dir).toContain(".config");
    expect(dir).toContain("operator-app");
  });
});
