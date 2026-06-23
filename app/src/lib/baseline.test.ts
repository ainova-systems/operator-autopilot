import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BaselineNotFoundError,
  BaselineUnsupportedError,
  listBaselineKeys,
  loadBaselineValue,
} from "./baseline";

let savedContentDir: string | undefined;
let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "baseline-"));
  savedContentDir = process.env["OPERATOR_CONTENT_DIR"];
  process.env["OPERATOR_CONTENT_DIR"] = tmpRoot;
});

afterEach(() => {
  if (savedContentDir === undefined) delete process.env["OPERATOR_CONTENT_DIR"];
  else process.env["OPERATOR_CONTENT_DIR"] = savedContentDir;
  rmSync(tmpRoot, { recursive: true, force: true });
});

function touch(path: string, content: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
}

describe("loadBaselineValue", () => {
  it("loads a prompts baseline from engine/content/prompts/agents/{key}.md", async () => {
    touch(join(tmpRoot, "prompts", "agents", "creator.md"), "SHIPPED CREATOR");
    const value = await loadBaselineValue("prompts", "creator") as { topic: string; body: string };
    expect(value.topic).toBe("creator");
    expect(value.body).toBe("SHIPPED CREATOR");
  });

  it("loads a reviewer-criteria baseline under prompts/agents/reviewer/", async () => {
    touch(join(tmpRoot, "prompts", "agents", "reviewer", "init.md"), "REVIEWER INIT");
    const value = await loadBaselineValue("reviewer-criteria", "init") as { stageName: string; body: string };
    expect(value.stageName).toBe("init");
    expect(value.body).toBe("REVIEWER INIT");
  });

  it("loads a template baseline with path-as-key", async () => {
    touch(join(tmpRoot, "templates", "formats", "task.txt"), "Language: {LANGUAGE}");
    const value = await loadBaselineValue("templates", "formats/task.txt") as { name: string; body: string };
    expect(value.name).toBe("formats/task.txt");
    expect(value.body).toContain("Language:");
  });

  it("loads an agent-role from defaults/agents.yaml", async () => {
    touch(
      join(tmpRoot, "defaults", "agents.yaml"),
      `agents:\n  creator:\n    provider: claude\n    instructions: agents/creator.md\n    timeout: 3600\n`,
    );
    const value = await loadBaselineValue("agent-roles", "creator") as Record<string, unknown>;
    expect(value.name).toBe("creator");
    expect(value.provider).toBe("claude");
  });

  it("loads an agent-provider + synthetic _default from defaults/agents.yaml", async () => {
    touch(
      join(tmpRoot, "defaults", "agents.yaml"),
      `defaultProvider: claude\nproviders:\n  claude:\n    command: claude\n`,
    );
    const value = await loadBaselineValue("agent-providers", "claude") as Record<string, unknown>;
    expect(value.id).toBe("claude");
    expect(value.command).toBe("claude");

    const def = await loadBaselineValue("agent-providers", "_default") as Record<string, unknown>;
    expect(def.id).toBe("claude");
  });

  it("loads engine-defaults/global from defaults.yaml", async () => {
    touch(join(tmpRoot, "defaults", "defaults.yaml"), `limits:\n  maxReviewAttempts: 10\n`);
    const value = await loadBaselineValue("engine-defaults", "global") as Record<string, unknown>;
    expect((value as { limits: { maxReviewAttempts: number } }).limits.maxReviewAttempts).toBe(10);
  });

  it("loads a workflow-stage from stages.yaml", async () => {
    touch(join(tmpRoot, "prompts", "stages.yaml"), `stages:\n  - name: init\n    selector: bootstrap\n`);
    const value = await loadBaselineValue("workflow-stages", "init") as Record<string, unknown>;
    expect(value.name).toBe("init");
    expect(value.selector).toBe("bootstrap");
  });

  it("loads a work-item-kind from kinds.yaml", async () => {
    touch(join(tmpRoot, "prompts", "kinds.yaml"), `kinds:\n  finding:\n    label: Finding\n    idPrefix: F\n`);
    const value = await loadBaselineValue("work-item-kinds", "finding") as Record<string, unknown>;
    expect(value.name).toBe("finding");
  });

  it("loads an analyzer baseline", async () => {
    touch(join(tmpRoot, "prompts", "analyzers", "quality.md"), "# Quality analyzer");
    const value = await loadBaselineValue("analyzers", "quality") as Record<string, unknown>;
    expect(value.id).toBe("quality");
    expect(value.body).toContain("Quality");
  });

  it("throws BaselineNotFoundError for a missing role", async () => {
    touch(join(tmpRoot, "defaults", "agents.yaml"), `agents:\n  creator: { provider: claude, instructions: a, timeout: 1 }\n`);
    await expect(loadBaselineValue("agent-roles", "missing")).rejects.toBeInstanceOf(BaselineNotFoundError);
  });

  it("throws BaselineNotFoundError for a missing workflow stage", async () => {
    touch(join(tmpRoot, "prompts", "stages.yaml"), `stages: []\n`);
    await expect(loadBaselineValue("workflow-stages", "init")).rejects.toBeInstanceOf(BaselineNotFoundError);
  });

  it("throws BaselineNotFoundError for reviewer prompts routed under prompts category", async () => {
    await expect(loadBaselineValue("prompts", "reviewer/init")).rejects.toBeInstanceOf(BaselineNotFoundError);
  });

  it("throws BaselineUnsupportedError for repos and other non-content categories", async () => {
    await expect(loadBaselineValue("repos", "sample")).rejects.toBeInstanceOf(BaselineUnsupportedError);
    await expect(loadBaselineValue("work-items", "x")).rejects.toBeInstanceOf(BaselineUnsupportedError);
  });

  it("throws BaselineNotFoundError for a non-global engine-defaults key", async () => {
    await expect(loadBaselineValue("engine-defaults", "custom")).rejects.toBeInstanceOf(BaselineNotFoundError);
  });

  it("throws BaselineNotFoundError for _default when defaultProvider is missing", async () => {
    touch(join(tmpRoot, "defaults", "agents.yaml"), `providers:\n  claude:\n    command: claude\n`);
    await expect(loadBaselineValue("agent-providers", "_default")).rejects.toBeInstanceOf(BaselineNotFoundError);
  });

  it("throws BaselineNotFoundError for a missing kind", async () => {
    touch(join(tmpRoot, "prompts", "kinds.yaml"), `kinds: {}\n`);
    await expect(loadBaselineValue("work-item-kinds", "unknown")).rejects.toBeInstanceOf(BaselineNotFoundError);
  });

  it("throws BaselineNotFoundError for a missing provider", async () => {
    touch(join(tmpRoot, "defaults", "agents.yaml"), `providers: {}\n`);
    await expect(loadBaselineValue("agent-providers", "claude")).rejects.toBeInstanceOf(BaselineNotFoundError);
  });
});

