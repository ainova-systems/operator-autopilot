import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalStorageBundle } from "@operator/adapters/kvstore-sqlite";
import type { KVStore } from "@operator/core";
import {
  applyDelete,
  applyPut,
  applyReset,
  currentVersion,
  diffJson,
  isKnownCategory,
  MAX_ROW_BYTES,
  parseMetadata,
  schemaForCategory,
} from "./kv-write";
import type { ConfigEditEvent, WriteAuditDeps } from "./kv-write";

let tmpRoot: string;
let kv: LocalStorageBundle;

function fakeAudit(): WriteAuditDeps & { events: ConfigEditEvent[] } {
  const events: ConfigEditEvent[] = [];
  return {
    events,
    writeAuditEvent: async (event) => {
      events.push(event);
    },
  };
}

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "kv-write-"));
  kv = new LocalStorageBundle({ dbPath: join(tmpRoot, "kv.db") });
});

afterEach(() => {
  kv.close();
  rmSync(tmpRoot, { recursive: true, force: true });
});

const VALID_PROMPT = { topic: "creator", body: "You are the creator." };

describe("schemaForCategory / isKnownCategory", () => {
  it("returns the Zod schema for known categories", () => {
    expect(schemaForCategory("prompts")).toBeDefined();
    expect(schemaForCategory("workflow-stages")).toBeDefined();
  });

  it("returns null for unknown categories", () => {
    expect(schemaForCategory("not-a-category")).toBeNull();
  });

  it("isKnownCategory is strict", () => {
    expect(isKnownCategory("prompts")).toBe(true);
    expect(isKnownCategory("bogus")).toBe(false);
  });
});

