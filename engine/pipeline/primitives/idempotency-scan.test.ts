import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findChildrenByParentId } from "./idempotency-scan.js";

async function setupTmp(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "idempotency-scan-"));
}

function makeWorkItemMd(opts: {
  id: string;
  kind: string;
  parentId?: string;
  status?: string;
  title?: string;
}): string {
  const lines = [
    "---",
    `id: ${opts.id}`,
    `kind: ${opts.kind}`,
    `title: ${opts.title ?? "untitled"}`,
    `status: ${opts.status ?? "pending"}`,
    `priority: 50`,
    `created_at: 2026-05-12T00:00:00Z`,
  ];
  if (opts.parentId !== undefined) lines.push(`parent_id: ${opts.parentId}`);
  lines.push("---", "", "body content");
  return lines.join("\n");
}

describe("findChildrenByParentId", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await setupTmp();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("returns empty array when the data directory does not exist", async () => {
    const missing = join(dir, "does-not-exist");
    const result = await findChildrenByParentId({ dataDir: missing, parentId: "F20260512-0001" });
    expect(result).toEqual([]);
  });

  it("returns empty array when the directory has no .md files", async () => {
    await writeFile(join(dir, "notes.txt"), "not markdown", "utf-8");
    const result = await findChildrenByParentId({ dataDir: dir, parentId: "F20260512-0001" });
    expect(result).toEqual([]);
  });

  it("returns ids of every child whose parent_id matches", async () => {
    await writeFile(
      join(dir, "T20260512-0001.md"),
      makeWorkItemMd({ id: "T20260512-0001", kind: "task", parentId: "F20260512-0001" }),
      "utf-8",
    );
    await writeFile(
      join(dir, "T20260512-0002.md"),
      makeWorkItemMd({ id: "T20260512-0002", kind: "task", parentId: "F20260512-0001" }),
      "utf-8",
    );
    const result = await findChildrenByParentId({ dataDir: dir, parentId: "F20260512-0001" });
    expect(result).toEqual(["T20260512-0001", "T20260512-0002"]);
  });

  it("skips files whose parent_id is absent or different", async () => {
    await writeFile(
      join(dir, "T20260512-0001.md"),
      makeWorkItemMd({ id: "T20260512-0001", kind: "task", parentId: "F20260512-0001" }),
      "utf-8",
    );
    await writeFile(
      join(dir, "T20260512-0002.md"),
      makeWorkItemMd({ id: "T20260512-0002", kind: "task", parentId: "F20260512-9999" }),
      "utf-8",
    );
    await writeFile(
      join(dir, "T20260512-0003.md"),
      makeWorkItemMd({ id: "T20260512-0003", kind: "task" }),
      "utf-8",
    );
    const result = await findChildrenByParentId({ dataDir: dir, parentId: "F20260512-0001" });
    expect(result).toEqual(["T20260512-0001"]);
  });

  it("ignores non-.md files mixed into the directory", async () => {
    await writeFile(
      join(dir, "T20260512-0001.md"),
      makeWorkItemMd({ id: "T20260512-0001", kind: "task", parentId: "F20260512-0001" }),
      "utf-8",
    );
    await writeFile(join(dir, "README"), "no extension", "utf-8");
    await writeFile(join(dir, "draft.md.bak"), "stale", "utf-8");
    await mkdir(join(dir, "subdir"));
    const result = await findChildrenByParentId({ dataDir: dir, parentId: "F20260512-0001" });
    expect(result).toEqual(["T20260512-0001"]);
  });

  it("skips unreadable / unparseable .md files and keeps scanning", async () => {
    await writeFile(
      join(dir, "T20260512-0001.md"),
      makeWorkItemMd({ id: "T20260512-0001", kind: "task", parentId: "F20260512-0001" }),
      "utf-8",
    );
    await writeFile(join(dir, "garbage.md"), "not yaml frontmatter at all", "utf-8");
    await writeFile(
      join(dir, "T20260512-0002.md"),
      makeWorkItemMd({ id: "T20260512-0002", kind: "task", parentId: "F20260512-0001" }),
      "utf-8",
    );
    const result = await findChildrenByParentId({ dataDir: dir, parentId: "F20260512-0001" });
    expect(result).toEqual(["T20260512-0001", "T20260512-0002"]);
  });

  it("returns empty array when no child file matches the parent_id", async () => {
    await writeFile(
      join(dir, "T20260512-0001.md"),
      makeWorkItemMd({ id: "T20260512-0001", kind: "task", parentId: "F20260512-9999" }),
      "utf-8",
    );
    const result = await findChildrenByParentId({ dataDir: dir, parentId: "F20260512-0001" });
    expect(result).toEqual([]);
  });
});
