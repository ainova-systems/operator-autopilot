import type { KVStore } from "@operator/core";
import { describe, expect, it } from "vitest";
import {
  loadWorkItemKindPresentations,
  resolveWorkItemKindPresentation,
  workItemKindBadgeStyle,
} from "./work-item-kind-presentation.js";

function kvWithKinds(rows: ReadonlyArray<{ readonly key: string; readonly value: unknown }>): KVStore {
  return {
    list: async (category: string) => {
      expect(category).toBe("work-item-kinds");
      return rows;
    },
  } as unknown as KVStore;
}

describe("work-item kind presentation", () => {
  it("prefers DB values and normalizes the color", () => {
    expect(
      resolveWorkItemKindPresentation(
        "task",
        { label: "Custom task", color: "#2563eb" },
        { label: "Task", color: "#000000" },
      ),
    ).toEqual({ label: "Custom task", color: "#2563EB" });
  });

  it("fills missing DB presentation from the shipped baseline", () => {
    expect(
      resolveWorkItemKindPresentation(
        "finding",
        { label: "Finding" },
        { label: "Baseline finding", color: "#B45309" },
      ),
    ).toEqual({ label: "Finding", color: "#B45309" });
  });

  it("falls back to the raw kind and rejects unsafe colors", () => {
    expect(resolveWorkItemKindPresentation("custom", { color: "red" }, undefined)).toEqual({
      label: "custom",
      color: undefined,
    });
    expect(workItemKindBadgeStyle("red")).toBeUndefined();
  });

  it("chooses readable foregrounds for configured colors", () => {
    expect(workItemKindBadgeStyle("#2563EB")).toEqual({
      backgroundColor: "#2563EB",
      borderColor: "#2563EB",
      color: "#FFFFFF",
    });
    expect(workItemKindBadgeStyle("#FDE047")?.color).toBe("#111827");
  });

  it("loads complete presentation values from KV", async () => {
    const presentations = await loadWorkItemKindPresentations(
      kvWithKinds([{ key: "task", value: { label: "Task", color: "#2563EB" } }]),
      new Set(["task"]),
    );

    expect(presentations.get("task")).toEqual({ label: "Task", color: "#2563EB" });
  });

  it("fills older KV rows from baseline and tolerates custom kinds", async () => {
    const presentations = await loadWorkItemKindPresentations(
      kvWithKinds([{ key: "finding", value: { label: "Custom finding" } }]),
      new Set(["finding", "custom-kind"]),
    );

    expect(presentations.get("finding")).toEqual({
      label: "Custom finding",
      color: "#B45309",
    });
    expect(presentations.get("custom-kind")).toEqual({
      label: "custom-kind",
      color: undefined,
    });
  });
});
