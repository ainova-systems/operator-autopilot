import { describe, it, expect } from "vitest";
import type { AgentsFile } from "../config/schemas.js";
import {
  ROLE_OUTPUT_FORMATS,
  resolveRole,
  resolveProviderConfig,
  buildRunInput,
  instructionsPathToTopic,
} from "./roles.js";

const MOCK_CONFIG: AgentsFile = {
  version: "3.0",
  defaultProvider: "claude",
  providers: {
    claude: {
      command: "claude",
      defaultArgs: ["--dangerously-skip-permissions"],
      promptArg: "-p",
      modelArg: "--model",
      toolsArg: "--tools",
      maxBudgetArg: "--max-budget-usd",
      systemPromptFileArg: "--append-system-prompt-file",
      outputMode: "stdout" as const,
    },
    cursor: {
      command: "cursor-agent",
      defaultModel: "auto",
      outputMode: "stdout" as const,
    },
  },
  agents: {
    creator: {
      provider: "claude",
      description: "Creates changes",
      instructions: "agents/creator.md",
      timeout: 3600,
      model: "opus",
      review: true,
      tools: "Read,Grep,Glob,Bash,Edit,Write",
      maxBudget: 15.0,
      context: ["base"],
    },
    analyst: {
      provider: "claude",
      instructions: "agents/analyst.md",
      timeout: 1200,
      model: "opus",
      schedule: "daily",
      tools: "Read,Grep,Glob",
      maxBudget: 5.0,
      context: ["base"],
    },
    diagnoser: {
      provider: "claude",
      instructions: "agents/diagnoser.md",
      timeout: 240,
    },
    improver: {
      provider: "cursor",
      instructions: "agents/improver.md",
      timeout: 1200,
    },
  },
};

describe("ROLE_OUTPUT_FORMATS", () => {
  it("maps all 7 roles to format types", () => {
    expect(ROLE_OUTPUT_FORMATS.analyst).toBe("finding");
    expect(ROLE_OUTPUT_FORMATS.planner).toBe("task");
    expect(ROLE_OUTPUT_FORMATS.creator).toBe("comment");
    expect(ROLE_OUTPUT_FORMATS.verifier).toBe("comment");
    expect(ROLE_OUTPUT_FORMATS.improver).toBe("improver");
    expect(ROLE_OUTPUT_FORMATS.diagnoser).toBe("comment");
    expect(ROLE_OUTPUT_FORMATS.scout).toBe("comment");
  });
});

describe("resolveRole", () => {
  it("resolves creator with full config", () => {
    const role = resolveRole(MOCK_CONFIG, "creator");
    expect(role.name).toBe("creator");
    expect(role.provider).toBe("claude");
    expect(role.description).toBe("Creates changes");
    expect(role.instructions).toBe("agents/creator.md");
    expect(role.timeout).toBe(3600);
    expect(role.model).toBe("opus");
    expect(role.review).toBe(true);
    expect(role.tools).toEqual(["Read", "Grep", "Glob", "Bash", "Edit", "Write"]);
    expect(role.maxBudget).toBe(15.0);
    expect(role.context).toEqual(["base"]);
  });

  it("resolves analyst with schedule", () => {
    const role = resolveRole(MOCK_CONFIG, "analyst");
    expect(role.schedule).toBe("daily");
    expect(role.tools).toEqual(["Read", "Grep", "Glob"]);
  });

  it("falls back to the provider defaultModel when the role declares no model", () => {
    const role = resolveRole(MOCK_CONFIG, "improver");
    expect(role.provider).toBe("cursor");
    expect(role.model).toBe("auto");
  });

  it("uses the hard-coded model fallback when neither role nor provider sets one", () => {
    // diagnoser is on claude, which has no defaultModel in this config.
    const role = resolveRole(MOCK_CONFIG, "diagnoser");
    expect(role.model).toBe("sonnet");
  });

  it("fills defaults for optional fields", () => {
    const role = resolveRole(MOCK_CONFIG, "diagnoser");
    expect(role.model).toBe("sonnet");
    expect(role.review).toBe(false);
    expect(role.tools).toEqual([]);
    expect(role.maxBudget).toBe(5.0);
    expect(role.context).toEqual([]);
    expect(role.description).toBe("diagnoser");
  });

  it("throws for unknown role", () => {
    expect(() => resolveRole(MOCK_CONFIG, "nonexistent" as never)).toThrow("Unknown agent role");
  });
});

