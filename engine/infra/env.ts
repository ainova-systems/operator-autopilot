import { resolve, join } from "node:path";
import { homedir } from "node:os";
import { ConfigError } from "@operator/core";

function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/") || p.startsWith("~\\")) return join(homedir(), p.slice(2));
  return p;
}

/** Git identity used when committing changes in workspaces. */
export interface GitIdentity {
  readonly name: string;
  readonly email: string;
}

/** Resolved paths and settings from environment variables. */
export interface OperatorEnv {
  /** Absolute path to the Operator repo root (contains config/). */
  readonly operatorDir: string;
  /** Base directory for cloned workspaces. */
  readonly workspaceBaseDir: string;
  /** Git identity for commits. */
  readonly gitIdentity: GitIdentity;
}

/**
 * Resolve the Operator repo root directory.
 *
 * Uses `OPERATOR_DIR` env var if set, otherwise falls back to `fallbackDir`.
 * Validates that the path looks reasonable (non-empty).
 */
function resolveOperatorDir(fallbackDir: string): string {
  const raw = process.env["OPERATOR_DIR"] || fallbackDir;
  if (!raw) {
    throw new ConfigError(
      "ENV_MISSING_OPERATOR_DIR",
      "OPERATOR_DIR environment variable is not set and no fallback provided",
    );
  }
  return resolve(expandHome(raw));
}

/**
 * Resolve the workspace base directory.
 *
 * Priority: `WORKSPACE_BASE_DIR` env var → `defaultBaseDir` parameter →
 * `{operatorDir}/workspaces`. Tilde expansion supported on env var input so
 * users can set `OPERATOR_DIR=~/.operator-state` for full isolation from the
 * operator repo root (no walk-up tool collisions for managed clones).
 */
function resolveWorkspaceBaseDir(operatorDir: string, defaultBaseDir?: string): string {
  const raw = process.env["WORKSPACE_BASE_DIR"] || defaultBaseDir;
  if (raw) return resolve(expandHome(raw));
  // Renamed from `workspaces` to `repos` 2026-05-20 to match the `repos`
  // KV category and drop the redundant "workspace/workspaces" path. Fresh
  // installs land at `{operatorDir}/repos/<id>`. Existing deployments
  // either keep the explicit `WORKSPACE_BASE_DIR` env var or rename the
  // physical directory once.
  return join(operatorDir, "repos");
}

/** Resolve git identity from environment variables. */
function resolveGitIdentity(): GitIdentity {
  return {
    name: process.env["GIT_BOT_NAME"] || "Operator Bot",
    email: process.env["GIT_BOT_EMAIL"] || "operator@example.com",
  };
}

/**
 * Load all Operator environment settings.
 *
 * @param fallbackOperatorDir — fallback for `OPERATOR_DIR` (e.g. `__dirname` based).
 * @param defaultWorkspaceBaseDir — default from config (e.g. from `defaults.yaml`).
 */
export function loadEnv(
  fallbackOperatorDir: string,
  defaultWorkspaceBaseDir?: string,
): OperatorEnv {
  const operatorDir = resolveOperatorDir(fallbackOperatorDir);
  return {
    operatorDir,
    workspaceBaseDir: resolveWorkspaceBaseDir(operatorDir, defaultWorkspaceBaseDir),
    gitIdentity: resolveGitIdentity(),
  };
}

/**
 * Read a token from the environment by variable name.
 *
 * Throws `ConfigError` if the variable is not set or empty.
 */
export function requireEnvToken(varName: string): string {
  const value = process.env[varName];
  if (!value) {
    throw new ConfigError(
      "ENV_MISSING_TOKEN",
      `Required environment variable ${varName} is not set`,
    );
  }
  return value;
}

/**
 * Compute the workspace path for a given repo ID.
 */
export function workspacePath(workspaceBaseDir: string, repoId: string): string {
  return resolve(workspaceBaseDir, repoId);
}

/**
 * Build the current GitHub Actions run URL from env vars, or null if the
 * operator is not running inside a GitHub Actions job.
 *
 * Used for debug/observability links in PR comments on failure paths. Reads
 * `GITHUB_RUN_ID`, `GITHUB_SERVER_URL` (defaults to github.com), and
 * `GITHUB_REPOSITORY` — all three are set by the Actions runner automatically.
 */
export function buildGitHubRunUrl(): string | null {
  const runId = process.env["GITHUB_RUN_ID"];
  const repository = process.env["GITHUB_REPOSITORY"];
  if (!runId || !repository) return null;
  const serverUrl = process.env["GITHUB_SERVER_URL"] || "https://github.com";
  return `${serverUrl}/${repository}/actions/runs/${runId}`;
}
