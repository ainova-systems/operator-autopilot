import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { execFile } from "node:child_process";
import { access, mkdir } from "node:fs/promises";
import type { OperationContext } from "@operator/core";
import { ConfigError, WorkspaceError } from "@operator/core";

// Mock child_process and fs
vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}));

vi.mock("node:fs/promises", () => ({
  access: vi.fn(),
  mkdir: vi.fn(),
}));

// Import after mocks
const { workspaceEnsure, workspaceCheckoutBranch, workspaceSync, workspaceReset, workspaceSetupEnv } =
  await import("./workspace.js");

const mockExecFile = vi.mocked(execFile);
const mockAccess = vi.mocked(access);
const mockMkdir = vi.mocked(mkdir);

function makeCtx(overrides?: Partial<OperationContext>): OperationContext {
  return {
    traceId: "test-trace-id",
    repoId: "test-repo",
    action: "test",
    budget: { spentUsd: 0, add: vi.fn(), isExceeded: () => false },
    signal: AbortSignal.timeout(30_000),
    ...overrides,
  };
}

const repoInfo = {
  id: "my-repo",
  repo: "owner/my-repo",
  branch: "main",
  tokenEnvVar: "TEST_GH_TOKEN",
};

const gitIdentity = {
  name: "Operator Bot",
  email: "operator@example.com",
};

/**
 * Helper: make mockExecFile succeed for all calls by default.
 * Optionally fail for specific command patterns.
 */
function setupExecFileSuccess() {
  mockExecFile.mockImplementation((_cmd: unknown, _args: unknown, _opts: unknown, cb: unknown) => {
    const callback = cb as (err: Error | null, stdout: string, stderr: string) => void;
    callback(null, "", "");
    return { kill: vi.fn(), on: vi.fn() } as never;
  });
}

function setupExecFileFailure(errorMsg: string) {
  mockExecFile.mockImplementation((_cmd: unknown, _args: unknown, _opts: unknown, cb: unknown) => {
    const callback = cb as (err: Error | null, stdout: string, stderr: string) => void;
    callback(new Error(errorMsg), "", errorMsg);
    return { kill: vi.fn(), on: vi.fn() } as never;
  });
}

