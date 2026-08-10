import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalStorageBundle } from "@operator/adapters/kvstore-sqlite";
import { probeEngineDb } from "./db-probe.js";

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "db-probe-"));
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("probeEngineDb", () => {
  it("creates a database file that does not exist yet", async () => {
    const dbPath = join(tmpRoot, "nested", "operator.db");
    const result = await probeEngineDb(dbPath);
    expect(result.ok).toBe(true);
    expect(result.seeded).toBe(false);
    expect(result.message).toContain("seeds its configuration on first start");
  });

  it("reports a database the engine has already seeded", async () => {
    const dbPath = join(tmpRoot, "operator.db");
    const kv = new LocalStorageBundle({ dbPath });
    await kv.put("workflow-stages", "scout", { name: "scout" });
    kv.close();

    const result = await probeEngineDb(dbPath);
    expect(result.ok).toBe(true);
    expect(result.seeded).toBe(true);
    expect(result.message).toContain("configuration is present");
  });

  it("leaves no probe rows behind", async () => {
    const dbPath = join(tmpRoot, "operator.db");
    await probeEngineDb(dbPath);
    const kv = new LocalStorageBundle({ dbPath });
    const categories = ["workflow-stages", "repos", "work-items", "executions"];
    for (const category of categories) {
      expect(await kv.list(category)).toEqual([]);
    }
    kv.close();
  });

  it("reports the failure when the path cannot be opened as a database", async () => {
    const dbPath = join(tmpRoot, "not-a-db");
    writeFileSync(dbPath, "this is not a SQLite file", "utf-8");
    const result = await probeEngineDb(dbPath);
    expect(result.ok).toBe(false);
    expect(result.message.length).toBeGreaterThan(0);
  });
});
