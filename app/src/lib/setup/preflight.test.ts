import { describe, expect, it, vi } from "vitest";
import type { AgentRequirementsResult } from "./agent-requirements.js";
import type { TokenCheckResult } from "./github-check.js";
import type { PreflightReport } from "./preflight-types.js";
import { runPreflight, type PreflightDeps } from "./preflight.js";

const CLAUDE_AND_CURSOR: AgentRequirementsResult = {
  requirements: [
    {
      providerId: "claude",
      command: "claude",
      envVars: [],
      envVarsAnyOf: ["ANTHROPIC_API_KEY"],
      usedBy: ["analyst", "verifier"],
    },
    {
      providerId: "cursor",
      command: "cursor-agent",
      envVars: ["CURSOR_API_KEY"],
      envVarsAnyOf: [],
      usedBy: ["creator"],
    },
  ],
  unknownProviders: [],
};

const PASS_TOKEN: TokenCheckResult = { status: "pass", detail: "Authenticated as octocat." };

function deps(overrides: Partial<PreflightDeps> = {}): PreflightDeps {
  return {
    env: { ANTHROPIC_API_KEY: "a", CURSOR_API_KEY: "c" },
    locate: (cmd) => `/usr/bin/${cmd}`,
    requirements: CLAUDE_AND_CURSOR,
    probeDb: async () => ({ ok: true, message: "opened" }),
    checkToken: async () => PASS_TOKEN,
    ...overrides,
  };
}

function check(report: PreflightReport, id: string) {
  const found = report.checks.find((c) => c.id === id);
  if (!found) throw new Error(`no check ${id} in ${report.checks.map((c) => c.id).join(", ")}`);
  return found;
}

describe("runPreflight — host tooling", () => {
  it("passes a fully provisioned host", async () => {
    const report = await runPreflight(
      { tokenEnvVar: "MANAGED_REPO_GH_TOKEN" },
      deps({ env: { ANTHROPIC_API_KEY: "a", CURSOR_API_KEY: "c", MANAGED_REPO_GH_TOKEN: "t" } }),
    );
    expect(report.ok).toBe(true);
    expect(report.checks.every((c) => c.status === "pass")).toBe(true);
  });

  it("fails when git is missing", async () => {
    const report = await runPreflight({}, deps({ locate: (cmd) => (cmd === "git" ? null : "/bin/x") }));
    expect(check(report, "git").status).toBe("fail");
    expect(report.ok).toBe(false);
  });

  it("fails a missing agent CLI and names the roles it blocks", async () => {
    const report = await runPreflight(
      {},
      deps({ locate: (cmd) => (cmd === "cursor-agent" ? null : "/bin/x") }),
    );
    const cli = check(report, "agent-cli:cursor");
    expect(cli.status).toBe("fail");
    expect(cli.detail).toContain("creator");
    expect(report.ok).toBe(false);
  });

  it("only warns on an unset agent credential, because the engine may hold it", async () => {
    const report = await runPreflight({}, deps({ env: { ANTHROPIC_API_KEY: "a" } }));
    const env = check(report, "agent-env:cursor");
    expect(env.status).toBe("warn");
    expect(env.detail).toContain("CURSOR_API_KEY");
    expect(env.hint).toContain("app process");
    expect(report.ok).toBe(true);
  });

  it("warns instead of failing when no agent roles are configured yet", async () => {
    const report = await runPreflight(
      {},
      deps({ requirements: { requirements: [], unknownProviders: [] } }),
    );
    expect(check(report, "agent-cli").status).toBe("warn");
    expect(report.ok).toBe(true);
  });

  it("surfaces roles that point at an undefined provider", async () => {
    const report = await runPreflight(
      {},
      deps({
        requirements: { requirements: CLAUDE_AND_CURSOR.requirements, unknownProviders: ["ghost"] },
      }),
    );
    expect(check(report, "agent-provider-config").detail).toContain("ghost");
  });

  it("omits the provider-config check when every provider resolves", async () => {
    const report = await runPreflight({}, deps());
    expect(report.checks.some((c) => c.id === "agent-provider-config")).toBe(false);
  });
});

