import { describe, it, expect } from "vitest";
import {
  agentsFileSchema,
  projectYamlSchema,
} from "./schemas.js";

describe("agentsFileSchema", () => {
  const validAgents = {
    version: "3.0",
    defaultProvider: "claude",
    providers: {
      claude: {
        command: "claude",
        defaultArgs: ["--dangerously-skip-permissions"],
        promptArg: "-p",
        outputMode: "stdout",
      },
    },
    agents: {
      creator: {
        provider: "claude",
        instructions: "agents/creator.md",
        timeout: 3600,
        model: "opus",
        tools: "Read,Grep,Glob,Bash,Edit,Write",
        maxBudget: 15.0,
      },
    },
  };

  it("parses a valid agents config", () => {
    const result = agentsFileSchema.parse(validAgents);
    expect(result.defaultProvider).toBe("claude");
    expect(result.providers["claude"].command).toBe("claude");
    expect(result.agents["creator"].timeout).toBe(3600);
  });

  it("applies default timeout", () => {
    const input = {
      ...validAgents,
      agents: {
        reviewer: {
          provider: "claude",
          instructions: "agents/reviewer.md",
        },
      },
    };
    const result = agentsFileSchema.parse(input);
    expect(result.agents["reviewer"].timeout).toBe(600);
  });

  it("rejects missing providers", () => {
    expect(() =>
      agentsFileSchema.parse({
        agents: { creator: { provider: "claude", instructions: "x.md" } },
      }),
    ).toThrow();
  });

  it("parses provider with envVarsAnyOf", () => {
    const result = agentsFileSchema.parse({
      ...validAgents,
      providers: {
        claude: {
          ...validAgents.providers.claude,
          envVarsAnyOf: ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"],
        },
      },
    });
    expect(result.providers["claude"].envVarsAnyOf).toEqual([
      "ANTHROPIC_API_KEY",
      "CLAUDE_CODE_OAUTH_TOKEN",
    ]);
  });
});

describe("projectYamlSchema", () => {
  it("parses a valid project.yaml", () => {
    const input = {
      scripts: { init: "npm ci", verify: "npm test" },
      context: "CLAUDE.md",
    };
    const result = projectYamlSchema.parse(input);
    expect(result.scripts?.verify).toBe("npm test");
    expect(result.context).toBe("CLAUDE.md");
  });

  it("accepts empty object", () => {
    const result = projectYamlSchema.parse({});
    expect(result.scripts).toBeUndefined();
    expect(result.context).toBeUndefined();
  });
});
