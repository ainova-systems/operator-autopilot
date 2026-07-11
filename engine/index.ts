import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { ConfigError } from "@operator/core";

export function loadPackageVersion(packageJsonPath?: string): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const resolvedPath = packageJsonPath ?? resolve(here, "..", "package.json");

  let raw: string;
  try {
    raw = readFileSync(resolvedPath, "utf8");
  } catch (cause) {
    throw new ConfigError(
      "package-version-unreadable",
      `Failed to read package version from ${resolvedPath}`,
      { cause },
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new ConfigError(
      "package-version-invalid-json",
      `Failed to parse package version from ${resolvedPath}: invalid JSON`,
      { cause },
    );
  }

  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("version" in parsed) ||
    typeof (parsed as { version: unknown }).version !== "string" ||
    (parsed as { version: string }).version.trim() === ""
  ) {
    throw new ConfigError(
      "package-version-missing",
      `Failed to load package version from ${resolvedPath}: "version" must be a non-empty string`,
    );
  }

  return (parsed as { version: string }).version;
}

export const operatorEngineVersion = loadPackageVersion();
