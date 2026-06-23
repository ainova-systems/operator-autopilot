import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFailureReason, clearFailureFields } from "./failure-reason-writer.js";

async function setupTmp(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "failure-reason-"));
}

const SAMPLE = `---
id: T-1
kind: task
title: sample
status: pending
priority: 3
created_at: 2026-05-12T00:00:00Z
---

body
`;

describe("writeFailureReason", () => {
  let dir: string;
  beforeEach(async () => { dir = await setupTmp(); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it("inserts a new failure_reason line immediately after the status line", async () => {
    const filePath = join(dir, "task.md");
    await writeFile(filePath, SAMPLE, "utf-8");
    await writeFailureReason(filePath, "syntax error in main.ts");
    const after = await readFile(filePath, "utf-8");
    expect(after).toMatch(/status: pending\nfailure_reason: "syntax error in main.ts"/);
  });

  it("replaces an existing failure_reason line in place rather than duplicating", async () => {
    const filePath = join(dir, "task.md");
    const seeded = SAMPLE.replace(
      "status: pending\n",
      "status: failed\nfailure_reason: \"old reason\"\n",
    );
    await writeFile(filePath, seeded, "utf-8");
    await writeFailureReason(filePath, "new reason");
    const after = await readFile(filePath, "utf-8");
    expect(after).toMatch(/failure_reason: "new reason"/);
    expect(after).not.toMatch(/failure_reason: "old reason"/);
    const occurrences = after.match(/failure_reason:/g);
    expect(occurrences?.length).toBe(1);
  });

  it("backslash-escapes double quotes inside the reason text so the YAML scalar stays valid", async () => {
    const filePath = join(dir, "task.md");
    await writeFile(filePath, SAMPLE, "utf-8");
    await writeFailureReason(filePath, `the "foo" macro failed`);
    const after = await readFile(filePath, "utf-8");
    expect(after).toMatch(/failure_reason: "the \\"foo\\" macro failed"/);
  });

  it("logs a warning and swallows the error when the file does not exist", async () => {
    const warn = vi.fn();
    const log = { warn } as unknown as Parameters<typeof writeFailureReason>[2];
    await writeFailureReason(join(dir, "does-not-exist.md"), "boom", log);
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0][0]).toContain("failure-reason-writer");
  });

  it("works without a logger when the file does not exist (silent swallow)", async () => {
    await expect(writeFailureReason(join(dir, "missing.md"), "boom")).resolves.toBeUndefined();
  });
});

describe("clearFailureFields", () => {
  let dir: string;
  beforeEach(async () => { dir = await setupTmp(); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it("removes failed_at, failure_reason, and execution_attempts lines while preserving the rest", async () => {
    const filePath = join(dir, "task.md");
    const seeded = SAMPLE.replace(
      "status: pending\n",
      [
        "status: failed",
        `failed_at: 2026-05-10T10:00:00Z`,
        `failure_reason: "syntax error"`,
        `execution_attempts: 2`,
        "",
      ].join("\n"),
    );
    await writeFile(filePath, seeded, "utf-8");
    await clearFailureFields(filePath);
    const after = await readFile(filePath, "utf-8");
    expect(after).not.toMatch(/failed_at:/);
    expect(after).not.toMatch(/failure_reason:/);
    expect(after).not.toMatch(/execution_attempts:/);
    expect(after).toMatch(/status: failed/);
    expect(after).toMatch(/^id: T-1$/m);
    expect(after).toMatch(/^kind: task$/m);
  });

  it("is a no-op on a file without failure fields", async () => {
    const filePath = join(dir, "task.md");
    await writeFile(filePath, SAMPLE, "utf-8");
    await clearFailureFields(filePath);
    const after = await readFile(filePath, "utf-8");
    expect(after).toBe(SAMPLE);
  });

  it("silently swallows I/O errors", async () => {
    await expect(clearFailureFields(join(dir, "does-not-exist.md"))).resolves.toBeUndefined();
  });
});