describe("runPreflight — engine database", () => {
  it("skips the database check until a path is chosen", async () => {
    const probeDb = vi.fn(async () => ({ ok: true, message: "opened" }));
    const report = await runPreflight({}, deps({ probeDb }));
    expect(report.checks.some((c) => c.id === "engine-db")).toBe(false);
    expect(probeDb).not.toHaveBeenCalled();
  });

  it("passes a writable database path", async () => {
    const report = await runPreflight({ dbPath: "/var/lib/operator/operator.db" }, deps());
    const db = check(report, "engine-db");
    expect(db.status).toBe("pass");
    expect(db.detail).toContain("/var/lib/operator/operator.db");
  });

  it("fails an unwritable database path", async () => {
    const report = await runPreflight(
      { dbPath: "/root/operator.db" },
      deps({ probeDb: async () => ({ ok: false, message: "EACCES: permission denied" }) }),
    );
    expect(check(report, "engine-db").status).toBe("fail");
    expect(report.ok).toBe(false);
  });
});

describe("runPreflight — git host token", () => {
  it("uses the named environment variable when it is visible", async () => {
    const checkToken = vi.fn(async () => PASS_TOKEN);
    const report = await runPreflight(
      { tokenEnvVar: "MANAGED_REPO_GH_TOKEN", repoSlug: "owner/sample" },
      deps({ env: { MANAGED_REPO_GH_TOKEN: "env-token" }, checkToken }),
    );
    expect(checkToken).toHaveBeenCalledWith({ token: "env-token", repoSlug: "owner/sample" });
    expect(check(report, "vcs-token").detail).toContain("MANAGED_REPO_GH_TOKEN");
  });

  it("prefers a pasted token and labels it as not stored", async () => {
    const checkToken = vi.fn(async () => PASS_TOKEN);
    const report = await runPreflight(
      { tokenEnvVar: "MANAGED_REPO_GH_TOKEN", token: "  pasted  " },
      deps({ env: { MANAGED_REPO_GH_TOKEN: "env-token" }, checkToken }),
    );
    expect(checkToken).toHaveBeenCalledWith({ token: "pasted" });
    expect(check(report, "vcs-token").detail).toContain("not stored");
  });

  it("warns, rather than fails, when the variable is invisible and nothing was pasted", async () => {
    const checkToken = vi.fn(async () => PASS_TOKEN);
    const report = await runPreflight(
      { tokenEnvVar: "MANAGED_REPO_GH_TOKEN" },
      deps({ env: {}, checkToken }),
    );
    const token = check(report, "vcs-token");
    expect(token.status).toBe("warn");
    expect(token.hint).toContain("Paste a token");
    expect(checkToken).not.toHaveBeenCalled();
    expect(report.ok).toBe(true);
  });

  it("warns when no variable has been named yet", async () => {
    const report = await runPreflight({}, deps({ env: {} }));
    const token = check(report, "vcs-token");
    expect(token.status).toBe("warn");
    expect(token.detail).toContain("No token to test with");
  });

  it("propagates a rejected token as a blocking failure", async () => {
    const report = await runPreflight(
      { tokenEnvVar: "MANAGED_REPO_GH_TOKEN" },
      deps({
        env: { MANAGED_REPO_GH_TOKEN: "bad" },
        checkToken: async () => ({
          status: "fail",
          detail: "GitHub rejected the token (401).",
          hint: "Generate a new token.",
        }),
      }),
    );
    const token = check(report, "vcs-token");
    expect(token.status).toBe("fail");
    expect(token.hint).toBe("Generate a new token.");
    expect(report.ok).toBe(false);
  });

  it("treats a blank pasted token as absent", async () => {
    const checkToken = vi.fn(async () => PASS_TOKEN);
    await runPreflight(
      { tokenEnvVar: "MANAGED_REPO_GH_TOKEN", token: "   " },
      deps({ env: { MANAGED_REPO_GH_TOKEN: "env-token" }, checkToken }),
    );
    expect(checkToken).toHaveBeenCalledWith({ token: "env-token" });
  });
});
