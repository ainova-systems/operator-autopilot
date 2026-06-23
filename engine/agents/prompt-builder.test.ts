import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { PromptSource } from "@operator/core";
import {
  pathToSample,
  matchesPath,
  pathsOverlap,
  listMdFiles,
  discoverMatchingRules,
  mergeRuleBodies,
  substituteVars,
  buildSystemPrompt,
  buildUserPrompt,
} from "./prompt-builder.js";

/**
 * In-memory stub {@link PromptSource} for tests. Exposes a setter so each
 * test can wire up only the topics it cares about — no filesystem needed.
 */
class TestPromptSource implements PromptSource {
  private readonly topics = new Map<string, string>();

  set(topic: string, content: string): this {
    this.topics.set(topic, content);
    return this;
  }

  async loadChain(topic: string): Promise<string> {
    return this.topics.get(topic) ?? "";
  }
}

// ── Path matching ───────────────────────────────────────────────────────

describe("pathToSample", () => {
  it("returns * for empty or wildcard", () => {
    expect(pathToSample("")).toBe("*");
    expect(pathToSample("*")).toBe("*");
  });

  it("strips trailing glob and adds _sample_", () => {
    expect(pathToSample("Source/Backend/**")).toBe("Source/Backend/_sample_");
    expect(pathToSample("Source/Frontend/*")).toBe("Source/Frontend/_sample_");
    expect(pathToSample("docs/**")).toBe("docs/_sample_");
  });
});

describe("matchesPath", () => {
  it("wildcard matches everything", () => {
    expect(matchesPath("*", "anything")).toBe(true);
    expect(matchesPath("", "anything")).toBe(true);
  });

  it("matches when target starts with pattern base", () => {
    expect(matchesPath("Source/Backend/**", "Source/Backend/_sample_")).toBe(true);
    expect(matchesPath("Source/Backend/**", "Source/Backend/src/App.cs")).toBe(true);
  });

  it("rejects non-overlapping paths", () => {
    expect(matchesPath("Source/Backend/**", "Source/Frontend/_sample_")).toBe(false);
  });
});

describe("pathsOverlap", () => {
  it("returns true for wildcards", () => {
    expect(pathsOverlap("*", "Source/Backend/**")).toBe(true);
    expect(pathsOverlap("Source/Backend/**", "")).toBe(true);
  });

  it("returns true for overlapping paths", () => {
    expect(pathsOverlap("Source/Backend/**", "Source/Backend/**")).toBe(true);
    expect(pathsOverlap("Source/**", "Source/Backend/**")).toBe(true);
  });

  it("returns false for non-overlapping paths", () => {
    expect(pathsOverlap("Source/Backend/**", "Source/Frontend/**")).toBe(false);
  });
});

// ── File discovery ──────────────────────────────────────────────────────

describe("listMdFiles", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "prompt-test-"));
  });
  afterEach(async () => {
    await rm(tmpDir, { recursive: true });
  });

  it("returns .md files sorted by name", async () => {
    await writeFile(join(tmpDir, "beta.md"), "b");
    await writeFile(join(tmpDir, "alpha.md"), "a");
    await writeFile(join(tmpDir, "skip.txt"), "not md");
    const files = await listMdFiles(tmpDir);
    expect(files).toHaveLength(2);
    expect(files[0]).toContain("alpha.md");
    expect(files[1]).toContain("beta.md");
  });

  it("returns empty array for missing directory", async () => {
    expect(await listMdFiles(join(tmpDir, "nonexistent"))).toEqual([]);
  });
});

// ── Rule discovery ──────────────────────────────────────────────────────

describe("discoverMatchingRules", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "rules-test-"));
    await mkdir(join(tmpDir, "verifier"), { recursive: true });
  });
  afterEach(async () => {
    await rm(tmpDir, { recursive: true });
  });

  it("discovers matching rules", async () => {
    await writeFile(join(tmpDir, "verifier", "backend.md"),
      "---\npath: Source/Backend/**\nenabled: true\n---\nBackend rules");
    await writeFile(join(tmpDir, "verifier", "frontend.md"),
      "---\npath: Source/Frontend/**\n---\nFrontend rules");

    const rules = await discoverMatchingRules(tmpDir, "verifier", "Source/Backend/**");
    expect(rules).toHaveLength(1);
    expect(rules[0]).toContain("backend.md");
  });

  it("excludes disabled rules", async () => {
    await writeFile(join(tmpDir, "verifier", "disabled.md"),
      "---\npath: *\nenabled: false\n---\nShould not match");

    const rules = await discoverMatchingRules(tmpDir, "verifier");
    expect(rules).toHaveLength(0);
  });

  it("includes rules with no path (default *)", async () => {
    await writeFile(join(tmpDir, "verifier", "general.md"),
      "---\nenabled: true\n---\nGeneral rules");

    const rules = await discoverMatchingRules(tmpDir, "verifier", "anything/**");
    expect(rules).toHaveLength(1);
  });

  it("returns empty for missing phase directory", async () => {
    const rules = await discoverMatchingRules(tmpDir, "nonexistent");
    expect(rules).toHaveLength(0);
  });
});

