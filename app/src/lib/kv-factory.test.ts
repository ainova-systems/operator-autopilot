import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createKVStoreForConnection, createTransientKVStore } from "./kv-factory";
import type { Connection } from "./connection-types";

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "kv-factory-"));
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("createKVStoreForConnection", () => {
  it("opens a LocalStorageBundle at the connection's dbPath", async () => {
    const conn: Connection = {
      id: "test-id",
      name: "test",
      dbPath: join(tmpRoot, "operator.db"),
      createdAt: "2026-04-15T00:00:00.000Z",
    };
    const store = createKVStoreForConnection(conn);
    try {
      await store.put("prompts", "test", { body: "hello" });
      const entry = await store.get("prompts", "test");
      expect(entry?.value).toEqual({ body: "hello" });
    } finally {
      store.close();
    }
  });

  it("creates missing parent directories for the dbPath", async () => {
    const conn: Connection = {
      id: "nested-id",
      name: "nested",
      dbPath: join(tmpRoot, "nested", "deeper", "operator.db"),
      createdAt: "2026-04-15T00:00:00.000Z",
    };
    const store = createKVStoreForConnection(conn);
    try {
      await store.put("prompts", "test", { body: "hello" });
      const entry = await store.get("prompts", "test");
      expect(entry?.value).toEqual({ body: "hello" });
    } finally {
      store.close();
    }
  });
});

describe("createTransientKVStore", () => {
  it("opens a LocalStorageBundle from connection input shape", async () => {
    const store = createTransientKVStore({
      name: "probe",
      dbPath: join(tmpRoot, "probe.db"),
    });
    try {
      const rows = await store.list("work-items");
      expect(rows).toEqual([]);
    } finally {
      store.close();
    }
  });

  it("creates missing parent directories for the dbPath", async () => {
    const store = createTransientKVStore({
      name: "probe",
      dbPath: join(tmpRoot, "nested", "deeper", "probe.db"),
    });
    try {
      const rows = await store.list("work-items");
      expect(rows).toEqual([]);
    } finally {
      store.close();
    }
  });
});
