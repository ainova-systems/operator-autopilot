import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { operatorEngineVersion } from "./index.js";

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
