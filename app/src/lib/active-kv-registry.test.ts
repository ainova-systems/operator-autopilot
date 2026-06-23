import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { __resetAppKV } from "./app-kv";
import { getActiveKV, __resetActiveKVRegistry } from "./active-kv-registry";
import { createConnection, listConnections, setActiveConnection } from "./connections";

let tmpRoot: string;
let savedAppDbEnv: string | undefined;
let savedOperatorDbEnv: string | undefined;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "akv-"));
  savedAppDbEnv = process.env["OPERATOR_APP_DB_PATH"];
  savedOperatorDbEnv = process.env["OPERATOR_DB_PATH"];
  process.env["OPERATOR_APP_DB_PATH"] = join(tmpRoot, "app.db");
  delete process.env["OPERATOR_DB_PATH"];
  __resetAppKV();
  __resetActiveKVRegistry();
});

afterEach(() => {
  __resetActiveKVRegistry();
  __resetAppKV();
  if (savedAppDbEnv === undefined) delete process.env["OPERATOR_APP_DB_PATH"];
  else process.env["OPERATOR_APP_DB_PATH"] = savedAppDbEnv;
  if (savedOperatorDbEnv === undefined) delete process.env["OPERATOR_DB_PATH"];
  else process.env["OPERATOR_DB_PATH"] = savedOperatorDbEnv;
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("getActiveKV", () => {
  it("returns null when no connection is registered and no env var is set", async () => {
    const active = await getActiveKV();
    expect(active).toBeNull();
  });

  it("returns the mounted KVStore for the active saved connection", async () => {
    const c = await createConnection({
      name: "sample",
      dbPath: join(tmpRoot, "operator.db"),
    });
    await setActiveConnection(c.id);

    const active = await getActiveKV();
    expect(active).not.toBeNull();
    expect(active?.connection.id).toBe(c.id);

    // The mounted store should be usable.
    await active?.kv.put("prompts", "a", { body: "hi" });
    const entry = await active?.kv.get("prompts", "a");
    expect(entry?.value).toEqual({ body: "hi" });
  });

  it("reuses the cached KVStore for a connection on repeat access", async () => {
    const c = await createConnection({
      name: "sample",
      dbPath: join(tmpRoot, "operator.db"),
    });
    await setActiveConnection(c.id);
    const first = await getActiveKV();
    const second = await getActiveKV();
    expect(first?.kv).toBe(second?.kv);
  });

  it("auto-provisions a default connection when OPERATOR_DB_PATH is set and no connections exist", async () => {
    process.env["OPERATOR_DB_PATH"] = join(tmpRoot, "env-db.db");
    const active = await getActiveKV();
    expect(active).not.toBeNull();
    expect(active?.connection.name).toBe("default");
    expect(active?.connection.dbPath).toBe(join(tmpRoot, "env-db.db"));
  });

  it("parallel getActiveKV calls share one auto-provisioned default connection", async () => {
    process.env["OPERATOR_DB_PATH"] = join(tmpRoot, "race.db");
    const [a, b, c] = await Promise.all([getActiveKV(), getActiveKV(), getActiveKV()]);
    expect(a).not.toBeNull();
    expect(b?.connection.id).toBe(a?.connection.id);
    expect(c?.connection.id).toBe(a?.connection.id);
    const rows = await listConnections();
    expect(rows).toHaveLength(1);
  });

  it("does not auto-provision when OPERATOR_DB_PATH is set but connections exist", async () => {
    // First: create a different connection manually
    const c = await createConnection({
      name: "existing",
      dbPath: join(tmpRoot, "existing.db"),
    });
    await setActiveConnection(c.id);

    process.env["OPERATOR_DB_PATH"] = join(tmpRoot, "would-not-be-created.db");
    const active = await getActiveKV();
    expect(active?.connection.name).toBe("existing");
  });
});
