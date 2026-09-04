import type { KVEntry, KVStore } from "@operator/core";
import {
  ACTIVE_BOARD_STATUSES,
  boardHistoryCutoff,
  type BoardHistory,
  type BoardWorkItem,
} from "./work-item-board.js";

function toBoardItems(rows: ReadonlyArray<KVEntry>): BoardWorkItem[] {
  return rows.map(({ key, value }) => ({
    key,
    value: value as BoardWorkItem["value"],
  }));
}

/** Load every active item plus only terminal/attention items inside the selected history window. */
export async function loadBoardWorkItems(
  kv: KVStore,
  history: BoardHistory,
  now = Date.now(),
): Promise<BoardWorkItem[]> {
  if (history === "all") return toBoardItems(await kv.list("work-items"));

  const cutoff = boardHistoryCutoff(history, now);
  const [active, activeByDevelop, recentEvents, recentCreations] = await Promise.all([
    kv.list("work-items", { whereIn: { status: ACTIVE_BOARD_STATUSES } }),
    kv.list("work-items", { whereIn: { developFileStatus: ACTIVE_BOARD_STATUSES } }),
    kv.list("work-items", { whereGte: { lastEventAt: cutoff } }),
    kv.list("work-items", { whereGte: { createdAt: cutoff } }),
  ]);
  const unique = new Map(
    [...active, ...activeByDevelop, ...recentEvents, ...recentCreations].map((row) => [row.key, row]),
  );
  return toBoardItems([...unique.values()]);
}