describe("listBaselineKeys", () => {
  it("enumerates prompts keys recursively, excluding reviewer/*", async () => {
    touch(join(tmpRoot, "prompts", "agents", "creator.md"), "x");
    touch(join(tmpRoot, "prompts", "agents", "context", "base.md"), "x");
    touch(join(tmpRoot, "prompts", "agents", "reviewer", "init.md"), "x");
    const keys = await listBaselineKeys("prompts");
    expect(keys).toContain("creator");
    expect(keys).toContain("context/base");
    expect(keys).not.toContain("reviewer/init");
  });

  it("enumerates reviewer-criteria keys", async () => {
    touch(join(tmpRoot, "prompts", "agents", "reviewer", "init.md"), "x");
    const keys = await listBaselineKeys("reviewer-criteria");
    expect(keys).toEqual(["init"]);
  });

  it("enumerates templates with extensions", async () => {
    touch(join(tmpRoot, "templates", "init-pr-body.md"), "x");
    touch(join(tmpRoot, "templates", "formats", "task.txt"), "x");
    const keys = await listBaselineKeys("templates");
    expect(keys).toContain("init-pr-body.md");
    expect(keys).toContain("formats/task.txt");
  });

  it("enumerates analyzer baselines", async () => {
    touch(join(tmpRoot, "prompts", "analyzers", "quality.md"), "x");
    const keys = await listBaselineKeys("analyzers");
    expect(keys).toEqual(["quality"]);
  });

  it("returns empty for non-file-backed categories", async () => {
    expect(await listBaselineKeys("workflow-stages")).toEqual([]);
    expect(await listBaselineKeys("repos")).toEqual([]);
  });
});
