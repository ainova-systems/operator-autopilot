import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, mkdir, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OperationContext } from "@operator/core";
import { discoverProjectExtensions, GLOBAL_CONTEXT_ORDER } from "./discovery.js";
import { ConfigError } from "@operator/core";
import { resolveContentPath } from "../infra/content-path.js";

function makeCtx(): OperationContext {
  return {
    traceId: "test-trace",
    repoId: "test-repo",
    action: "discovery",
    budget: { spentUsd: 0, add: vi.fn(), isExceeded: () => false },
    signal: AbortSignal.timeout(30_000),
  };
}

let workspaceRoot: string;
let automationDir: string;

beforeEach(async () => {
  workspaceRoot = await mkdtemp(join(tmpdir(), "operator-discovery-test-"));
  automationDir = join(workspaceRoot, ".operator");
  await mkdir(automationDir, { recursive: true });
});

afterEach(async () => {
  await rm(workspaceRoot, { recursive: true, force: true });
});

const SCOUT_AUTO_DETECT_PREFIX = "auto-detected if not set: ";

function parseScoutDocumentedGlobalContextOrder(scoutMd: string): string[] {
  const line = scoutMd
    .split("\n")
    .find((l) => l.includes(SCOUT_AUTO_DETECT_PREFIX));
  if (!line) {
    throw new Error(`scout.md missing "${SCOUT_AUTO_DETECT_PREFIX}" comment`);
  }
  const suffix = line.split(SCOUT_AUTO_DETECT_PREFIX)[1]?.trim();
  if (!suffix) {
    throw new Error("scout.md auto-detect order comment has no suffix");
  }
  const orderText = suffix.replace(/\)+$/, "").trim();
  return orderText.split(">").map((part) => part.trim());
}

describe("discoverProjectExtensions", () => {
  it("scout.md documents the same global-context order that discovery.ts implements", async () => {
    const scoutPath = resolveContentPath("prompts", "agents/scout.md");
    const scoutMd = await readFile(scoutPath, "utf-8");
    const documentedOrder = parseScoutDocumentedGlobalContextOrder(scoutMd);
    expect(documentedOrder).toEqual([...GLOBAL_CONTEXT_ORDER]);
  });

  it("returns null projectYaml when file does not exist", async () => {
    const result = await discoverProjectExtensions(makeCtx(), workspaceRoot);
    expect(result.projectYaml).toBeNull();
  });

  it("parses project.yaml when it exists", async () => {
    await writeFile(
      join(automationDir, "project.yaml"),
      'scripts:\n  verify: "npm test"\ncontext: AGENTS.md\n',
    );

    const result = await discoverProjectExtensions(makeCtx(), workspaceRoot);
    expect(result.projectYaml).not.toBeNull();
    expect(result.projectYaml?.scripts?.verify).toBe("npm test");
    expect(result.projectYaml?.context).toBe("AGENTS.md");
  });

  it("handles empty project.yaml", async () => {
    await writeFile(join(automationDir, "project.yaml"), "");

    const result = await discoverProjectExtensions(makeCtx(), workspaceRoot);
    expect(result.projectYaml).not.toBeNull();
    expect(result.projectYaml?.scripts).toBeUndefined();
  });

  it("sets correct convention paths", async () => {
    const result = await discoverProjectExtensions(makeCtx(), workspaceRoot);
    expect(result.automationDir).toContain(".operator");
    expect(result.findingsDir).toContain("findings");
    expect(result.tasksDir).toContain("tasks");
    expect(result.retrospectivesDir).toContain("retrospectives");
  });

  describe("global context detection", () => {
    it("detects AGENTS.md first", async () => {
      await writeFile(join(workspaceRoot, "AGENTS.md"), "# Agents");
      await writeFile(join(workspaceRoot, "CLAUDE.md"), "# Claude");

      const result = await discoverProjectExtensions(makeCtx(), workspaceRoot);
      expect(result.globalContextFile).toContain("AGENTS.md");
    });

    it("falls back to CLAUDE.md", async () => {
      await writeFile(join(workspaceRoot, "CLAUDE.md"), "# Claude");

      const result = await discoverProjectExtensions(makeCtx(), workspaceRoot);
      expect(result.globalContextFile).toContain("CLAUDE.md");
    });

    it("falls back to .cursorrules", async () => {
      await writeFile(join(workspaceRoot, ".cursorrules"), "rules");

      const result = await discoverProjectExtensions(makeCtx(), workspaceRoot);
      expect(result.globalContextFile).toContain(".cursorrules");
    });

    it("falls back to .operator/OPERATOR.md", async () => {
      await writeFile(join(automationDir, "OPERATOR.md"), "# Operator");

      const result = await discoverProjectExtensions(makeCtx(), workspaceRoot);
      expect(result.globalContextFile).toContain("OPERATOR.md");
    });

    it("returns null when no context file exists", async () => {
      const result = await discoverProjectExtensions(makeCtx(), workspaceRoot);
      expect(result.globalContextFile).toBeNull();
    });

    it("uses explicit context from project.yaml", async () => {
      await writeFile(
        join(automationDir, "project.yaml"),
        "context: docs/CONTEXT.md\n",
      );
      await mkdir(join(workspaceRoot, "docs"), { recursive: true });
      await writeFile(join(workspaceRoot, "docs", "CONTEXT.md"), "# Custom");

      const result = await discoverProjectExtensions(makeCtx(), workspaceRoot);
      expect(result.globalContextFile).toContain("CONTEXT.md");
    });

    it("falls back to auto-detect if explicit context file does not exist", async () => {
      await writeFile(
        join(automationDir, "project.yaml"),
        "context: nonexistent.md\n",
      );
      await writeFile(join(workspaceRoot, "CLAUDE.md"), "# Claude");

      const result = await discoverProjectExtensions(makeCtx(), workspaceRoot);
      expect(result.globalContextFile).toContain("CLAUDE.md");
    });
  });

  it("includes scripts from project.yaml", async () => {
    await writeFile(
      join(automationDir, "project.yaml"),
      "scripts:\n  init: npm ci\n  verify: npm test\n",
    );

    const result = await discoverProjectExtensions(makeCtx(), workspaceRoot);
    expect(result.projectYaml?.scripts?.init).toBe("npm ci");
    expect(result.projectYaml?.scripts?.verify).toBe("npm test");
  });

  it("throws ConfigError for invalid YAML in project.yaml", async () => {
    await writeFile(
      join(automationDir, "project.yaml"),
      "invalid: [yaml: }}}",
    );

    await expect(discoverProjectExtensions(makeCtx(), workspaceRoot)).rejects.toThrow(ConfigError);
  });

  it("throws ConfigError for invalid schema in project.yaml", async () => {
    // scripts.verify must be string, not number — schema validation failure
    await writeFile(
      join(automationDir, "project.yaml"),
      "scripts:\n  verify: 123\n",
    );

    await expect(discoverProjectExtensions(makeCtx(), workspaceRoot)).rejects.toThrow(ConfigError);
  });
});
