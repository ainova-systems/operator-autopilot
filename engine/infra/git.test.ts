import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { WorkspaceGit } from "./git.js";

let tempDir: string;
let git: WorkspaceGit;

function execGit(args: string[], cwd?: string): string {
  return execFileSync("git", args, { cwd: cwd || tempDir, encoding: "utf-8" }).trim();
}

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "git-ops-test-"));
  // Init a real git repo
  execGit(["init"]);
  execGit(["config", "user.name", "Test"]);
  execGit(["config", "user.email", "test@test.com"]);
  await writeFile(join(tempDir, "README.md"), "# Test");
  execGit(["add", "."]);
  execGit(["commit", "-m", "Initial commit"]);
  git = new WorkspaceGit(tempDir);
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("WorkspaceGit", () => {
  it("isClean returns true on clean repo", async () => {
    expect(await git.isClean()).toBe(true);
  });

  it("isClean returns false with uncommitted changes", async () => {
    await writeFile(join(tempDir, "dirty.txt"), "change");
    expect(await git.isClean()).toBe(false);
  });

  it("addAll + commit creates a commit", async () => {
    await writeFile(join(tempDir, "new.txt"), "content");
    await git.addAll();
    const sha = await git.commit("Add new file");
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
  });

  it("commitIfChanged returns null when nothing to commit", async () => {
    await git.addAll();
    const result = await git.commitIfChanged("No changes");
    expect(result).toBeNull();
  });

  it("commitIfChanged commits when changes exist", async () => {
    await writeFile(join(tempDir, "file.txt"), "data");
    await git.addAll();
    const sha = await git.commitIfChanged("Has changes");
    expect(sha).not.toBeNull();
  });

  it("headSha returns current HEAD", async () => {
    const sha = await git.headSha();
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
  });

  it("hasChangedSince detects new commits", async () => {
    const before = await git.headSha();
    await writeFile(join(tempDir, "change.txt"), "x");
    await git.addAll();
    await git.commit("New commit");
    expect(await git.hasChangedSince(before)).toBe(true);
  });

  it("hasChangedSince returns false when same SHA", async () => {
    const sha = await git.headSha();
    expect(await git.hasChangedSince(sha)).toBe(false);
  });

  it("resetHard discards changes", async () => {
    await writeFile(join(tempDir, "dirty.txt"), "x");
    expect(await git.isClean()).toBe(false);
    await git.resetHard();
    expect(await git.isClean()).toBe(true);
  });

  it("checkoutNewBranch creates branch from HEAD (local test without origin)", async () => {
    // For local test, create a "fake origin" by adding self as remote
    execGit(["remote", "add", "origin", tempDir]);
    execGit(["fetch", "origin"]);

    await git.checkoutNewBranch("ai/test-branch", "master");
    const branch = execGit(["branch", "--show-current"]);
    expect(branch).toBe("ai/test-branch");
  });

  it("addPaths stages specific files", async () => {
    await writeFile(join(tempDir, "a.txt"), "a");
    await writeFile(join(tempDir, "b.txt"), "b");
    await git.addPaths(["a.txt"]);

    const staged = execGit(["diff", "--cached", "--name-only"]);
    expect(staged).toContain("a.txt");
    expect(staged).not.toContain("b.txt");
  });

  it("setIdentity configures git user", async () => {
    await git.setIdentity("Bot", "bot@example.com");
    const name = execGit(["config", "user.name"]);
    const email = execGit(["config", "user.email"]);
    expect(name).toBe("Bot");
    expect(email).toBe("bot@example.com");
  });

  it("diff returns staged and unstaged changes", async () => {
    await writeFile(join(tempDir, "README.md"), "# Changed");
    const d = await git.diff();
    expect(d).toContain("Changed");
  });

  it("checkoutExisting checks out a remote branch", async () => {
    // Create a remote pointing to self and a branch
    execGit(["remote", "add", "origin", tempDir]);
    execGit(["checkout", "-b", "feature/test"]);
    await writeFile(join(tempDir, "feature.txt"), "feature");
    execGit(["add", "."]);
    execGit(["commit", "-m", "Feature commit"]);
    execGit(["checkout", "master"]);

    await git.checkoutExisting("feature/test");
    const branch = execGit(["branch", "--show-current"]);
    expect(branch).toBe("feature/test");
  });

  it("push pushes branch to origin", async () => {
    // Create a bare remote to push to
    const bareDir = join(tempDir, "bare-remote.git");
    await mkdir(bareDir, { recursive: true });
    execGit(["init", "--bare"], bareDir);
    execGit(["remote", "add", "origin", bareDir]);

    // Push initial commit first so remote has master
    execGit(["push", "-u", "origin", "master"]);

    // Now create a new commit and push via WorkspaceGit
    await writeFile(join(tempDir, "push-test.txt"), "push");
    await git.addAll();
    await git.commit("Push test");
    await git.push("master");

    // Verify the push worked by checking remote log
    const log = execGit(["log", "--oneline", "master"], bareDir);
    expect(log).toContain("Push test");
  });

  it("resetToBase resets and checks out base branch", async () => {
    execGit(["remote", "add", "origin", tempDir]);
    execGit(["fetch", "origin"]);
    execGit(["checkout", "-b", "feature/dirty"]);
    await writeFile(join(tempDir, "dirty.txt"), "dirty");

    await git.resetToBase("master");
    const branch = execGit(["branch", "--show-current"]);
    expect(branch).toBe("master");
    expect(await git.isClean()).toBe(true);
  });

  it("changedFiles lists files changed vs base", async () => {
    execGit(["remote", "add", "origin", tempDir]);
    execGit(["fetch", "origin"]);
    execGit(["checkout", "-b", "feature/changes"]);
    await writeFile(join(tempDir, "changed.txt"), "new");
    await git.addAll();
    await git.commit("Add changed file");

    const files = await git.changedFiles("master");
    expect(files).toContain("changed.txt");
  });

  it("commitCount returns number of commits ahead of base", async () => {
    execGit(["remote", "add", "origin", tempDir]);
    execGit(["fetch", "origin"]);
    execGit(["checkout", "-b", "feature/count"]);
    await writeFile(join(tempDir, "one.txt"), "1");
    await git.addAll();
    await git.commit("First");
    await writeFile(join(tempDir, "two.txt"), "2");
    await git.addAll();
    await git.commit("Second");

    const count = await git.commitCount("master");
    expect(count).toBe(2);
  });

  it("commitCount counts only commits ahead of base, not the base's independent advances", async () => {
    // Regression: the pr-review review-cycle cap (maxReviewAttempts) reads
    // commitCount(baseBranch) as the "attempts so far" proxy. A three-dot
    // `origin/base...HEAD` rev-list counts the SYMMETRIC difference, so every
    // commit that lands on the base branch AFTER the feature branch diverged
    // is wrongly tallied as a review attempt. A 2.5-month-old PR with a single
    // real commit read 66/20 and was falsely failed (PR #898). The count
    // must be ahead-of-base only (`origin/base..HEAD`).
    //
    // The bare remote lives OUTSIDE the working tree so `git add` never
    // touches it (a nested repo inside tempDir corrupts the index).
    const bareDir = await mkdtemp(join(tmpdir(), "git-ops-bare-"));
    try {
      execGit(["init", "--bare"], bareDir);
      execGit(["remote", "add", "origin", bareDir]);
      execGit(["push", "-u", "origin", "master"]);

      // Feature branch with exactly ONE commit of its own.
      execGit(["checkout", "-b", "feature/count-drift"]);
      await writeFile(join(tempDir, "feature.txt"), "feature");
      execGit(["add", "feature.txt"]);
      execGit(["commit", "-m", "Feature commit"]);

      // Base branch advances independently by two commits (other merged PRs).
      execGit(["checkout", "master"]);
      await writeFile(join(tempDir, "base-1.txt"), "1");
      execGit(["add", "base-1.txt"]);
      execGit(["commit", "-m", "Base advance 1"]);
      await writeFile(join(tempDir, "base-2.txt"), "2");
      execGit(["add", "base-2.txt"]);
      execGit(["commit", "-m", "Base advance 2"]);
      execGit(["push", "origin", "master"]);

      // Refresh origin/master ref, return to the feature branch.
      execGit(["fetch", "origin", "--quiet"]);
      execGit(["checkout", "feature/count-drift"]);

      // Only the single feature commit counts — NOT the two base advances.
      // Three-dot symmetric difference would have returned 3.
      expect(await git.commitCount("master")).toBe(1);
    } finally {
      await rm(bareDir, { recursive: true, force: true });
    }
  });

  it("hasStagedChanges returns true when there are staged changes", async () => {
    await writeFile(join(tempDir, "staged.txt"), "data");
    await git.addAll();
    expect(await git.hasStagedChanges()).toBe(true);
  });

  it("hasStagedChanges returns false when no staged changes", async () => {
    expect(await git.hasStagedChanges()).toBe(false);
  });

  it("remoteBranchExists returns true when branch exists on remote", async () => {
    const bareDir = join(tempDir, "bare-remote.git");
    await mkdir(bareDir, { recursive: true });
    execGit(["init", "--bare"], bareDir);
    execGit(["remote", "add", "origin", bareDir]);
    execGit(["push", "-u", "origin", "master"]);

    expect(await git.remoteBranchExists("master")).toBe(true);
  });

  it("remoteBranchExists returns false when branch does not exist", async () => {
    const bareDir = join(tempDir, "bare-remote.git");
    await mkdir(bareDir, { recursive: true });
    execGit(["init", "--bare"], bareDir);
    execGit(["remote", "add", "origin", bareDir]);
    execGit(["push", "-u", "origin", "master"]);

    expect(await git.remoteBranchExists("nonexistent-branch")).toBe(false);
  });

  it("exec throws on invalid git command", async () => {
    await expect(git.commit("fail without staged")).rejects.toThrow("git commit failed");
  });
});
