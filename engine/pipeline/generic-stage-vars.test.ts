import { describe, it, expect } from "vitest";
import type { WorkItem } from "@operator/core";
import { substituteVars } from "./generic-stage-vars.js";

const item: WorkItem = {
  id: "T20260420-0001",
  kind: "task",
  title: "Test title",
  body: "Test body content",
  status: "pending",
  priority: 3,
  createdAt: "2026-04-20T10:00:00Z",
  updatedAt: "2026-04-20T10:00:00Z",
};

describe("substituteVars", () => {
  it("substitutes item fields", () => {
    const result = substituteVars(
      { TASK_ID: "${item.id}", TASK_BODY: "${item.body}" },
      { item },
    );
    expect(result).toEqual({
      TASK_ID: "T20260420-0001",
      TASK_BODY: "Test body content",
    });
  });

  it("substitutes scopeKey", () => {
    const result = substituteVars(
      { WEEK: "${scopeKey}" },
      { scopeKey: "2026W17" },
    );
    expect(result).toEqual({ WEEK: "2026W17" });
  });

  it("stringifies numeric fields", () => {
    const result = substituteVars(
      { PRIORITY: "${item.priority}" },
      { item },
    );
    expect(result).toEqual({ PRIORITY: "3" });
  });

  it("preserves literal dollar-brace sequences when path is unknown", () => {
    const result = substituteVars(
      { TEMPLATE: "Hello ${unknown.field} world" },
      { item },
    );
    expect(result.TEMPLATE).toBe("Hello ${unknown.field} world");
  });

  it("refuses to leak arbitrary item fields", () => {
    const result = substituteVars(
      { LEAK: "${item.createdAt}" },
      { item },
    );
    // createdAt is not in the allowlist — token left verbatim.
    expect(result.LEAK).toBe("${item.createdAt}");
  });

  it("leaves token when item is absent", () => {
    const result = substituteVars(
      { X: "${item.id}" },
      { scopeKey: "X" },
    );
    expect(result.X).toBe("${item.id}");
  });

  it("handles multiple substitutions in the same string", () => {
    const result = substituteVars(
      { MSG: "[${item.kind}] ${item.id}: ${item.title}" },
      { item },
    );
    expect(result.MSG).toBe("[task] T20260420-0001: Test title");
  });
});
