import { describe, it, expect, vi } from "vitest";
import { iterateBestEffort } from "./analyzer-iteration.js";

describe("iterateBestEffort", () => {
  it("returns zero counts and an empty results array for an empty input", async () => {
    const perItem = vi.fn();
    const out = await iterateBestEffort<string, string>([], perItem);
    expect(out.successCount).toBe(0);
    expect(out.failureCount).toBe(0);
    expect(out.results).toEqual([]);
    expect(perItem).not.toHaveBeenCalled();
  });

  it("counts every resolved item as a success and accumulates non-null results in order", async () => {
    const out = await iterateBestEffort(["a", "b", "c"], async (item) => `${item.toUpperCase()}!`);
    expect(out.successCount).toBe(3);
    expect(out.failureCount).toBe(0);
    expect(out.results).toEqual(["A!", "B!", "C!"]);
  });

  it("treats a null return as success-with-no-result (no entry pushed but successCount bumps)", async () => {
    const out = await iterateBestEffort<string, string>(["a", "b"], async (item) => (item === "a" ? "kept" : null));
    expect(out.successCount).toBe(2);
    expect(out.failureCount).toBe(0);
    expect(out.results).toEqual(["kept"]);
  });

  it("treats an undefined return the same as null", async () => {
    const out = await iterateBestEffort<string, string>(
      ["a", "b"],
      async (item) => (item === "a" ? "kept" : undefined),
    );
    expect(out.successCount).toBe(2);
    expect(out.failureCount).toBe(0);
    expect(out.results).toEqual(["kept"]);
  });

  it("catches a thrown error and routes it through onItemError without stopping iteration", async () => {
    const errors: Array<{ item: string; msg: string }> = [];
    const out = await iterateBestEffort(
      ["a", "boom", "c"],
      async (item) => {
        if (item === "boom") throw new Error("kaboom");
        return item.toUpperCase();
      },
      { onItemError: (item, err) => errors.push({ item, msg: err instanceof Error ? err.message : String(err) }) },
    );
    expect(out.successCount).toBe(2);
    expect(out.failureCount).toBe(1);
    expect(out.results).toEqual(["A", "C"]);
    expect(errors).toEqual([{ item: "boom", msg: "kaboom" }]);
  });

  it("works without an onItemError hook — failures are silently counted", async () => {
    const out = await iterateBestEffort(
      ["a", "b"],
      async (item) => {
        if (item === "b") throw new Error("nope");
        return item;
      },
    );
    expect(out.successCount).toBe(1);
    expect(out.failureCount).toBe(1);
    expect(out.results).toEqual(["a"]);
  });

  it("preserves iteration order across mixed success / failure / null returns", async () => {
    const events: string[] = [];
    const out = await iterateBestEffort<string, string>(
      ["a", "b", "c", "d", "e"],
      async (item) => {
        events.push(`run:${item}`);
        if (item === "b") throw new Error("b broke");
        if (item === "d") return null;
        return item.toUpperCase();
      },
      { onItemError: (item) => events.push(`fail:${item}`) },
    );
    expect(events).toEqual(["run:a", "run:b", "fail:b", "run:c", "run:d", "run:e"]);
    expect(out.successCount).toBe(4);
    expect(out.failureCount).toBe(1);
    expect(out.results).toEqual(["A", "C", "E"]);
  });
});
