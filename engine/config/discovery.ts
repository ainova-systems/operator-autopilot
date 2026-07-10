import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { constants } from "node:fs";
import * as yaml from "js-yaml";
import { ZodError } from "zod";
import type { OperationContext } from "@operator/core";
import { ConfigError } from "@operator/core";
import { projectYamlSchema, type ProjectYaml } from "./schemas.js";

/** Result of scanning a project's `.operator/` directory. */
export interface ProjectExtensions {
  /** Parsed project.yaml, or null if file doesn't exist. */
  readonly projectYaml: ProjectYaml | null;
  /** Absolute path to the detected global context file, or null. */
  readonly globalContextFile: string | null;
  /** Absolute path to the .operator/ directory. */
  readonly automationDir: string;
  /** Absolute path to the data/findings/ directory. */
  readonly findingsDir: string;
  /** Absolute path to the data/tasks/ directory. */
  readonly tasksDir: string;
  /** Absolute path to the data/retrospectives/ directory. */
  readonly retrospectivesDir: string;
}

/**
 * Check if a file exists.
 */
async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/** Auto-detect priority for global context files (single source of truth). */
export const GLOBAL_CONTEXT_ORDER = [
  "AGENTS.md",
  "CLAUDE.md",
  ".cursorrules",
  ".operator/OPERATOR.md",
] as const;

function resolveGlobalContextCandidate(
  name: (typeof GLOBAL_CONTEXT_ORDER)[number],
  workspaceRoot: string,
  automationDir: string,
): string {
  if (name === ".operator/OPERATOR.md") {
    return resolve(automationDir, "OPERATOR.md");
  }
  return resolve(workspaceRoot, name);
}

/**
 * Detect the global context file for a project workspace.
 *
 * Ports `detect_global_context()` from `load-config.sh`:
 * 1. Explicit context from project.yaml
 * 2. {@link GLOBAL_CONTEXT_ORDER} in order
 */
async function detectGlobalContext(
  workspaceRoot: string,
  automationDir: string,
  contextSource: string | undefined,
): Promise<string | null> {
  // Explicit context from project.yaml
  if (contextSource) {
    const explicit = resolve(workspaceRoot, contextSource);
    if (await fileExists(explicit)) return explicit;
  }

  const candidates = GLOBAL_CONTEXT_ORDER.map((name) =>
    resolveGlobalContextCandidate(name, workspaceRoot, automationDir),
  );

  for (const candidate of candidates) {
    if (await fileExists(candidate)) return candidate;
  }

  return null;
}

/**
 * Load and validate `.operator/project.yaml` if it exists.
 */
async function loadProjectYaml(automationDir: string): Promise<ProjectYaml | null> {
  const projectYamlPath = resolve(automationDir, "project.yaml");

  if (!(await fileExists(projectYamlPath))) {
    return null;
  }

  let content: string;
  try {
    content = await readFile(projectYamlPath, "utf-8");
  } catch (err) {
    throw new ConfigError(
      "CONFIG_PROJECT_READ",
      `Failed to read ${projectYamlPath}: ${(err as Error).message}`,
      { cause: err as Error },
    );
  }

  let raw: unknown;
  try {
    raw = yaml.load(content);
  } catch (err) {
    throw new ConfigError(
      "CONFIG_PROJECT_PARSE",
      `Failed to parse YAML in ${projectYamlPath}: ${(err as Error).message}`,
      { cause: err as Error },
    );
  }

  // Empty file → treat as empty config
  if (raw === null || raw === undefined) {
    return projectYamlSchema.parse({});
  }

  try {
    return projectYamlSchema.parse(raw);
  } catch (err) {
    if (err instanceof ZodError) {
      const issues = err.issues.map(
        (i) => `  ${i.path.join(".")}: ${i.message}`,
      ).join("\n");
      throw new ConfigError(
        "CONFIG_PROJECT_VALIDATION",
        `Validation failed for ${projectYamlPath}:\n${issues}`,
        { cause: err },
      );
    }
    throw err;
  }
}

/**
 * Discover project extensions from a workspace's `.operator/` directory.
 *
 * Ports convention paths and context detection from `load-config.sh`.
 *
 * @param ctx — operation context for tracing and cancellation
 * @param workspaceRoot — absolute path to the cloned workspace
 */
export async function discoverProjectExtensions(
  ctx: OperationContext,
  workspaceRoot: string,
): Promise<ProjectExtensions> {
  const automationDir = resolve(workspaceRoot, ".operator");
  const projectYaml = await loadProjectYaml(automationDir);

  const globalContextFile = await detectGlobalContext(
    workspaceRoot,
    automationDir,
    projectYaml?.context ?? undefined,
  );

  return {
    projectYaml,
    globalContextFile,
    automationDir,
    findingsDir: resolve(automationDir, "data", "findings"),
    tasksDir: resolve(automationDir, "data", "tasks"),
    retrospectivesDir: resolve(automationDir, "data", "retrospectives"),
  };
}
