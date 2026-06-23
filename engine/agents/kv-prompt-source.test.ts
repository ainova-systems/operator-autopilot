import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { LocalStorageBundle } from "@operator/adapters/kvstore-sqlite";
import { ConfigError } from "@operator/core";
import { KVPromptSource } from "./kv-prompt-source.js";

let automationDir: string;
let bundle: LocalStorageBundle;
let dbDir: string;

beforeEach(async () => {
  automationDir = await mkdtemp(join(tmpdir(), "kv-prompt-repo-"));
  dbDir = await mkdtemp(join(tmpdir(), "kv-prompt-db-"));
  bundle = new LocalStorageBundle({ dbPath: join(dbDir, "kv.db") });
});

afterEach(async () => {
  bundle.close();
  await rm(automationDir, { recursive: true, force: true });
  await rm(dbDir, { recursive: true, force: true });
});

async function writeUserPrompt(rel: string, content: string): Promise<void> {
  const full = join(automationDir, "agents", rel);
  await mkdir(join(full, ".."), { recursive: true });
  await writeFile(full, content);
}

describe("KVPromptSource.loadChain", () => {
  it("returns empty string when neither layer exists", async () => {
    const source = new KVPromptSource(bundle, automationDir);
    expect(await source.loadChain("creator")).toBe("");
  });

  it("reads system prompt from kv:prompts for non-verifier topics", async () => {
    await bundle.put("prompts", "creator", { topic: "creator", body: "SYSTEM CREATOR BODY" });
    const source = new KVPromptSource(bundle, automationDir);
    expect(await source.loadChain("creator")).toBe("SYSTEM CREATOR BODY");
  });

  it("reads verifier topics from kv:verifier-criteria instead of prompts", async () => {
    await bundle.put("verifier-criteria", "finding-plan", {
      stageName: "finding-plan", body: "VERIFIER FINDING CRITERIA",
    });
    const source = new KVPromptSource(bundle, automationDir);
    expect(await source.loadChain("verifier/finding-plan")).toBe("VERIFIER FINDING CRITERIA");
  });

  it("appends filesystem user extension after KV system layer", async () => {
    await bundle.put("prompts", "creator", { topic: "creator", body: "SYSTEM BASE" });
    await writeUserPrompt("creator.md", "USER ADDS");
    const source = new KVPromptSource(bundle, automationDir);
    const result = await source.loadChain("creator");
    expect(result).toContain("SYSTEM BASE");
    expect(result).toContain("USER ADDS");
    expect(result).toContain("Repository Extensions");
    expect(result.indexOf("SYSTEM BASE")).toBeLessThan(result.indexOf("USER ADDS"));
  });

  it("returns user extension alone when KV row missing", async () => {
    await writeUserPrompt("verifier/init.md", "USER-ONLY CRITERIA");
    const source = new KVPromptSource(bundle, automationDir);
    const result = await source.loadChain("verifier/init");
    expect(result).toContain("USER-ONLY CRITERIA");
    expect(result).toContain("Repository Extensions");
  });

  it("strips YAML frontmatter from KV body", async () => {
    await bundle.put("prompts", "creator", {
      topic: "creator",
      body: "---\nstage: x\n---\n\nREAL BODY",
    });
    const source = new KVPromptSource(bundle, automationDir);
    const result = await source.loadChain("creator");
    expect(result).toContain("REAL BODY");
    expect(result).not.toContain("stage: x");
  });

  it("handles nested topics like context/base via kv:prompts", async () => {
    await bundle.put("prompts", "context/base", { topic: "context/base", body: "BASE CTX" });
    const source = new KVPromptSource(bundle, automationDir);
    expect(await source.loadChain("context/base")).toBe("BASE CTX");
  });

  it("throws ConfigError when a prompts row fails schema validation at read boundary", async () => {
    // Missing required `body` field — simulates corrupted row from direct sqlite3 surgery.
    await bundle.put("prompts", "creator", { topic: "creator" });
    const source = new KVPromptSource(bundle, automationDir);
    await expect(source.loadChain("creator")).rejects.toThrow(ConfigError);
    await expect(source.loadChain("creator")).rejects.toThrow(/prompts\/creator/);
  });

  it("throws ConfigError when a verifier-criteria row is malformed", async () => {
    await bundle.put("verifier-criteria", "finding-plan", { stageName: "finding-plan" });
    const source = new KVPromptSource(bundle, automationDir);
    await expect(source.loadChain("verifier/finding-plan")).rejects.toThrow(ConfigError);
  });

  it("logs a warning when the KV system row is missing", async () => {
    const messages: string[] = [];
    const log = {
      debug: () => {}, info: () => {},
      warn: (msg: string) => { messages.push(msg); },
      error: () => {},
      child() { return this; },
    };
    const source = new KVPromptSource(bundle, automationDir, log);
    await source.loadChain("creator");
    expect(messages.some((m) => m.includes("prompts/creator"))).toBe(true);
  });
});
