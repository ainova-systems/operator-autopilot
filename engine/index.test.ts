import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { ConfigError } from "@operator/core";

import { loadPackageVersion, operatorEngineVersion } from "./index.js";

const packageVersion = (
  JSON.parse(
    readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf8"),
  ) as { version: string }
).version;

describe("operatorEngineVersion", () => {
  it("matches the package.json version", () => {
    expect(operatorEngineVersion).toBe(packageVersion);
  });
});

describe("loadPackageVersion", () => {
  it("throws a path-anchored ConfigError when package.json is missing", () => {
    const missingPath = join(tmpdir(), "operator-missing-package.json");

    expect(() => loadPackageVersion(missingPath)).toThrow(ConfigError);
    expect(() => loadPackageVersion(missingPath)).toThrow(
      `Failed to read package version from ${missingPath}`,
    );
  });

  it("throws a path-anchored ConfigError when package.json contains invalid JSON", () => {
    const dir = mkdtempSync(join(tmpdir(), "operator-invalid-json-"));
    const packageJsonPath = join(dir, "package.json");
    writeFileSync(packageJsonPath, "{not-json");

    expect(() => loadPackageVersion(packageJsonPath)).toThrow(ConfigError);
    expect(() => loadPackageVersion(packageJsonPath)).toThrow(
      `Failed to parse package version from ${packageJsonPath}: invalid JSON`,
    );
  });

  it("throws a path-anchored ConfigError when version is missing or invalid", () => {
    const dir = mkdtempSync(join(tmpdir(), "operator-invalid-version-"));
    const packageJsonPath = join(dir, "package.json");
    writeFileSync(packageJsonPath, JSON.stringify({ name: "operator" }));

    expect(() => loadPackageVersion(packageJsonPath)).toThrow(ConfigError);
    expect(() => loadPackageVersion(packageJsonPath)).toThrow(
      `Failed to load package version from ${packageJsonPath}: "version" must be a non-empty string`,
    );
  });
});
