import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalStorageBundle } from "@operator/adapters/kvstore-sqlite";
import { loadAgentConfig, loadAgentRequirements } from "./agent-config-source.js";

let tmpRoot: string;
let kv: LocalStorageBundle;
let savedContentDir: string | undefined;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "agent-config-"));
  kv = new LocalStorageBundle({ dbPath: join(tmpRoot, "operator.db") });
  savedContentDir = process.env["OPERATOR_CONTENT_DIR"];
});

afterEach(() => {
  kv.close();
  rmSync(tmpRoot, { recursive: true, force: true });
  if (savedContentDir === undefined) delete process.env["OPERATOR_CONTENT_DIR"];
  else process.env["OPERATOR_CONTENT_DIR"] = savedContentDir;
});

function writeContentDir(yaml: string): string {
  const root = join(tmpRoot, "content");
  mkdirSync(join(root, "defaults"), { recursive: true });
  writeFileSync(join(root, "defaults", "agents.yaml"), yaml, "utf-8");
  process.env["OPERATOR_CONTENT_DIR"] = root;
  return root;
}

const SINGLE_VENDOR_YAML = `
defaultProvider: claude
providers:
  claude:
    command: claude
    envVarsAnyOf:
      - ANTHROPIC_API_KEY
  cursor:
    command: cursor-agent
    envVars:
      - CURSOR_API_KEY
agents:
  creator:
    provider: claude
  verifier:
    provider: claude
`;

describe("loadAgentConfig — shipped baseline", () => {
  it("reads the repository's own agents.yaml when no override is set", async () => {
    delete process.env["OPERATOR_CONTENT_DIR"];
    const config = await loadAgentConfig(null);
    expect(config.source).toBe("baseline");
    expect(config.roles.length).toBeGreaterThan(0);
    expect(config.providers.map((p) => p.id)).toContain("claude");
  });

  it("carries each provider's command and credential variables", async () => {
    writeContentDir(SINGLE_VENDOR_YAML);
    const config = await loadAgentConfig(null);
    const cursor = config.providers.find((p) => p.id === "cursor");
    expect(cursor?.command).toBe("cursor-agent");
    expect(cursor?.envVars).toEqual(["CURSOR_API_KEY"]);
  });

  it("falls back to the provider id when no command is declared", async () => {
    writeContentDir("providers:\n  claude: {}\nagents:\n  verifier:\n    provider: claude\n");
    const config = await loadAgentConfig(null);
    expect(config.providers[0]?.command).toBe("claude");
  });

  it("drops a role that names no provider", async () => {
    writeContentDir("providers:\n  claude:\n    command: claude\nagents:\n  broken: {}\n");
    const config = await loadAgentConfig(null);
    expect(config.roles).toEqual([]);
  });

  it("returns an empty config when the baseline file is missing", async () => {
    process.env["OPERATOR_CONTENT_DIR"] = join(tmpRoot, "absent");
    const config = await loadAgentConfig(null);
    expect(config).toEqual({ roles: [], providers: [], source: "baseline" });
  });

  it("returns an empty config for an empty baseline file", async () => {
    writeContentDir("");
    const config = await loadAgentConfig(null);
    expect(config.roles).toEqual([]);
    expect(config.providers).toEqual([]);
  });
});

describe("loadAgentConfig — configured instance", () => {
  it("prefers the instance's own KV rows once roles exist", async () => {
    writeContentDir(SINGLE_VENDOR_YAML);
    await kv.put("agent-roles", "creator", {
      name: "creator",
      provider: "cursor",
      instructions: "agents/creator.md",
      timeout: 600,
    });
    await kv.put("agent-providers", "cursor", {
      id: "cursor",
      command: "cursor-agent",
      envVars: ["CURSOR_API_KEY"],
    });

    const config = await loadAgentConfig(kv);
    expect(config.source).toBe("kv");
    expect(config.roles).toEqual([{ name: "creator", provider: "cursor" }]);
  });

  it("falls back to the baseline for a database the engine has never seeded", async () => {
    writeContentDir(SINGLE_VENDOR_YAML);
    const config = await loadAgentConfig(kv);
    expect(config.source).toBe("baseline");
    expect(config.roles).toHaveLength(2);
  });

  it("skips rows that do not satisfy the core schemas", async () => {
    await kv.put("agent-roles", "good", {
      name: "good",
      provider: "claude",
      instructions: "agents/analyst.md",
      timeout: 60,
    });
    await kv.put("agent-roles", "bad", { name: "bad" });
    await kv.put("agent-providers", "claude", { id: "claude", command: "claude" });
    await kv.put("agent-providers", "junk", { nothing: true });

    const config = await loadAgentConfig(kv);
    expect(config.roles).toEqual([{ name: "good", provider: "claude" }]);
    expect(config.providers.map((p) => p.id)).toEqual(["claude"]);
  });
});

describe("loadAgentRequirements", () => {
  it("asks for exactly one CLI when every role runs on one provider", async () => {
    writeContentDir(SINGLE_VENDOR_YAML);
    const { requirements, unknownProviders } = await loadAgentRequirements(null);
    expect(requirements).toHaveLength(1);
    expect(requirements[0]?.command).toBe("claude");
    expect(requirements[0]?.usedBy).toEqual(["creator", "verifier"]);
    expect(unknownProviders).toEqual([]);
  });
});
