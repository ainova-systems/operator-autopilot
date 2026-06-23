import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFile, access, mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { resolveContentPath } from "./content-path.js";

describe("resolveContentPath", () => {
  const savedEnv = process.env["OPERATOR_CONTENT_DIR"];

  beforeEach(() => {
    delete process.env["OPERATOR_CONTENT_DIR"];
  });

  afterEach(() => {
    if (savedEnv === undefined) delete process.env["OPERATOR_CONTENT_DIR"];
    else process.env["OPERATOR_CONTENT_DIR"] = savedEnv;
  });

  it("resolves category root in dev mode", async () => {
    const promptsRoot = resolveContentPath("prompts");
    // Dev mode points at the source tree; the directory must exist because
    // Step 3 of the migration created it with real content.
    await expect(access(promptsRoot)).resolves.toBeUndefined();
  });

  it("resolves shipped defaults files", async () => {
    const defaultsYaml = resolveContentPath("defaults", "defaults.yaml");
    await expect(access(defaultsYaml)).resolves.toBeUndefined();

    const body = await readFile(defaultsYaml, "utf-8");
    expect(body).toContain("schedules");
    expect(body).toContain("conventions");
  });

  it("resolves shipped agents.yaml", async () => {
    const agentsYaml = resolveContentPath("defaults", "agents.yaml");
    await expect(access(agentsYaml)).resolves.toBeUndefined();

    const body = await readFile(agentsYaml, "utf-8");
    expect(body).toContain("providers");
    expect(body).toContain("agents:");
  });

  it("resolves shipped stages.yaml", async () => {
    const stagesYaml = resolveContentPath("prompts", "stages.yaml");
    await expect(access(stagesYaml)).resolves.toBeUndefined();

    const body = await readFile(stagesYaml, "utf-8");
    expect(body).toContain("stages:");
    expect(body).toContain("task-execute");
  });

  it("resolves shipped kinds.yaml", async () => {
    const kindsYaml = resolveContentPath("prompts", "kinds.yaml");
    await expect(access(kindsYaml)).resolves.toBeUndefined();

    const body = await readFile(kindsYaml, "utf-8");
    expect(body).toContain("kinds:");
    expect(body).toContain("finding:");
  });

  it("resolves a role prompt under agents/", async () => {
    const creatorMd = resolveContentPath("prompts", "agents/creator.md");
    await expect(access(creatorMd)).resolves.toBeUndefined();
  });

  it("ships the PR-ownership boundary in the base agent context", async () => {
    // Regression: an agent shelled out to `gh pr edit` and overwrote the
    // orchestrator-authored PR description (2026-06-19). The shared base
    // context must forbid agents from mutating the pull request.
    const baseMd = resolveContentPath("prompts", "agents/context/base.md");
    const body = await readFile(baseMd, "utf-8");
    expect(body).toContain("Orchestrator Owns the Pull Request");
    expect(body).toContain("gh pr edit");
  });

  it("ships the Step-0 task-actuality gate in the creator prompt", async () => {
    // Regression: a "create doc page" task created 2026-05-11 re-executed on
    // 2026-06-23 after the deliverable was already authored and approved. The
    // creator executed the stale task verbatim — re-creating an existing page
    // and downgrading its approved state. The creator prompt must require an
    // actuality check before any change, and forbid fabricating/reverting work
    // to satisfy a stale task.
    const creatorMd = resolveContentPath("prompts", "agents/creator.md");
    const body = await readFile(creatorMd, "utf-8");
    expect(body).toContain("Validate Task Actuality");
    expect(body).toContain("Premise invalid");
    expect(body).toContain("An empty diff with a clear explanation is the correct");
  });

  it("ships the task-actuality verdict criteria in the task verifier prompt", async () => {
    // Regression companion to the creator Step-0 gate: the verifier owns the
    // final verdict, so the task review criteria must direct CANCELLED when the
    // deliverable already exists / the premise is false, treat an empty diff as
    // correct in that case (not RETRY/FAILED), and flag a diff that reverts or
    // downgrades existing base-branch state as a regression.
    const verifierTaskMd = resolveContentPath("prompts", "agents/verifier/task.md");
    const body = await readFile(verifierTaskMd, "utf-8");
    expect(body).toContain("Task still actual");
    expect(body).toContain("An EMPTY diff is the CORRECT outcome here");
    expect(body).toContain("REVERTS/DOWNGRADES state that exists on the base branch");
  });

  it("resolves a template file", async () => {
    const taskPrBody = resolveContentPath("templates", "task-pr-body.md");
    await expect(access(taskPrBody)).resolves.toBeUndefined();
  });

  it("resolves a format file", async () => {
    const findingFormat = resolveContentPath("templates", "formats/finding.txt");
    await expect(access(findingFormat)).resolves.toBeUndefined();
  });

  it("honors OPERATOR_CONTENT_DIR override", async () => {
    const override = await mkdtemp(join(tmpdir(), "content-override-"));
    try {
      await mkdir(join(override, "prompts"), { recursive: true });
      await writeFile(join(override, "prompts", "x.md"), "override content");
      process.env["OPERATOR_CONTENT_DIR"] = override;
      const resolved = resolveContentPath("prompts", "x.md");
      expect(resolved).toBe(resolve(override, "prompts", "x.md"));
      expect(await readFile(resolved, "utf-8")).toBe("override content");
    } finally {
      await rm(override, { recursive: true, force: true });
    }
  });

  it("returns category root when subpath omitted", () => {
    const promptsRoot = resolveContentPath("prompts");
    const defaultsRoot = resolveContentPath("defaults");
    expect(promptsRoot).not.toBe(defaultsRoot);
    expect(promptsRoot.endsWith("prompts")).toBe(true);
    expect(defaultsRoot.endsWith("defaults")).toBe(true);
  });
});