describe("resolveProviderConfig", () => {
  it("resolves claude provider config", () => {
    const config = resolveProviderConfig(MOCK_CONFIG, "claude");
    expect(config.command).toBe("claude");
    expect(config.defaultArgs).toEqual(["--dangerously-skip-permissions"]);
    expect(config.promptArg).toBe("-p");
    expect(config.modelArg).toBe("--model");
    expect(config.toolsArg).toBe("--tools");
    expect(config.maxBudgetArg).toBe("--max-budget-usd");
    expect(config.systemPromptFileArg).toBe("--append-system-prompt-file");
  });

  it("fills defaults for minimal provider", () => {
    const config = resolveProviderConfig(MOCK_CONFIG, "cursor");
    expect(config.command).toBe("cursor-agent");
    expect(config.defaultArgs).toEqual([]);
    expect(config.promptArg).toBe("-p");
    expect(config.modelArg).toBeUndefined();
  });

  it("throws for unknown provider", () => {
    expect(() => resolveProviderConfig(MOCK_CONFIG, "nonexistent")).toThrow("Unknown provider");
  });
});

describe("buildRunInput", () => {
  it("builds AgentRunInput from resolved role", () => {
    const role = resolveRole(MOCK_CONFIG, "creator");
    const input = buildRunInput(role, {
      automationDir: "/project/.operator",
      vars: { PROJECT_NAME: "SAMPLE" },
    }, {
      taskContent: "Fix the bug",
      cwd: "/workspace/project",
      verifyCommand: "npm test",
    });

    expect(input.agentName).toBe("creator");
    expect(input.providerId).toBe("claude");
    expect(input.model).toBe("opus");
    expect(input.timeoutMs).toBe(3_600_000);
    expect(input.tools).toEqual(["Read", "Grep", "Glob", "Bash", "Edit", "Write"]);
    expect(input.maxBudgetUsd).toBe(15.0);
    expect(input.maxRetries).toBe(3);
    expect(input.reviewEnabled).toBe(true);
    expect(input.verifyCommand).toBe("npm test");
    expect(input.cwd).toBe("/workspace/project");
    expect(input.taskContent).toBe("Fix the bug");
    expect(input.promptContext.contextFiles).toEqual(["base"]);
    expect(input.promptContext.instructionsTopic).toBe("creator");
    expect(input.promptContext.vars.PROJECT_NAME).toBe("SAMPLE");
  });

  it("instructionsPathToTopic strips agents/ prefix and .md suffix", () => {
    expect(instructionsPathToTopic("agents/creator.md")).toBe("creator");
    expect(instructionsPathToTopic("agents/verifier.md")).toBe("verifier");
    expect(instructionsPathToTopic("agents/nested/deep.md")).toBe("nested/deep");
    // Idempotent for topic-form input
    expect(instructionsPathToTopic("creator")).toBe("creator");
  });

  it("uses default maxRetries when not specified", () => {
    const role = resolveRole(MOCK_CONFIG, "diagnoser");
    const input = buildRunInput(role, {
      automationDir: "/project/.operator",
      vars: {},
    }, {
      cwd: "/workspace",
    });

    expect(input.maxRetries).toBe(3);
    expect(input.tools).toBeUndefined();
    expect(input.reviewEnabled).toBe(false);
  });

  it("passes verifierModel when specified", () => {
    const role = resolveRole(MOCK_CONFIG, "creator");
    const input = buildRunInput(role, {
      automationDir: "/project/.operator",
      vars: {},
    }, {
      cwd: "/workspace",
      verifierModel: "sonnet",
    });

    expect(input.verifierModel).toBe("sonnet");
  });
});
