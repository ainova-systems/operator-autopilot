import { describe, expect, it } from "vitest";
import {
  boardLaneFor,
  effectiveWorkItemStatus,
  filterBoardItemsByHistory,
  groupBoardItems,
  parseBoardHistory,
  workItemActivityAt,
  type BoardWorkItem,
} from "./work-item-board.js";

describe("work-item board", () => {
  it.each([
    ["pending", "todo"],
    ["in-progress", "in-progress"],
    ["running", "in-progress"],
    ["retry", "in-progress"],
    ["in-review", "review"],
    ["ready-to-merge", "review"],
    ["merged", "done"],
    ["accepted", "done"],
    ["completed", "done"],
    ["approved", "done"],
    ["failed", "attention"],
    ["rejected", "attention"],
    ["cancelled", "attention"],
    ["duplicate", "attention"],
    ["new-status", "attention"],
  ])("maps %s to the %s lane", (status, lane) => {
    expect(boardLaneFor({ status })).toBe(lane);
  });

  it("falls back to the develop-file status", () => {
    expect(effectiveWorkItemStatus({ developFileStatus: "RUNNING" })).toBe("running");
    expect(boardLaneFor({ developFileStatus: "RUNNING" })).toBe("in-progress");
    expect(effectiveWorkItemStatus({})).toBe("unknown");
    expect(boardLaneFor({})).toBe("attention");
  });

  it("prefers domain activity and sorts every lane newest first", () => {
    const items: BoardWorkItem[] = [
      {
        key: "older",
        value: { status: "pending", lastEventAt: "2026-01-01T00:00:00Z" },
      },
      {
        key: "newer",
        value: {
          status: "pending",
          lastEventAt: "2026-02-01T00:00:00Z",
          createdAt: "2025-01-01T00:00:00Z",
        },
      },
      {
        key: "created-only",
        value: { status: "pending", createdAt: "2025-12-01T00:00:00Z" },
      },
      { key: "no-activity", value: { status: "pending" } },
    ];

    expect(workItemActivityAt(items[1]!.value)).toBe("2026-02-01T00:00:00Z");
    expect(workItemActivityAt(items[2]!.value)).toBe("2025-12-01T00:00:00Z");
    expect(workItemActivityAt(items[3]!.value)).toBeUndefined();
    expect(groupBoardItems(items).todo.map(({ key }) => key)).toEqual([
      "newer",
      "older",
      "created-only",
      "no-activity",
    ]);
  });

  it("defaults invalid history values to 30 days", () => {
    expect(parseBoardHistory(undefined)).toBe("30");
    expect(parseBoardHistory("invalid")).toBe("30");
    expect(parseBoardHistory("7")).toBe("7");
    expect(parseBoardHistory("all")).toBe("all");
  });

  it("filters only old Done and Needs attention items", () => {
    const now = Date.parse("2026-06-30T00:00:00Z");
    const items: BoardWorkItem[] = [
      { key: "old-done", value: { status: "completed", lastEventAt: "2026-05-01T00:00:00Z" } },
      { key: "recent-done", value: { status: "merged", lastEventAt: "2026-06-15T00:00:00Z" } },
      { key: "old-attention", value: { status: "failed", lastEventAt: "2026-05-01T00:00:00Z" } },
      { key: "old-active", value: { status: "running", lastEventAt: "2026-01-01T00:00:00Z" } },
      { key: "undated-attention", value: { status: "rejected" } },
      { key: "invalid-date", value: { status: "completed", lastEventAt: "unknown" } },
    ];

    expect(filterBoardItemsByHistory(items, "30", now).map(({ key }) => key)).toEqual([
      "recent-done",
      "old-active",
      "undated-attention",
      "invalid-date",
    ]);
    expect(filterBoardItemsByHistory(items, "all", now)).toEqual(items);
  });
});
