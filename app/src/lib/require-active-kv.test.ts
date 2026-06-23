import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { __resetAppKV } from "./app-kv";
import { __resetActiveKVRegistry } from "./active-kv-registry";
import { createConnection, setActiveConnection } from "./connections";
import { isResponse, requireActiveKV } from "./require-active-kv";

let tmpRoot: string;
let savedAppDbEnv: string | undefined;
let savedOperatorDbEnv: string | undefined;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "require-active-"));
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

describe("requireActiveKV", () => {
  it("returns a 401 NextResponse when no connection is active", async () => {
    const result = await requireActiveKV();
    expect(isResponse(result)).toBe(true);
    if (isResponse(result)) {
      expect(result.status).toBe(401);
      const body = await result.json();
      expect(body.error).toBeDefined();
    }
  });

  it("returns the active KV + connection bundle when an active connection exists", async () => {
    const c = await createConnection({ name: "t", dbPath: join(tmpRoot, "op.db") });
    await setActiveConnection(c.id);
    const result = await requireActiveKV();
    expect(isResponse(result)).toBe(false);
    if (!isResponse(result)) {
      expect(result.connection.id).toBe(c.id);
      expect(result.kv).toBeDefined();
    }
  });
});
