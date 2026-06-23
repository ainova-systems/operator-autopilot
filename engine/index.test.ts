import { describe, expect, it } from "vitest";

import { operatorEngineVersion } from "./index.js";

describe("operatorEngineVersion", () => {
  it("returns the foundation version marker", () => {
    expect(operatorEngineVersion).toBe("5.0.0");
  });
});