describe("mergeRuleBodies", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "merge-test-"));
  });
  afterEach(async () => {
    await rm(tmpDir, { recursive: true });
  });

  it("merges rule bodies with headings", async () => {
    const f1 = join(tmpDir, "api-style.md");
    const f2 = join(tmpDir, "naming.md");
    await writeFile(f1, "---\ntitle: API\n---\nUse REST conventions");
    await writeFile(f2, "---\ntitle: Naming\n---\nUse camelCase");

    const merged = await mergeRuleBodies([f1, f2]);
    expect(merged).toContain("## Rules: api-style");
    expect(merged).toContain("Use REST conventions");
    expect(merged).toContain("## Rules: naming");
    expect(merged).toContain("Use camelCase");
    expect(merged).toContain("---");
  });

  it("skips files with empty body", async () => {
    const f1 = join(tmpDir, "empty.md");
    await writeFile(f1, "---\ntitle: Empty\n---\n");

    const merged = await mergeRuleBodies([f1]);
    expect(merged).toBe("");
  });
});

// ── Variable substitution ───────────────────────────────────────────────

describe("substituteVars", () => {
  it("replaces {KEY} with values", () => {
    const result = substituteVars("Hello {NAME}, project: {PROJECT}", {
      NAME: "Operator",
      PROJECT: "SAMPLE",
    });
    expect(result).toBe("Hello Operator, project: SAMPLE");
  });

  it("replaces multiple occurrences", () => {
    const result = substituteVars("{X} and {X}", { X: "value" });
    expect(result).toBe("value and value");
  });

  it("leaves unmatched placeholders unchanged", () => {
    const result = substituteVars("Hello {MISSING}", {});
    expect(result).toBe("Hello {MISSING}");
  });

  it("handles empty vars", () => {
    const result = substituteVars("No vars here", {});
    expect(result).toBe("No vars here");
  });
});

// ── buildSystemPrompt ───────────────────────────────────────────────────

