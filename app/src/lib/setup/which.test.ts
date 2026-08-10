import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { findOnPath, readEnvVar } from "./which.js";

let root: string;
let binDir: string;
let otherDir: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "operator-which-"));
  binDir = join(root, "bin");
  otherDir = join(root, "other");
  mkdirSync(binDir, { recursive: true });
  mkdirSync(otherDir, { recursive: true });
  mkdirSync(join(binDir, "notafile"), { recursive: true });

  writeFileSync(join(binDir, "claude.CMD"), "@echo off\n");
  writeFileSync(join(binDir, "shimonly"), "#!/bin/sh\n");
  writeFileSync(join(binDir, "posixtool"), "#!/bin/sh\n");
  chmodSync(join(binDir, "posixtool"), 0o755);
  writeFileSync(join(binDir, "notexec"), "plain text\n");
  chmodSync(join(binDir, "notexec"), 0o644);
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("findOnPath — win32", () => {
  const win = { platform: "win32" as const };

  it("resolves a bare command through PATHEXT", () => {
    const found = findOnPath("claude", {
      ...win,
      env: { PATH: binDir, PATHEXT: ".EXE;.CMD" },
    });
    expect(found).toBe(join(binDir, "claude.CMD"));
  });

  it("reads a lowercase Path variable, as Windows spells it", () => {
    const found = findOnPath("claude", {
      ...win,
      env: { Path: binDir, PATHEXT: ".CMD" },
    });
    expect(found).toBe(join(binDir, "claude.CMD"));
  });

  it("falls back to the default PATHEXT list when the variable is unset", () => {
    const found = findOnPath("claude", { ...win, env: { PATH: binDir } });
    expect(found).toBe(join(binDir, "claude.CMD"));
  });

  it("still finds an extension-less shim after every PATHEXT candidate misses", () => {
    const found = findOnPath("shimonly", { ...win, env: { PATH: binDir, PATHEXT: ".CMD" } });
    expect(found).toBe(join(binDir, "shimonly"));
  });

  it("scans every PATH segment in order", () => {
    const found = findOnPath("claude", {
      ...win,
      env: { PATH: [otherDir, binDir].join(delimiter), PATHEXT: ".CMD" },
    });
    expect(found).toBe(join(binDir, "claude.CMD"));
  });

  it("returns null for a command that is not installed", () => {
    expect(findOnPath("definitely-missing", { ...win, env: { PATH: binDir } })).toBeNull();
  });
});

describe("findOnPath — posix", () => {
  const posix = { platform: "linux" as const };

  it("resolves an executable file on PATH", () => {
    const found = findOnPath("posixtool", { ...posix, env: { PATH: binDir } });
    expect(found).toBe(join(binDir, "posixtool"));
  });

  // Windows ignores the POSIX execute bit — accessSync(X_OK) succeeds for any
  // readable file — so the negative case is only meaningful off win32.
  it.skipIf(process.platform === "win32")("rejects a file without the execute bit", () => {
    expect(findOnPath("notexec", { ...posix, env: { PATH: binDir } })).toBeNull();
  });
});

describe("findOnPath — edge cases", () => {
  it("treats a path-shaped argument as a direct file probe", () => {
    // join() always yields a separator, so the argument is path-shaped on
    // every host — that is exactly the branch under test.
    const direct = join(binDir, "posixtool");
    expect(findOnPath(direct, { platform: "win32", env: {} })).toBe(direct);
  });

  it("returns null when a path-shaped argument does not exist", () => {
    expect(findOnPath(`${binDir}/nope`, { platform: "win32", env: {} })).toBeNull();
  });

  it("returns null when PATH is empty", () => {
    expect(findOnPath("claude", { platform: "win32", env: {} })).toBeNull();
  });

  it("skips empty PATH segments", () => {
    const found = findOnPath("claude", {
      platform: "win32",
      env: { PATH: `${delimiter}${binDir}${delimiter}`, PATHEXT: ".CMD" },
    });
    expect(found).toBe(join(binDir, "claude.CMD"));
  });

  it("never matches a directory that shares the command name", () => {
    expect(findOnPath("notafile", { platform: "win32", env: { PATH: binDir, PATHEXT: ".CMD" } })).toBeNull();
  });

  it("defaults to the live process env and platform", () => {
    expect(() => findOnPath("operator-nonexistent-binary")).not.toThrow();
  });
});

describe("readEnvVar", () => {
  it("prefers an exact key match", () => {
    expect(readEnvVar({ PATH: "exact", Path: "fuzzy" }, "PATH")).toBe("exact");
  });

  it("falls back to a case-insensitive match", () => {
    expect(readEnvVar({ path: "fuzzy" }, "PATH")).toBe("fuzzy");
  });

  it("returns undefined when nothing matches", () => {
    expect(readEnvVar({ HOME: "/root" }, "PATH")).toBeUndefined();
  });
});