describe("applyPut", () => {
  it("writes a fresh row and assigns version 1", async () => {
    const audit = fakeAudit();
    const out = await applyPut({
      kv: kv as unknown as KVStore,
      category: "prompts",
      key: "creator",
      value: VALID_PROMPT,
      expectedVersion: null,
      connectionId: "conn-1",
      audit,
    });
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.result.metadata.version).toBe(1);
      expect(out.result.metadata.source).toBe("ui");
    }
    const entry = await kv.get("prompts", "creator");
    expect(entry?.value).toEqual(VALID_PROMPT);
    expect(entry?.metadata?.version).toBe(1);
    expect(audit.events).toHaveLength(1);
    expect(audit.events[0].versionBefore).toBe(0);
    expect(audit.events[0].versionAfter).toBe(1);
  });

  it("rejects unknown category with 404", async () => {
    const out = await applyPut({
      kv: kv as unknown as KVStore,
      category: "bogus-kind",
      key: "x",
      value: {},
      expectedVersion: null,
      connectionId: "c",
      audit: fakeAudit(),
    });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.status).toBe(404);
  });

  it("rejects payload exceeding MAX_ROW_BYTES with 413", async () => {
    // Build a value with body > MAX_ROW_BYTES.
    const huge = { topic: "creator", body: "x".repeat(MAX_ROW_BYTES + 100) };
    const out = await applyPut({
      kv: kv as unknown as KVStore,
      category: "prompts",
      key: "creator",
      value: huge,
      expectedVersion: null,
      connectionId: "c",
      audit: fakeAudit(),
    });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.status).toBe(413);
  });

  it("rejects schema-invalid payload with 400 and Zod issues", async () => {
    const out = await applyPut({
      kv: kv as unknown as KVStore,
      category: "prompts",
      key: "creator",
      value: { topic: "creator" /* missing body */ },
      expectedVersion: null,
      connectionId: "c",
      audit: fakeAudit(),
    });
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.status).toBe(400);
      expect(out.body.error).toBe("Validation failed");
      expect(out.body.issues).toBeDefined();
    }
  });

  it("rejects readonly rows with 403", async () => {
    await kv.put("prompts", "creator", VALID_PROMPT, {
      metadata: { source: "yaml", readonly: true, version: 3 },
    });
    const out = await applyPut({
      kv: kv as unknown as KVStore,
      category: "prompts",
      key: "creator",
      value: VALID_PROMPT,
      expectedVersion: null,
      connectionId: "c",
      audit: fakeAudit(),
    });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.status).toBe(403);
  });

  it("returns 409 when expectedVersion mismatches currentVersion", async () => {
    await kv.put("prompts", "creator", VALID_PROMPT, {
      metadata: { source: "ui", readonly: false, version: 2 },
    });
    const out = await applyPut({
      kv: kv as unknown as KVStore,
      category: "prompts",
      key: "creator",
      value: { topic: "creator", body: "NEW" },
      expectedVersion: 1,
      connectionId: "c",
      audit: fakeAudit(),
    });
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.status).toBe(409);
      expect(out.body.currentVersion).toBe(2);
    }
  });

  // 2026-05-20 (Phase 5 P-502 partial): yaml-sourced rows are now
  // editable from the UI. First edit flips source to "ui" so the
  // engine's seed mirror leaves the row alone on subsequent boots
  // (relaxed yaml-mirror semantics in seed.ts).
  it("flips source yaml → ui on first UI edit of a yaml-sourced row", async () => {
    await kv.put("repos", "my-repo", {
      id: "my-repo",
      vcs: { platform: "github", repo: "owner/repo", branch: "main", tokenEnvVar: "MANAGED_REPO_GH_TOKEN" },
    }, {
      metadata: { source: "yaml", readonly: false, version: 0 },
    });
    const out = await applyPut({
      kv: kv as unknown as KVStore,
      category: "repos",
      key: "my-repo",
      value: {
        id: "my-repo",
        vcs: { platform: "github", repo: "owner/repo", branch: "main", tokenEnvVar: "MANAGED_REPO_GH_TOKEN" },
        limits: { maxActiveTasks: 5 }, // user lifted the parallel limit via UI
      },
      expectedVersion: 0,
      connectionId: "c",
      audit: fakeAudit(),
    });
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.result.metadata.source).toBe("ui");
      expect(out.result.metadata.version).toBe(1);
    }
  });

  it("flips modifiedFromBaseline on edit of a content-sourced row", async () => {
    await kv.put("prompts", "creator", VALID_PROMPT, {
      metadata: { source: "content", readonly: false, version: 1 },
    });
    const out = await applyPut({
      kv: kv as unknown as KVStore,
      category: "prompts",
      key: "creator",
      value: { topic: "creator", body: "EDITED" },
      expectedVersion: 1,
      connectionId: "c",
      audit: fakeAudit(),
    });
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.result.metadata.modifiedFromBaseline).toBe(true);
      expect(out.result.metadata.version).toBe(2);
      expect(out.result.metadata.source).toBe("content");
    }
  });

  it("increments version monotonically across sequential edits", async () => {
    const audit = fakeAudit();
    for (let i = 0; i < 3; i++) {
      const previous = await kv.get("prompts", "creator");
      const expected = currentVersion(previous?.metadata);
      const out = await applyPut({
        kv: kv as unknown as KVStore,
        category: "prompts",
        key: "creator",
        value: { topic: "creator", body: `v${i}` },
        expectedVersion: expected,
        connectionId: "c",
        audit,
      });
      expect(out.ok).toBe(true);
    }
    const final = await kv.get("prompts", "creator");
    expect(final?.metadata?.version).toBe(3);
    expect(audit.events).toHaveLength(3);
  });
});

describe("applyDelete", () => {
  it("deletes a row and emits an audit event", async () => {
    await kv.put("prompts", "creator", VALID_PROMPT, {
      metadata: { source: "ui", readonly: false, version: 2 },
    });
    const audit = fakeAudit();
    const out = await applyDelete({
      kv: kv as unknown as KVStore,
      category: "prompts",
      key: "creator",
      connectionId: "c",
      audit,
    });
    expect(out.ok).toBe(true);
    expect(await kv.get("prompts", "creator")).toBeNull();
    expect(audit.events).toHaveLength(1);
    expect(audit.events[0].op).toBe("delete");
  });

  it("returns 404 for a missing row", async () => {
    const out = await applyDelete({
      kv: kv as unknown as KVStore,
      category: "prompts",
      key: "nope",
      connectionId: "c",
      audit: fakeAudit(),
    });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.status).toBe(404);
  });

  it("rejects readonly rows with 403", async () => {
    await kv.put("repos", "sample", { id: "sample", vcs: { platform: "github", repo: "o/r", branch: "main", tokenEnvVar: "T" } }, {
      metadata: { source: "yaml", readonly: true, version: 1 },
    });
    const out = await applyDelete({
      kv: kv as unknown as KVStore,
      category: "repos",
      key: "sample",
      connectionId: "c",
      audit: fakeAudit(),
    });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.status).toBe(403);
  });

  it("returns 404 for unknown category", async () => {
    const out = await applyDelete({
      kv: kv as unknown as KVStore,
      category: "unknown-category",
      key: "x",
      connectionId: "c",
      audit: fakeAudit(),
    });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.status).toBe(404);
  });
});

