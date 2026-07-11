import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

function loadPackageVersion(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const packageJsonPath = resolve(here, "..", "package.json");
  const parsed = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { version: string };
  return parsed.version;
}

export const operatorEngineVersion = loadPackageVersion();
