import type { KVEntry, KVListFilter, KVStore } from "@operator/core";
import { describe, expect, it, vi } from "vitest";
import { loadBoardWorkItems } from "./work-item-board-data.js";

function row(key: string): KVEntry {
  return { key, value: { status: "pending" } };
}

describe("loadBoardWorkItems", () => {
  it("loads all rows only when the user explicitly selects all history", async () => {
    const list = vi.fn().mockResolvedValue([row("all")]);
    const items = await loadBoardWorkItems({ list } as unknown as KVStore, "all");
    expect(items.map((item) => item.key)).toEqual(["all"]);
    expect(list).toHaveBeenCalledWith("work-items");
  });

  it("combines active and recent indexed queries without duplicates", async () => {
    const list = vi.fn().mockImplementation(
      async (_category: string, filter: KVListFilter): Promise<KVEntry[]> => {
        if (filter.whereIn?.status) return [row("active")];
        if (filter.whereIn?.developFileStatus) return [row("legacy-active")];
        if (filter.whereGte?.lastEventAt) return [row("recent"), row("active")];
        return [row("created")];
      },
    );
    const items = await loadBoardWorkItems(
      { list } as unknown as KVStore,
      "30",
      Date.parse("2026-09-04T00:00:00.000Z"),
    );
    expect(items.map((item) => item.key)).toEqual([
      "active",
      "legacy-active",
      "recent",
      "created",
    ]);
    expect(list).toHaveBeenCalledWith("work-items", {
      whereGte: { lastEventAt: "2026-08-05T00:00:00.000Z" },
    });
  });
});
