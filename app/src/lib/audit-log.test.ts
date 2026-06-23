import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalStorageBundle } from "@operator/adapters/kvstore-sqlite";
import { AuditLogRowInvalidError, createAuditWriter, listAuditLog } from "./audit-log";

let tmpRoot: string;
let kv: LocalStorageBundle;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "audit-log-"));
  kv = new LocalStorageBundle({ dbPath: join(tmpRoot, "kv.db") });
});

afterEach(() => {
  kv.close();
  rmSync(tmpRoot, { recursive: true, force: true });
});

async function seedEvent(delta: { category: string; key: string; subOp?: "put" | "delete" | "reset" }): Promise<void> {
  const writer = createAuditWriter(kv);
  await writer.writeAuditEvent({
    category: delta.category,
    key: delta.key,
    op: delta.subOp ?? "put",
    editor: "ui",
    connectionId: "conn-test",
    before: { a: 1 },
    after: { a: 2 },
    diff: "- a: 1\n+ a: 2",
    timestamp: new Date().toISOString(),
    versionBefore: 0,
    versionAfter: 1,
  });
}

describe("createAuditWriter", () => {
  it("persists a config-edit row under execution-events/config-edit/*", async () => {
    await seedEvent({ category: "prompts", key: "creator" });
    const entries = await kv.list("execution-events", { keyPrefix: "config-edit/" });
    expect(entries).toHaveLength(1);
    const row = entries[0].value as Record<string, unknown>;
    expect(row["op"]).toBe("config-edit");
    expect(row["subOp"]).toBe("put");
    expect(row["category"]).toBe("prompts");
    expect(row["key"]).toBe("creator");
  });

  it("tags the row with source: ui so the UI badge is consistent", async () => {
    await seedEvent({ category: "prompts", key: "creator" });
    const entries = await kv.list("execution-events", { keyPrefix: "config-edit/" });
    expect(entries[0].metadata?.source).toBe("ui");
  });
});

describe("listAuditLog", () => {
  it("returns empty list when no events exist", async () => {
    expect(await listAuditLog(kv)).toEqual([]);
  });

  it("returns events newest-first", async () => {
    await seedEvent({ category: "prompts", key: "creator" });
    await new Promise((r) => setTimeout(r, 5));
    await seedEvent({ category: "prompts", key: "improver" });
    const rows = await listAuditLog(kv);
    expect(rows).toHaveLength(2);
    expect(rows[0].timestamp >= rows[1].timestamp).toBe(true);
  });

  it("filters by category", async () => {
    await seedEvent({ category: "prompts", key: "creator" });
    await seedEvent({ category: "workflow-stages", key: "init" });
    const rows = await listAuditLog(kv, { category: "prompts" });
    expect(rows).toHaveLength(1);
    expect(rows[0].category).toBe("prompts");
  });

  it("filters by key", async () => {
    await seedEvent({ category: "prompts", key: "creator" });
    await seedEvent({ category: "prompts", key: "improver" });
    const rows = await listAuditLog(kv, { key: "improver" });
    expect(rows).toHaveLength(1);
    expect(rows[0].key).toBe("improver");
  });

  it("respects limit and offset", async () => {
    for (let i = 0; i < 5; i++) {
      await seedEvent({ category: "prompts", key: `k${i}` });
      await new Promise((r) => setTimeout(r, 2));
    }
    const first = await listAuditLog(kv, { limit: 2, offset: 0 });
    expect(first).toHaveLength(2);
    const next = await listAuditLog(kv, { limit: 2, offset: 2 });
    expect(next).toHaveLength(2);
    expect(first[0].timestamp).not.toBe(next[0].timestamp);
  });

  it("ignores non-config-edit events in the execution-events category", async () => {
    await kv.put("execution-events", "stage-completed/1", { op: "stage.completed" });
    await seedEvent({ category: "prompts", key: "creator" });
    const rows = await listAuditLog(kv);
    expect(rows).toHaveLength(1);
    expect(rows[0].op).toBe("config-edit");
  });

  it("throws AuditLogRowInvalidError when a stored row fails schema validation", async () => {
    // Simulate a hand-edited SQLite row — op looks right but required
    // fields are missing. Without re-parse this would silently cast into
    // the UI and show blanks; with re-parse we get a typed error.
    await kv.put("execution-events", "config-edit/bad", {
      op: "config-edit",
      // Missing subOp, category, key, editor, connectionId, timestamp, …
    });
    await expect(listAuditLog(kv)).rejects.toThrow(AuditLogRowInvalidError);
  });

  it("returns parsed rows with every field coerced through the schema", async () => {
    await seedEvent({ category: "prompts", key: "creator" });
    const rows = await listAuditLog(kv);
    expect(rows).toHaveLength(1);
    // Parsed rows must satisfy every required invariant in the schema.
    const row = rows[0];
    expect(row.op).toBe("config-edit");
    expect(row.subOp).toMatch(/^(put|delete|reset)$/);
    expect(row.editor).toBe("ui");
    expect(typeof row.category).toBe("string");
    expect(typeof row.key).toBe("string");
    expect(typeof row.connectionId).toBe("string");
    expect(typeof row.timestamp).toBe("string");
    expect(typeof row.diff).toBe("string");
    expect(Number.isInteger(row.versionBefore)).toBe(true);
    expect(Number.isInteger(row.versionAfter)).toBe(true);
  });
});
