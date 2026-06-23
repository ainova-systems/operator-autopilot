import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { mkdir, access } from "node:fs/promises";
import { constants } from "node:fs";
import type { OperationContext } from "@operator/core";
import type { GitIdentity } from "./env.js";
import { WorkspaceError } from "@operator/core";
import { requireEnvToken, workspacePath } from "./env.js";

/** Options for workspace operations, extracted from project config. */
export interface WorkspaceRepoInfo {
  readonly id: string;
  readonly repo: string;
  readonly branch: string;
  readonly tokenEnvVar: string;
}

/**
 * Execute a git command in a given directory.
 * Returns stdout on success, throws WorkspaceError on failure.
 */
/**
 * Hard ceiling for any single git/gh subprocess. Long enough to clone a
 * mid-sized repo over a slow connection but short enough that a hung
 * credential prompt or a dropped TCP session does not freeze the daemon
 * forever. Without this cap the cycle silently stops emitting logs and
 * sits idle waiting for git that will never return.
 */
const SUBPROCESS_TIMEOUT_MS = 5 * 60 * 1000;

function execGit(
  args: string[],
  cwd: string,
  ctx: OperationContext,
  env?: Record<string, string>,
): Promise<string> {
  if (ctx.signal.aborted) {
    return Promise.reject(
      new WorkspaceError("WS_ABORTED", `git ${args[0]} aborted before start`),
    );
  }
  return new Promise((resolve, reject) => {
    const mergedEnv = { ...process.env, ...env };
    const child = execFile(
      "git",
      args,
      { cwd, env: mergedEnv, timeout: SUBPROCESS_TIMEOUT_MS },
      (err, stdout, stderr) => {
        if (err) {
          const code = (err as NodeJS.ErrnoException).code;
          const message = code === "ETIMEDOUT"
            ? `git ${args[0]} timed out after ${SUBPROCESS_TIMEOUT_MS}ms in ${cwd}`
            : `git ${args[0]} failed in ${cwd}: ${stderr || err.message}`;
          reject(new WorkspaceError(
            code === "ETIMEDOUT" ? "WS_GIT_TIMEOUT" : "WS_GIT_FAILED",
            message,
            { cause: err },
          ));
          return;
        }
        resolve(stdout.trim());
      },
    );

    const onAbort = () => {
      child.kill();
      reject(new WorkspaceError("WS_ABORTED", `git ${args[0]} aborted (traceId: ${ctx.traceId})`));
    };
    ctx.signal.addEventListener("abort", onAbort, { once: true });
    child.on("close", () => ctx.signal.removeEventListener("abort", onAbort));
  });
}

/**
 * Execute `gh` CLI command in a given directory.
 */
function execGh(
  args: string[],
  cwd: string,
  ctx: OperationContext,
  env?: Record<string, string>,
): Promise<string> {
  if (ctx.signal.aborted) {
    return Promise.reject(
      new WorkspaceError("WS_ABORTED", `gh ${args[0]} aborted before start`),
    );
  }
  return new Promise((resolve, reject) => {
    const mergedEnv = { ...process.env, ...env };
    const child = execFile(
      "gh",
      args,
      { cwd, env: mergedEnv, timeout: SUBPROCESS_TIMEOUT_MS },
      (err, stdout, stderr) => {
        if (err) {
          const code = (err as NodeJS.ErrnoException).code;
          const message = code === "ETIMEDOUT"
            ? `gh ${args[0]} timed out after ${SUBPROCESS_TIMEOUT_MS}ms in ${cwd}`
            : `gh ${args[0]} failed: ${stderr || err.message}`;
          reject(new WorkspaceError(
            code === "ETIMEDOUT" ? "WS_GH_TIMEOUT" : "WS_GH_FAILED",
            message,
            { cause: err },
          ));
          return;
        }
        resolve(stdout.trim());
      },
    );

    const onAbort = () => {
      child.kill();
      reject(new WorkspaceError("WS_ABORTED", `gh ${args[0]} aborted`));
    };
    ctx.signal.addEventListener("abort", onAbort, { once: true });
    child.on("close", () => ctx.signal.removeEventListener("abort", onAbort));
  });
}

/**
 * Check if a directory exists and is a git repo.
 */