describe("applyReset", () => {
  it("resets a content-sourced row from baseline and flips modifiedFromBaseline false", async () => {
    await kv.put("prompts", "creator", { topic: "creator", body: "USER EDIT" }, {
      metadata: { source: "content", readonly: false, version: 3, modifiedFromBaseline: true },
    });
    const audit = fakeAudit();
    const baseline = { topic: "creator", body: "SHIPPED BASELINE" };
    const out = await applyReset({
      kv: kv as unknown as KVStore,
      category: "prompts",
      key: "creator",
      baselineValue: baseline,
      connectionId: "c",
      audit,
    });
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.result.metadata.source).toBe("content");
      expect(out.result.metadata.modifiedFromBaseline).toBe(false);
      expect(out.result.metadata.version).toBe(4);
      expect(out.result.value).toEqual(baseline);
    }
    expect(audit.events[0].op).toBe("reset");
  });

  it("returns 405 for yaml-sourced rows", async () => {
    await kv.put("repos", "sample", { id: "sample", vcs: { platform: "github", repo: "o/r", branch: "main", tokenEnvVar: "T" } }, {
      metadata: { source: "yaml", readonly: true, version: 1 },
    });
    const out = await applyReset({
      kv: kv as unknown as KVStore,
      category: "repos",
      key: "sample",
      baselineValue: {},
      connectionId: "c",
      audit: fakeAudit(),
    });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.status).toBe(405);
  });

  it("returns 404 when the row does not exist", async () => {
    const out = await applyReset({
      kv: kv as unknown as KVStore,
      category: "prompts",
      key: "missing",
      baselineValue: VALID_PROMPT,
      connectionId: "c",
      audit: fakeAudit(),
    });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.status).toBe(404);
  });

  it("returns 500 when the baseline fails schema validation", async () => {
    await kv.put("prompts", "creator", VALID_PROMPT, {
      metadata: { source: "content", readonly: false, version: 1 },
    });
    const out = await applyReset({
      kv: kv as unknown as KVStore,
      category: "prompts",
      key: "creator",
      baselineValue: { topic: "creator" /* missing body */ },
      connectionId: "c",
      audit: fakeAudit(),
    });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.status).toBe(500);
  });

  it("rejects unknown category with 404", async () => {
    const out = await applyReset({
      kv: kv as unknown as KVStore,
      category: "unknown",
      key: "x",
      baselineValue: {},
      connectionId: "c",
      audit: fakeAudit(),
    });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.status).toBe(404);
  });
});

describe("diffJson", () => {
  it("reports (no change) for equal values", () => {
    expect(diffJson({ a: 1 }, { a: 1 })).toBe("(no change)");
  });

  it("reports before/after for changed values", () => {
    const d = diffJson({ a: 1 }, { a: 2 });
    expect(d).toContain("--- before");
    expect(d).toContain("+++ after");
  });

  it("caps output at 4 KB", () => {
    const big = { body: "x".repeat(5000) };
    const d = diffJson(null, big);
    expect(d.length).toBeLessThanOrEqual(4096);
  });

  it("handles un-stringifiable values via String() fallback", () => {
    const circular: Record<string, unknown> = {};
    circular["self"] = circular;
    // JSON.stringify throws, diffJson should not blow up.
    expect(() => diffJson(null, circular)).not.toThrow();
  });
});

describe("parseMetadata / currentVersion", () => {
  it("parses a metadata object through the Zod schema", () => {
    const parsed = parseMetadata({ source: "ui", readonly: false, version: 2 });
    expect(parsed.version).toBe(2);
  });

  it("currentVersion returns 0 when metadata or version is absent", () => {
    expect(currentVersion(undefined)).toBe(0);
    expect(currentVersion({ source: "ui", readonly: false })).toBe(0);
  });
});

describe("applyPut malformed body", () => {
  it("surfaces an unexpected non-Zod error thrown from schema.parse", async () => {
    // Simulate a mutator throwing a non-Zod error by monkey-patching the schema.
    const original = schemaForCategory("prompts")!;
    const spy = vi.spyOn(original, "parse").mockImplementation(() => {
      throw new Error("boom");
    });
    try {
      await expect(
        applyPut({
          kv: kv as unknown as KVStore,
          category: "prompts",
          key: "x",
          value: {},
          expectedVersion: null,
          connectionId: "c",
          audit: fakeAudit(),
        }),
      ).rejects.toThrow("boom");
    } finally {
      spy.mockRestore();
    }
  });
});
