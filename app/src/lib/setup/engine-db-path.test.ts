import { describe, expect, it } from "vitest";
import { join, resolve } from "node:path";
import { suggestEngineDbPath } from "./engine-db-path.js";

describe("suggestEngineDbPath", () => {
  it("uses OPERATOR_DB_PATH verbatim when the deployment names the file", () => {
    expect(suggestEngineDbPath({ OPERATOR_DB_PATH: "/data/custom.db" })).toBe("/data/custom.db");
  });

  it("prefers OPERATOR_DB_PATH over OPERATOR_DIR", () => {
    const path = suggestEngineDbPath({
      OPERATOR_DB_PATH: "/data/custom.db",
      OPERATOR_DIR: "/var/lib/operator",
    });
    expect(path).toBe("/data/custom.db");
  });

  it("derives state/operator.db from OPERATOR_DIR, as the engine does", () => {
    expect(suggestEngineDbPath({ OPERATOR_DIR: "/var/lib/operator" })).toBe(
      join(resolve("/var/lib/operator"), "state", "operator.db"),
    );
  });

  it("falls back to the monorepo's own state directory", () => {
    const path = suggestEngineDbPath({});
    expect(path.endsWith(join("state", "operator.db"))).toBe(true);
    expect(path).not.toContain(join("app", "state"));
  });
});
