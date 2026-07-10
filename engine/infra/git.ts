import { execFile } from "node:child_process";

/**
 * Git operations for workspace management.
 * All pipeline stages use this instead of direct git/child_process calls.
 */
export class WorkspaceGit {
  constructor(private readonly cwd: string) {}

  /** Create and checkout a new branch from base. */
  async checkoutNewBranch(name: string, fromBranch: string): Promise<void> {
    await this.exec(["fetch", "origin", fromBranch, "--quiet"]);
    // Delete local branch if exists (leftover from previous run)
    await this.exec(["branch", "-D", name]).catch(() => {});
    await this.exec(["checkout", "-b", name, `origin/${fromBranch}`, "--quiet"]);
  }

  /** Checkout an existing remote branch. */
  async checkoutExisting(branch: string): Promise<void> {
    await this.exec(["fetch", "origin", branch, "--quiet"]);
    await this.exec(["checkout", "-B", branch, `origin/${branch}`, "--quiet"]);
  }

  /** Stage all changes. */
  async addAll(): Promise<void> {
    await this.exec(["add", "-A"]);
  }

  /** Stage specific paths. */
  async addPaths(paths: string[]): Promise<void> {
    await this.exec(["add", ...paths]);
  }

  /** Commit staged changes. Returns commit SHA. Throws if nothing to commit. */
  async commit(message: string): Promise<string> {
    await this.exec(["commit", "-m", message]);
    return this.exec(["rev-parse", "HEAD"]);
  }

  /** Commit staged changes, no-op if nothing to commit. Returns SHA or null. */
  async commitIfChanged(message: string): Promise<string | null> {
    const hasChanges = await this.hasStagedChanges();
    if (!hasChanges) return null;
    return this.commit(message);
  }

  /** Push current branch to origin. */
  async push(branch: string): Promise<void> {
    await this.exec(["push", "-u", "origin", branch]);
  }

  /** Check if a branch exists on the remote. */
  async remoteBranchExists(branch: string): Promise<boolean> {
    const output = await this.exec(["ls-remote", "--heads", "origin", branch]);
    return output.includes(`refs/heads/${branch}`);
  }

  /** Check if working tree has uncommitted changes. */
  async isClean(): Promise<boolean> {
    const result = await this.exec(["status", "--porcelain"]);
    return result.trim() === "";
  }

  /** Check if there are staged changes ready to commit. */
  async hasStagedChanges(): Promise<boolean> {
    try {
      await this.exec(["diff", "--cached", "--quiet"]);
      return false; // exit 0 = no changes
    } catch {
      return true; // exit 1 = has changes
    }
  }

  /** Check if there are any changes (staged + unstaged) since a SHA. */
  async hasChangedSince(sha: string): Promise<boolean> {
    const current = await this.exec(["rev-parse", "HEAD"]);
    return current.trim() !== sha.trim();
  }

  /** Get current HEAD SHA. */
  async headSha(): Promise<string> {
    return this.exec(["rev-parse", "HEAD"]);
  }

  /**
   * Name of the branch HEAD currently points at, or `"HEAD"` when detached.
   *
   * Callers use this to assert that the working tree is still on the branch
   * they prepared before they stage and commit into it.
   */
  async currentBranch(): Promise<string> {
    return this.exec(["rev-parse", "--abbrev-ref", "HEAD"]);
  }

  /** Reset to HEAD and clean untracked files. */
  async resetHard(): Promise<void> {
    await this.exec(["reset", "--hard", "HEAD", "--quiet"]);
    await this.exec(["clean", "-fd", "--quiet"]);
  }

  /** Reset and checkout base branch (cleanup after action). */
  async resetToBase(baseBranch: string): Promise<void> {
    await this.resetHard();
    await this.exec(["checkout", baseBranch, "--quiet"]).catch(() => {});
  }

  /** Configure git identity for commits. */
  async setIdentity(name: string, email: string): Promise<void> {
    await this.exec(["config", "user.name", name]);
    await this.exec(["config", "user.email", email]);
  }

  /**
   * Get list of changed file paths on current branch vs base.
   *
   * Uses three-dot `origin/base...HEAD`: for `git diff` this is the
   * merge-base diff ("what this branch changed"), which is the right set
   * for a PR. Two-dot would be a tip-to-tip diff and would also surface
   * files the base branch changed after divergence. Note the opposite
   * convention to {@link commitCount}, where three-dot `rev-list --count`
   * is the symmetric difference (the wrong metric) and two-dot is correct.
   */
  async changedFiles(baseBranch: string): Promise<string[]> {
    const output = await this.exec(["diff", "--name-only", `origin/${baseBranch}...HEAD`]);
    return output.split("\n").filter(Boolean);
  }

  /** Get diff output (for review). */
  async diff(): Promise<string> {
    const staged = await this.exec(["diff", "--cached"]).catch(() => "");
    const unstaged = await this.exec(["diff"]).catch(() => "");
    return (staged + "\n" + unstaged).trim();
  }

  /**
   * Count commits on the current branch that are ahead of base — i.e.
   * commits reachable from HEAD but not from `origin/baseBranch`.
   *
   * MUST use the two-dot `origin/base..HEAD` range, NOT three-dot
   * `origin/base...HEAD`. With `rev-list --count`, the three-dot form is
   * the SYMMETRIC difference: it also counts every commit that landed on
   * the base branch after this branch diverged. The pr-review review-cycle
   * cap (`maxReviewAttempts`) reads this number as the "attempts so far"
   * proxy, so for any long-lived PR against an active base the count was
   * inflated by the base's independent advances — PR #898 (a finding
   * branch with a single real commit, open ~2.5 months) read 66/20 and was
   * falsely marked failed (2026-06-04). Ahead-of-base only.
   */
  async commitCount(baseBranch: string): Promise<number> {
    const output = await this.exec(["rev-list", "--count", `origin/${baseBranch}..HEAD`]);
    return parseInt(output.trim(), 10) || 0;
  }

  // ── Internal ─────────────────────────────────────────────────────

  private exec(args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile("git", args, { cwd: this.cwd, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err) {
          reject(new Error(`git ${args[0]} failed in ${this.cwd}: ${(stderr || err.message).slice(0, 500)}`));
        } else {
          resolve((stdout || "").trim());
        }
      });
    });
  }
}
