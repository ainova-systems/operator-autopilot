import { describe, expect, it } from "vitest";
import {
  collectAgentRequirements,
  missingEnvVars,
  type AgentRequirement,
  type ProviderLike,
} from "./agent-requirements.js";

const CLAUDE: ProviderLike = {
  id: "claude",
  command: "claude",
  envVarsAnyOf: ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"],
};
const CURSOR: ProviderLike = {
  id: "cursor",
  command: "cursor-agent",
  envVars: ["CURSOR_API_KEY"],
};

describe("collectAgentRequirements", () => {
  it("returns one requirement per provider a role actually routes to", () => {
    const { requirements, unknownProviders } = collectAgentRequirements(
      [
        { name: "creator", provider: "cursor" },
        { name: "verifier", provider: "claude" },
        { name: "analyst", provider: "claude" },
      ],
      [CLAUDE, CURSOR],
    );
    expect(requirements.map((r) => r.providerId)).toEqual(["claude", "cursor"]);
    expect(requirements[0]?.usedBy).toEqual(["analyst", "verifier"]);
    expect(requirements[0]?.envVarsAnyOf).toEqual([
      "ANTHROPIC_API_KEY",
      "CLAUDE_CODE_OAUTH_TOKEN",
    ]);
    expect(requirements[1]?.command).toBe("cursor-agent");
    expect(unknownProviders).toEqual([]);
  });

  it("omits a configured provider no role uses, so a single-vendor setup asks for one CLI", () => {
    const { requirements } = collectAgentRequirements(
      [
        { name: "creator", provider: "claude" },
        { name: "verifier", provider: "claude" },
      ],
      [CLAUDE, CURSOR],
    );
    expect(requirements).toHaveLength(1);
    expect(requirements[0]?.command).toBe("claude");
  });

  it("reports a role pointing at an undefined provider instead of inventing one", () => {
    const { requirements, unknownProviders } = collectAgentRequirements(
      [
        { name: "creator", provider: "ghost" },
        { name: "verifier", provider: "claude" },
      ],
      [CLAUDE],
    );
    expect(unknownProviders).toEqual(["ghost"]);
    expect(requirements.map((r) => r.providerId)).toEqual(["claude"]);
  });

  it("collapses the synthetic _default row onto the richer definition of the same id", () => {
    const { requirements } = collectAgentRequirements(
      [{ name: "verifier", provider: "claude" }],
      [{ id: "claude", command: "claude" }, CLAUDE],
    );
    expect(requirements).toHaveLength(1);
    expect(requirements[0]?.envVarsAnyOf).toHaveLength(2);
  });

  it("keeps the richer definition even when it comes first", () => {
    const { requirements } = collectAgentRequirements(
      [{ name: "verifier", provider: "claude" }],
      [CLAUDE, { id: "claude", command: "claude" }],
    );
    expect(requirements[0]?.envVarsAnyOf).toHaveLength(2);
  });

  it("returns nothing when no roles are configured yet", () => {
    expect(collectAgentRequirements([], [CLAUDE]).requirements).toEqual([]);
  });
});

describe("missingEnvVars", () => {
  const cursorReq: AgentRequirement = {
    providerId: "cursor",
    command: "cursor-agent",
    envVars: ["CURSOR_API_KEY"],
    envVarsAnyOf: [],
    usedBy: ["creator"],
  };
  const claudeReq: AgentRequirement = {
    providerId: "claude",
    command: "claude",
    envVars: [],
    envVarsAnyOf: ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"],
    usedBy: ["verifier"],
  };

  it("reports a required variable that is unset", () => {
    expect(missingEnvVars(cursorReq, {})).toEqual(["CURSOR_API_KEY"]);
  });

  it("treats a blank value as unset", () => {
    expect(missingEnvVars(cursorReq, { CURSOR_API_KEY: "   " })).toEqual(["CURSOR_API_KEY"]);
  });

  it("is satisfied by any one member of an any-of group", () => {
    expect(missingEnvVars(claudeReq, { CLAUDE_CODE_OAUTH_TOKEN: "tok" })).toEqual([]);
  });

  it("reports an unmet any-of group as a single combined entry", () => {
    expect(missingEnvVars(claudeReq, {})).toEqual([
      "ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN",
    ]);
  });

  it("returns nothing when every requirement is met", () => {
    expect(missingEnvVars(cursorReq, { CURSOR_API_KEY: "key" })).toEqual([]);
  });
});