describe("workspaceEnsure", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    process.env["TEST_GH_TOKEN"] = "ghp_test_token";
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("clones when workspace does not exist", async () => {
    mockAccess.mockRejectedValue(new Error("ENOENT"));
    mockMkdir.mockResolvedValue(undefined);
    setupExecFileSuccess();

    const ctx = makeCtx();
    const result = await workspaceEnsure("/base", repoInfo, gitIdentity, ctx);

    expect(result).toMatch(/my-repo/);
    expect(mockMkdir).toHaveBeenCalled();

    // Should have called gh repo clone
    const ghCalls = mockExecFile.mock.calls.filter(
      (call) => call[0] === "gh",
    );
    expect(ghCalls.length).toBeGreaterThan(0);
    const cloneCall = ghCalls.find(
      (call) => Array.isArray(call[1]) && (call[1] as string[]).includes("clone"),
    );
    expect(cloneCall).toBeDefined();
  });

  it("fetches and resets when workspace already exists", async () => {
    mockAccess.mockResolvedValue(undefined);
    setupExecFileSuccess();

    const ctx = makeCtx();
    await workspaceEnsure("/base", repoInfo, gitIdentity, ctx);

    // Should have called git fetch
    const gitCalls = mockExecFile.mock.calls.filter(
      (call) => call[0] === "git",
    );
    const fetchCall = gitCalls.find(
      (call) => Array.isArray(call[1]) && (call[1] as string[]).includes("fetch"),
    );
    expect(fetchCall).toBeDefined();

    // Should have called git reset --hard
    const resetCall = gitCalls.find(
      (call) => Array.isArray(call[1]) && (call[1] as string[]).includes("reset"),
    );
    expect(resetCall).toBeDefined();
  });

  it("sets git identity after clone", async () => {
    mockAccess.mockRejectedValue(new Error("ENOENT"));
    mockMkdir.mockResolvedValue(undefined);
    setupExecFileSuccess();

    const ctx = makeCtx();
    await workspaceEnsure("/base", repoInfo, gitIdentity, ctx);

    const gitCalls = mockExecFile.mock.calls.filter(
      (call) => call[0] === "git",
    );
    const nameCall = gitCalls.find(
      (call) =>
        Array.isArray(call[1]) &&
        (call[1] as string[]).includes("user.name"),
    );
    const emailCall = gitCalls.find(
      (call) =>
        Array.isArray(call[1]) &&
        (call[1] as string[]).includes("user.email"),
    );
    expect(nameCall).toBeDefined();
    expect(emailCall).toBeDefined();
  });

  it("throws ConfigError when token env var is not set", async () => {
    delete process.env["TEST_GH_TOKEN"];
    const ctx = makeCtx();

    await expect(
      workspaceEnsure("/base", repoInfo, gitIdentity, ctx),
    ).rejects.toThrow(ConfigError);
  });

  it("handles checkout fallback to -B when checkout fails on existing workspace", async () => {
    mockAccess.mockResolvedValue(undefined);
    let callCount = 0;
    mockExecFile.mockImplementation(
      (_cmd: unknown, args: unknown, _opts: unknown, cb: unknown) => {
        const callback = cb as (err: Error | null, stdout: string, stderr: string) => void;
        const argArray = args as string[];
        // Fail the first checkout attempt, succeed on -B variant and everything else
        if (argArray[0] === "checkout" && !argArray.includes("-B")) {
          callCount++;
          if (callCount === 1) {
            callback(new Error("branch not found"), "", "error: pathspec 'main' did not match");
            return { kill: vi.fn(), on: vi.fn() } as never;
          }
        }
        callback(null, "", "");
        return { kill: vi.fn(), on: vi.fn() } as never;
      },
    );

    const ctx = makeCtx();
    await workspaceEnsure("/base", repoInfo, gitIdentity, ctx);

    // Should have attempted checkout -B as fallback
    const gitCalls = mockExecFile.mock.calls.filter(
      (call) => call[0] === "git",
    );
    const checkoutBCalls = gitCalls.filter(
      (call) => Array.isArray(call[1]) && (call[1] as string[]).includes("-B"),
    );
    expect(checkoutBCalls.length).toBeGreaterThan(0);
  });

  it("handles checkout fail after clone (branch already default)", async () => {
    mockAccess.mockRejectedValue(new Error("ENOENT"));
    mockMkdir.mockResolvedValue(undefined);

    mockExecFile.mockImplementation(
      (_cmd: unknown, args: unknown, _opts: unknown, cb: unknown) => {
        const callback = cb as (err: Error | null, stdout: string, stderr: string) => void;
        const argArray = args as string[];
        // After clone, fail the checkout (branch is already checked out as default)
        if (_cmd === "git" && argArray[0] === "checkout" && !argArray.includes("-B") && !argArray.includes("config")) {
          callback(new Error("already on main"), "", "Already on 'main'");
          return { kill: vi.fn(), on: vi.fn() } as never;
        }
        callback(null, "", "");
        return { kill: vi.fn(), on: vi.fn() } as never;
      },
    );

    const ctx = makeCtx();
    // Should not throw — checkout fail after clone is ignored
    await expect(workspaceEnsure("/base", repoInfo, gitIdentity, ctx)).resolves.toBeDefined();
  });

  it("rejects when signal is already aborted", async () => {
    mockAccess.mockResolvedValue(undefined);
    setupExecFileSuccess();

    const controller = new AbortController();
    controller.abort();
    const ctx = makeCtx({ signal: controller.signal });

    await expect(
      workspaceEnsure("/base", repoInfo, gitIdentity, ctx),
    ).rejects.toThrow(WorkspaceError);
  });

  it("throws WorkspaceError when git command fails in existing workspace", async () => {
    mockAccess.mockResolvedValue(undefined);
    // First call (gh auth) succeeds, second call (git fetch) fails
    let callNum = 0;
    mockExecFile.mockImplementation((_cmd: unknown, args: unknown, _opts: unknown, cb: unknown) => {
      const callback = cb as (err: Error | null, stdout: string, stderr: string) => void;
      callNum++;
      if (callNum === 2) {
        // git fetch fails
        callback(new Error("fetch failed"), "", "fatal: could not read from remote");
        return { kill: vi.fn(), on: vi.fn() } as never;
      }
      callback(null, "", "");
      return { kill: vi.fn(), on: vi.fn() } as never;
    });

    const ctx = makeCtx();
    await expect(workspaceEnsure("/base", repoInfo, gitIdentity, ctx)).rejects.toThrow(WorkspaceError);
  });
});

