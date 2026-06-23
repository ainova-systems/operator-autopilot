import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { LocalStorageBundle } from "@operator/adapters/kvstore-sqlite";
import { ConfigError } from "@operator/core";
import { KVTemplateSource, TemplateNotFoundError } from "./kv-template-source.js";

let bundle: LocalStorageBundle;
let dbDir: string;

beforeEach(async () => {
  dbDir = await mkdtemp(join(tmpdir(), "kv-template-"));
  bundle = new LocalStorageBundle({ dbPath: join(dbDir, "kv.db") });
});

afterEach(async () => {
  bundle.close();
  await rm(dbDir, { recursive: true, force: true });
});

describe("KVTemplateSource.load", () => {
  it("returns the raw template body when no vars supplied", async () => {
    await bundle.put("templates", "init-pr-body.md", {
      name: "init-pr-body.md", body: "## Init",
    });
    const source = new KVTemplateSource(bundle);
    expect(await source.load("init-pr-body.md")).toBe("## Init");
  });

  it("substitutes {KEY} placeholders from vars", async () => {
    await bundle.put("templates", "task-pr-body.md", {
      name: "task-pr-body.md", body: "Task {ID} in {REPO}",
    });
    const source = new KVTemplateSource(bundle);
    const rendered = await source.load("task-pr-body.md", { ID: "T-1", REPO: "sample" });
    expect(rendered).toBe("Task T-1 in sample");
  });

  it("throws TemplateNotFoundError for a missing key", async () => {
    const source = new KVTemplateSource(bundle);
    await expect(source.load("missing.md")).rejects.toBeInstanceOf(TemplateNotFoundError);
  });

  it("leaves unreferenced placeholders intact", async () => {
    await bundle.put("templates", "a.md", { name: "a.md", body: "X={X} Y={Y}" });
    const source = new KVTemplateSource(bundle);
    expect(await source.load("a.md", { X: "1" })).toBe("X=1 Y={Y}");
  });

  it("works with format snippets under formats/ prefix", async () => {
    await bundle.put("templates", "formats/task.txt", {
      name: "formats/task.txt", body: "Language: {LANGUAGE}",
    });
    const source = new KVTemplateSource(bundle);
    expect(await source.load("formats/task.txt", { LANGUAGE: "English" }))
      .toBe("Language: English");
  });

  it("throws ConfigError when a templates row fails schema validation at read boundary", async () => {
    // Missing required `body` — user edited via sqlite3 and left the column null.
    await bundle.put("templates", "init-pr-body.md", { name: "init-pr-body.md" });
    const source = new KVTemplateSource(bundle);
    await expect(source.load("init-pr-body.md")).rejects.toThrow(ConfigError);
    await expect(source.load("init-pr-body.md")).rejects.toThrow(/templates\/init-pr-body\.md/);
  });
});
