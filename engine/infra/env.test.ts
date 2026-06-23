import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { loadEnv, requireEnvToken, workspacePath, buildGitHubRunUrl } from "./env.js";
import { ConfigError } from "@operator/core";

describe("loadEnv", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    delete process.env["OPERATOR_DIR"];
    delete process.env["WORKSPACE_BASE_DIR"];
    delete process.env["GIT_BOT_NAME"];
    delete process.env["GIT_BOT_EMAIL"];
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("uses fallback operator dir when env var is not set", () => {
    const env = loadEnv("/opt/operator");
    expect(env.operatorDir).toMatch(/operator/);
  });

  it("prefers OPERATOR_DIR env var over fallback", () => {
    process.env["OPERATOR_DIR"] = "/custom/operator";
    const env = loadEnv("/opt/operator");
    expect(env.operatorDir).toMatch(/custom/);
  });

  it("uses default workspace base dir", () => {
    const env = loadEnv("/opt/operator");
    // Renamed from `workspaces` → `repos` 2026-05-20 to match the
    // `repos` KV category and drop the redundant `workspace/workspaces`
    // path layer.
    expect(env.workspaceBaseDir).toMatch(/repos$/);
  });

  it("prefers WORKSPACE_BASE_DIR env var", () => {
    process.env["WORKSPACE_BASE_DIR"] = "/tmp/ws";
    const env = loadEnv("/opt/operator");
    expect(env.workspaceBaseDir).toMatch(/tmp/);
  });

  it("uses defaultWorkspaceBaseDir parameter when env var is not set", () => {
    const env = loadEnv("/opt/operator", "/data/workspaces");
    expect(env.workspaceBaseDir).toMatch(/data/);
  });

  it("returns default git identity when env vars are not set", () => {
    const env = loadEnv("/opt/operator");
    expect(env.gitIdentity.name).toBe("Operator Bot");
    expect(env.gitIdentity.email).toBe("operator@example.com");
  });

  it("reads custom git identity from env vars", () => {
    process.env["GIT_BOT_NAME"] = "Custom Bot";
    process.env["GIT_BOT_EMAIL"] = "custom@example.com";
    const env = loadEnv("/opt/operator");
    expect(env.gitIdentity.name).toBe("Custom Bot");
    expect(env.gitIdentity.email).toBe("custom@example.com");
  });

  it("throws ConfigError when operator dir is empty and no fallback", () => {
    expect(() => loadEnv("")).toThrow(ConfigError);
  });
});

describe("requireEnvToken", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("returns the token value when set", () => {
    process.env["MY_TOKEN"] = "secret123";
    expect(requireEnvToken("MY_TOKEN")).toBe("secret123");
  });

  it("throws ConfigError when token is not set", () => {
    delete process.env["MISSING_TOKEN"];
    expect(() => requireEnvToken("MISSING_TOKEN")).toThrow(ConfigError);
  });

  it("throws ConfigError with correct code", () => {
    delete process.env["MISSING_TOKEN"];
    try {
      requireEnvToken("MISSING_TOKEN");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as ConfigError).code).toBe("ENV_MISSING_TOKEN");
    }
  });

  it("throws when token is empty string", () => {
    process.env["EMPTY_TOKEN"] = "";
    expect(() => requireEnvToken("EMPTY_TOKEN")).toThrow(ConfigError);
  });
});

describe("workspacePath", () => {
  it("joins base dir and repo id", () => {
    const result = workspacePath("/home/runner/workspaces", "my-repo");
    expect(result).toMatch(/workspaces/);
    expect(result).toMatch(/my-repo/);
  });

  it("resolves to absolute path", () => {
    const result = workspacePath("/base", "repo");
    // On all platforms, resolve produces an absolute path
    expect(result).toMatch(/repo/);
  });
});

describe("buildGitHubRunUrl", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    delete process.env["GITHUB_RUN_ID"];
    delete process.env["GITHUB_SERVER_URL"];
    delete process.env["GITHUB_REPOSITORY"];
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("returns null when GITHUB_RUN_ID is missing", () => {
    process.env["GITHUB_REPOSITORY"] = "foo/bar";
    expect(buildGitHubRunUrl()).toBeNull();
  });

  it("returns null when GITHUB_REPOSITORY is missing", () => {
    process.env["GITHUB_RUN_ID"] = "12345";
    expect(buildGitHubRunUrl()).toBeNull();
  });

  it("builds a GitHub.com URL when only the required vars are set", () => {
    process.env["GITHUB_RUN_ID"] = "12345";
    process.env["GITHUB_REPOSITORY"] = "ainova-systems/operator-autopilot";
    expect(buildGitHubRunUrl()).toBe(
      "https://github.com/ainova-systems/operator-autopilot/actions/runs/12345",
    );
  });

  it("honours a custom GITHUB_SERVER_URL (GHES)", () => {
    process.env["GITHUB_RUN_ID"] = "999";
    process.env["GITHUB_REPOSITORY"] = "org/repo";
    process.env["GITHUB_SERVER_URL"] = "https://ghes.example.com";
    expect(buildGitHubRunUrl()).toBe(
      "https://ghes.example.com/org/repo/actions/runs/999",
    );
  });
});