async function isGitRepo(dir: string): Promise<boolean> {
  try {
    await access(resolve(dir, ".git"), constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Ensure a workspace directory exists and is up to date.
 *
 * If the workspace already exists (has `.git/`), it fetches, checks out the
 * branch, resets to origin, and cleans. Otherwise it clones via `gh`.
 */
export async function workspaceEnsure(
  workspaceBaseDir: string,
  repoInfo: WorkspaceRepoInfo,
  gitIdentity: GitIdentity,
  ctx: OperationContext,
): Promise<string> {
  const workspace = workspacePath(workspaceBaseDir, repoInfo.id);
  const token = requireEnvToken(repoInfo.tokenEnvVar);
  const tokenEnv = { GH_TOKEN: token };

  if (await isGitRepo(workspace)) {
    // Existing workspace: configure credential helper and fetch
    await execGh(["auth", "setup-git"], workspace, ctx, tokenEnv).catch(() => {
      // Non-critical: gh auth setup-git may not be available
    });

    // Reset + clean BEFORE checkout — a previous cycle that crashed
    // mid-stage may have left modified files in the working tree, and
    // `git checkout <branch>` refuses to switch when those files would
    // be overwritten. Resetting against current HEAD is safe because
    // we are about to point at origin anyway.
    await execGit(["reset", "--hard", "HEAD", "--quiet"], workspace, ctx);
    await execGit(["clean", "-fd", "--quiet"], workspace, ctx);

    await execGit(["fetch", "origin", "--prune", "--quiet"], workspace, ctx, tokenEnv);

    // Try checking out branch; if it doesn't exist locally, create from origin
    try {
      await execGit(["checkout", repoInfo.branch, "--quiet"], workspace, ctx);
    } catch {
      await execGit(
        ["checkout", "-B", repoInfo.branch, `origin/${repoInfo.branch}`, "--quiet"],
        workspace,
        ctx,
      );
    }

    await execGit(["reset", "--hard", `origin/${repoInfo.branch}`, "--quiet"], workspace, ctx);
    await execGit(["clean", "-fd", "--quiet"], workspace, ctx);
  } else {
    // New workspace: clone via gh
    const parentDir = resolve(workspace, "..");
    await mkdir(parentDir, { recursive: true });
    await execGh(
      ["repo", "clone", repoInfo.repo, workspace, "--", "--quiet"],
      parentDir,
      ctx,
      tokenEnv,
    );

    // Checkout target branch (may already be default)
    try {
      await execGit(["checkout", repoInfo.branch, "--quiet"], workspace, ctx);
    } catch {
      // Branch is likely already checked out (default branch)
    }
  }

  // Setup git identity
  await execGit(["config", "user.name", gitIdentity.name], workspace, ctx);
  await execGit(["config", "user.email", gitIdentity.email], workspace, ctx);

  return workspace;
}

/**
 * Checkout a specific branch in workspace (fetch from origin first).
 */
export async function workspaceCheckoutBranch(
  workspaceBaseDir: string,
  repoId: string,
  branch: string,
  ctx: OperationContext,
): Promise<void> {
  const workspace = workspacePath(workspaceBaseDir, repoId);
  await execGit(["fetch", "origin", branch, "--quiet"], workspace, ctx);
  await execGit(["checkout", "-B", branch, `origin/${branch}`, "--quiet"], workspace, ctx);
}

/**
 * Sync workspace to latest base branch (fetch + reset + clean).
 */
export async function workspaceSync(
  workspaceBaseDir: string,
  repoInfo: WorkspaceRepoInfo,
  ctx: OperationContext,
): Promise<void> {
  const workspace = workspacePath(workspaceBaseDir, repoInfo.id);

  // Clean workspace before checkout (prevents dirty state from blocking branch switch)
  await execGit(["reset", "--hard", "HEAD", "--quiet"], workspace, ctx);
  await execGit(["clean", "-fd", "--quiet"], workspace, ctx);

  await execGit(["fetch", "origin", repoInfo.branch, "--quiet"], workspace, ctx);

  try {
    await execGit(["checkout", repoInfo.branch, "--quiet"], workspace, ctx);
  } catch {
    await execGit(
      ["checkout", "-B", repoInfo.branch, `origin/${repoInfo.branch}`, "--quiet"],
      workspace,
      ctx,
    );
  }

  await execGit(["reset", "--hard", `origin/${repoInfo.branch}`, "--quiet"], workspace, ctx);
  await execGit(["clean", "-fd", "--quiet"], workspace, ctx);
}

/**
 * Return workspace to default branch, reset and clean.
 */
export async function workspaceReset(
  workspaceBaseDir: string,
  repoInfo: WorkspaceRepoInfo,
  ctx: OperationContext,
): Promise<void> {
  const workspace = workspacePath(workspaceBaseDir, repoInfo.id);

  await execGit(["reset", "--hard", "HEAD", "--quiet"], workspace, ctx);
  await execGit(["clean", "-fd", "--quiet"], workspace, ctx);

  try {
    await execGit(["checkout", repoInfo.branch, "--quiet"], workspace, ctx);
  } catch {
    // Branch may not exist locally — non-critical
  }
}

/**
 * Resolve GH_TOKEN and workspace path for a repo.
 * Returns the values for callers to use (no global env mutation).
 */
export function workspaceSetupEnv(
  workspaceBaseDir: string,
  repoInfo: WorkspaceRepoInfo,
): { ghToken: string; automationDir: string; workspaceDir: string } {
  const ghToken = requireEnvToken(repoInfo.tokenEnvVar);
  const workspaceDir = workspacePath(workspaceBaseDir, repoInfo.id);
  const automationDir = resolve(workspaceDir, ".operator");
  return { ghToken, automationDir, workspaceDir };
}