describe("workspaceCheckoutBranch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("fetches and checks out the specified branch", async () => {
    setupExecFileSuccess();
    const ctx = makeCtx();

    await workspaceCheckoutBranch("/base", "my-repo", "feature/test", ctx);

    const gitCalls = mockExecFile.mock.calls.filter(
      (call) => call[0] === "git",
    );

    const fetchCall = gitCalls.find(
      (call) =>
        Array.isArray(call[1]) &&
        (call[1] as string[]).includes("fetch") &&
        (call[1] as string[]).includes("feature/test"),
    );
    expect(fetchCall).toBeDefined();

    const checkoutCall = gitCalls.find(
      (call) =>
        Array.isArray(call[1]) &&
        (call[1] as string[]).includes("-B") &&
        (call[1] as string[]).includes("feature/test"),
    );
    expect(checkoutCall).toBeDefined();
  });

  it("throws WorkspaceError when fetch fails", async () => {
    setupExecFileFailure("fetch failed");
    const ctx = makeCtx();

    await expect(
      workspaceCheckoutBranch("/base", "my-repo", "feature/test", ctx),
    ).rejects.toThrow(WorkspaceError);
  });
});

describe("workspaceSync", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("fetches, checks out, resets and cleans", async () => {
    setupExecFileSuccess();
    const ctx = makeCtx();

    await workspaceSync("/base", repoInfo, ctx);

    const gitCalls = mockExecFile.mock.calls.filter(
      (call) => call[0] === "git",
    );

    // fetch, checkout, reset, clean — at least 4 git commands
    expect(gitCalls.length).toBeGreaterThanOrEqual(4);

    const cmdNames = gitCalls.map(
      (call) => (call[1] as string[])[0],
    );
    expect(cmdNames).toContain("fetch");
    expect(cmdNames).toContain("checkout");
    expect(cmdNames).toContain("reset");
    expect(cmdNames).toContain("clean");
  });

  it("falls back to checkout -B when checkout fails", async () => {
    let checkoutAttempt = 0;
    mockExecFile.mockImplementation(
      (_cmd: unknown, args: unknown, _opts: unknown, cb: unknown) => {
        const callback = cb as (err: Error | null, stdout: string, stderr: string) => void;
        const argArray = args as string[];
        if (argArray[0] === "checkout" && !argArray.includes("-B")) {
          checkoutAttempt++;
          callback(new Error("not found"), "", "error");
          return { kill: vi.fn(), on: vi.fn() } as never;
        }
        callback(null, "", "");
        return { kill: vi.fn(), on: vi.fn() } as never;
      },
    );

    const ctx = makeCtx();
    await workspaceSync("/base", repoInfo, ctx);

    expect(checkoutAttempt).toBe(1);
  });
});

describe("workspaceReset", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("resets, cleans, and checks out branch", async () => {
    setupExecFileSuccess();
    const ctx = makeCtx();

    await workspaceReset("/base", repoInfo, ctx);

    const gitCalls = mockExecFile.mock.calls.filter(
      (call) => call[0] === "git",
    );

    const cmdNames = gitCalls.map(
      (call) => (call[1] as string[])[0],
    );
    expect(cmdNames).toContain("reset");
    expect(cmdNames).toContain("clean");
    expect(cmdNames).toContain("checkout");
  });

  it("does not throw when checkout fails (branch may not exist)", async () => {
    let _callIndex = 0;
    mockExecFile.mockImplementation(
      (_cmd: unknown, args: unknown, _opts: unknown, cb: unknown) => {
        const callback = cb as (err: Error | null, stdout: string, stderr: string) => void;
        const argArray = args as string[];
        _callIndex++;
        if (argArray[0] === "checkout") {
          callback(new Error("branch not found"), "", "error");
          return { kill: vi.fn(), on: vi.fn() } as never;
        }
        callback(null, "", "");
        return { kill: vi.fn(), on: vi.fn() } as never;
      },
    );

    const ctx = makeCtx();
    // Should not throw even though checkout fails
    await expect(workspaceReset("/base", repoInfo, ctx)).resolves.toBeUndefined();
  });
});

describe("workspaceSetupEnv", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("returns token, automationDir, and workspaceDir", () => {
    process.env["TEST_GH_TOKEN"] = "ghp_test";
    const result = workspaceSetupEnv("/base", repoInfo);

    expect(result.ghToken).toBe("ghp_test");
    expect(result.workspaceDir).toMatch(/my-repo/);
    expect(result.automationDir).toMatch(/\.operator/);
  });

  it("throws ConfigError when token is missing", () => {
    delete process.env["TEST_GH_TOKEN"];
    expect(() => workspaceSetupEnv("/base", repoInfo)).toThrow(ConfigError);
  });
});
