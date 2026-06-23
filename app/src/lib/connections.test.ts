import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { __resetAppKV } from "./app-kv";
import * as conns from "./connections";

let tmpRoot: string;
let savedAppDbEnv: string | undefined;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "conns-"));
  savedAppDbEnv = process.env["OPERATOR_APP_DB_PATH"];
  process.env["OPERATOR_APP_DB_PATH"] = join(tmpRoot, "app.db");
  __resetAppKV();
});

afterEach(() => {
  __resetAppKV();
  if (savedAppDbEnv === undefined) delete process.env["OPERATOR_APP_DB_PATH"];
  else process.env["OPERATOR_APP_DB_PATH"] = savedAppDbEnv;
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("connections CRUD", () => {
  it("creates and lists connections", async () => {
    
    expect(await conns.listConnections()).toEqual([]);

    const created = await conns.createConnection({
      name: "sample-local",
      dbPath: join(tmpRoot, "operator.db"),
    });
    expect(created.id).toBeTypeOf("string");
    expect(created.name).toBe("sample-local");
    expect(created.createdAt).toBeTypeOf("string");

    const list = await conns.listConnections();
    expect(list).toHaveLength(1);
    expect(list[0]?.name).toBe("sample-local");
  });

  it("returns null for missing connection lookups", async () => {
    
    expect(await conns.getConnection("nonexistent")).toBeNull();
  });

  it("updates connection name via patch", async () => {
    
    const c = await conns.createConnection({ name: "a", dbPath: join(tmpRoot, "a.db") });
    const updated = await conns.updateConnection(c.id, { name: "b" });
    expect(updated?.name).toBe("b");
    expect(updated?.dbPath).toBe(c.dbPath);
  });

  it("returns null when updating missing connection", async () => {
    
    const result = await conns.updateConnection("nonexistent", { name: "x" });
    expect(result).toBeNull();
  });

  it("deletes a connection and clears active pointer", async () => {
    
    const c = await conns.createConnection({ name: "a", dbPath: join(tmpRoot, "a.db") });
    await conns.setActiveConnection(c.id);
    expect((await conns.getActiveConnectionState())?.id).toBe(c.id);

    const ok = await conns.deleteConnection(c.id);
    expect(ok).toBe(true);
    expect(await conns.listConnections()).toEqual([]);
    expect(await conns.getActiveConnectionState()).toBeNull();
  });

  it("delete returns false for missing connection", async () => {
    
    expect(await conns.deleteConnection("missing")).toBe(false);
  });

  it("setActiveConnection updates lastUsedAt on the connection row", async () => {
    
    const c = await conns.createConnection({ name: "a", dbPath: join(tmpRoot, "a.db") });
    expect(c.lastUsedAt).toBeUndefined();
    await conns.setActiveConnection(c.id);
    const refreshed = await conns.getConnection(c.id);
    expect(refreshed?.lastUsedAt).toBeTypeOf("string");
  });

  it("setActiveConnection returns null for missing connection", async () => {
    
    expect(await conns.setActiveConnection("nope")).toBeNull();
  });

  it("getActiveConnection returns full record", async () => {
    
    const c = await conns.createConnection({ name: "a", dbPath: join(tmpRoot, "a.db") });
    await conns.setActiveConnection(c.id);
    const active = await conns.getActiveConnection();
    expect(active?.id).toBe(c.id);
    expect(active?.name).toBe("a");
  });

  it("testConnection succeeds against an empty but openable SQLite file", async () => {
    
    const result = await conns.testConnection({
      name: "probe",
      dbPath: join(tmpRoot, "probe.db"),
    });
    expect(result.ok).toBe(true);
  });

  it("testConnection fails when the path resolves to something that can't be opened", async () => {
    // `tmpRoot` is a directory. SQLite cannot open a directory as a db file;
    // parent-dir auto-creation in `createTransientKVStore` doesn't help here.
    const result = await conns.testConnection({
      name: "probe",
      dbPath: tmpRoot,
    });
    expect(result.ok).toBe(false);
    expect(result.message).toBeTypeOf("string");
  });

  it("clearActiveConnection removes the active pointer without touching the row", async () => {
    const c = await conns.createConnection({ name: "a", dbPath: join(tmpRoot, "a.db") });
    await conns.setActiveConnection(c.id);
    expect((await conns.getActiveConnectionState())?.id).toBe(c.id);
    await conns.clearActiveConnection();
    expect(await conns.getActiveConnectionState()).toBeNull();
    // The connection itself stays intact.
    expect(await conns.getConnection(c.id)).not.toBeNull();
  });
});