describe("buildSystemPrompt", () => {
  let tmpDir: string;
  let automationDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "sys-prompt-"));
    automationDir = join(tmpDir, ".operator");
    await mkdir(join(automationDir, "context"), { recursive: true });
  });
  afterEach(async () => {
    await rm(tmpDir, { recursive: true });
  });

  it("assembles prompt from all sources", async () => {
    // Layer 1: global context (direct file read)
    const globalFile = join(tmpDir, "CLAUDE.md");
    await writeFile(globalFile, "# Global Rules\nBe helpful.");

    // Layers 2 and 6: PromptSource-backed (topic lookup)
    const promptSource = new TestPromptSource()
      .set("context/base", "You are {PROJECT_NAME} operator.")
      .set("creator", "Create code carefully.");

    // Layer 3: project context discovery (file-backed)
    await writeFile(join(automationDir, "context", "project-info.md"),
      "---\npath: *\n---\nProject uses TypeScript.");

    const prompt = await buildSystemPrompt({
      promptSource,
      globalContextFile: globalFile,
      automationDir,
      contextFiles: ["base"],
      instructionsTopic: "creator",
      vars: { PROJECT_NAME: "SAMPLE" },
    });

    expect(prompt).toContain("# Global Rules");
    expect(prompt).toContain("You are SAMPLE operator.");
    expect(prompt).toContain("Project uses TypeScript.");
    expect(prompt).toContain("Create code carefully.");
  });

  it("filters project context by contextPath", async () => {
    await writeFile(join(automationDir, "context", "backend.md"),
      "---\npath: Source/Backend/**\n---\nBackend context");
    await writeFile(join(automationDir, "context", "frontend.md"),
      "---\npath: Source/Frontend/**\n---\nFrontend context");

    const prompt = await buildSystemPrompt({
      automationDir,
      contextFiles: [],
      contextPath: "Source/Backend/**",
      vars: {},
    });

    expect(prompt).toContain("Backend context");
    expect(prompt).not.toContain("Frontend context");
  });

  it("includes role customizations", async () => {
    await mkdir(join(automationDir, "creator"), { recursive: true });
    await writeFile(join(automationDir, "creator", "style.md"),
      "---\n---\nFollow clean code principles.");

    const prompt = await buildSystemPrompt({
      automationDir,
      contextFiles: [],
      role: "creator",
      vars: {},
    });

    expect(prompt).toContain("Follow clean code principles.");
  });

  it("includes phase rules with path filtering", async () => {
    await mkdir(join(automationDir, "verifier"), { recursive: true });
    await writeFile(join(automationDir, "verifier", "api-rules.md"),
      "---\npath: Source/Backend/**\n---\nCheck REST conventions.");
    await writeFile(join(automationDir, "verifier", "ui-rules.md"),
      "---\npath: Source/Frontend/**\n---\nCheck accessibility.");

    const prompt = await buildSystemPrompt({
      automationDir,
      contextFiles: [],
      rulesFrom: "verifier",
      contextPath: "Source/Backend/**",
      vars: {},
    });

    expect(prompt).toContain("## Rules: api-rules");
    expect(prompt).toContain("Check REST conventions.");
    expect(prompt).not.toContain("Check accessibility.");
  });

  it("loads agent instructions through promptSource topic", async () => {
    const promptSource = new TestPromptSource()
      .set("creator", "Create high-quality code.");

    const prompt = await buildSystemPrompt({
      promptSource,
      automationDir,
      contextFiles: [],
      instructionsTopic: "creator",
      vars: {},
    });

    expect(prompt).toContain("Create high-quality code.");
  });

  it("loads multiple bundled context chunks in order", async () => {
    const promptSource = new TestPromptSource()
      .set("context/base", "BASE LAYER")
      .set("context/state", "STATE LAYER");

    const prompt = await buildSystemPrompt({
      promptSource,
      automationDir,
      contextFiles: ["base", "state"],
      vars: {},
    });

    const baseIdx = prompt.indexOf("BASE LAYER");
    const stateIdx = prompt.indexOf("STATE LAYER");
    expect(baseIdx).toBeGreaterThanOrEqual(0);
    expect(stateIdx).toBeGreaterThan(baseIdx);
  });

  it("skips context chunks when promptSource omitted", async () => {
    const prompt = await buildSystemPrompt({
      automationDir,
      contextFiles: ["base"],
      instructionsTopic: "creator",
      vars: {},
    });

    // No promptSource → nothing loaded from layers 2 and 6
    expect(prompt).toBe("");
  });

  it("skips instructions when promptSource returns empty", async () => {
    const promptSource = new TestPromptSource(); // nothing configured

    const prompt = await buildSystemPrompt({
      promptSource,
      automationDir,
      contextFiles: ["base"],
      instructionsTopic: "creator",
      vars: {},
    });

    expect(prompt).toBe("");
  });

  it("handles missing files gracefully", async () => {
    const prompt = await buildSystemPrompt({
      globalContextFile: join(tmpDir, "nonexistent.md"),
      automationDir: join(tmpDir, "no-operator"),
      contextFiles: [],
      vars: {},
    });

    expect(prompt).toBe("");
  });

  it("substitutes variables across all layers", async () => {
    const promptSource = new TestPromptSource()
      .set("context/base", "Project: {PROJECT_NAME}")
      .set("creator", "Agent for {PROJECT_NAME}");

    const prompt = await buildSystemPrompt({
      promptSource,
      automationDir,
      contextFiles: ["base"],
      instructionsTopic: "creator",
      vars: { PROJECT_NAME: "SAMPLE" },
    });

    // No unsubstituted placeholders remain
    expect(prompt).not.toContain("{PROJECT_NAME}");
    expect(prompt).toContain("Project: SAMPLE");
    expect(prompt).toContain("Agent for SAMPLE");
  });
});

// ── buildUserPrompt ─────────────────────────────────────────────────────

describe("buildUserPrompt", () => {
  it("includes task content", () => {
    const prompt = buildUserPrompt({
      taskContent: "Fix the login bug",
      attempt: 1,
      maxRetries: 3,
      vars: {},
    });

    expect(prompt).toContain("## Task Input");
    expect(prompt).toContain("Fix the login bug");
  });

  it("includes error context on retry", () => {
    const prompt = buildUserPrompt({
      taskContent: "Fix bug",
      attempt: 2,
      maxRetries: 3,
      previousError: "Build failed: missing import",
      vars: {},
    });

    expect(prompt).toContain("Previous Attempt Failed (Attempt 1/3)");
    expect(prompt).toContain("Build failed: missing import");
    expect(prompt).toContain("Please fix the issues above");
  });

  it("does not include error context on first attempt", () => {
    const prompt = buildUserPrompt({
      taskContent: "Task",
      attempt: 1,
      maxRetries: 3,
      previousError: "should not appear",
      vars: {},
    });

    expect(prompt).not.toContain("Previous Attempt");
  });

  it("substitutes variables", () => {
    const prompt = buildUserPrompt({
      taskContent: "Fix {COMPONENT}",
      attempt: 1,
      maxRetries: 3,
      vars: { COMPONENT: "AuthService" },
    });

    expect(prompt).toContain("Fix AuthService");
  });

  it("returns empty string when no task and first attempt", () => {
    const prompt = buildUserPrompt({
      attempt: 1,
      maxRetries: 3,
      vars: {},
    });

    expect(prompt).toBe("");
  });
});
