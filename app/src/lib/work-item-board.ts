export interface BoardWorkItemValue {
  readonly kind?: string;
  readonly title?: string;
  readonly status?: string;
  readonly developFileStatus?: string;
  readonly priority?: number;
  readonly lastEventAt?: string;
  readonly createdAt?: string;
}

export interface BoardWorkItem {
  readonly key: string;
  readonly value: BoardWorkItemValue;
}

export const BOARD_LANES = [
  {
    id: "todo",
    label: "To do",
    description: "Waiting for the operator",
  },
  {
    id: "in-progress",
    label: "In progress",
    description: "Work currently running",
  },
  {
    id: "review",
    label: "Review",
    description: "Awaiting verification or merge",
  },
  {
    id: "done",
    label: "Done",
    description: "Successfully completed",
  },
  {
    id: "attention",
    label: "Needs attention",
    description: "Stopped or unrecognized state",
  },
] as const;

export type BoardLaneId = (typeof BOARD_LANES)[number]["id"];

export const BOARD_HISTORY_OPTIONS = [
  { value: "7", label: "7 days" },
  { value: "30", label: "30 days" },
  { value: "90", label: "90 days" },
  { value: "all", label: "All" },
] as const;

export type BoardHistory = (typeof BOARD_HISTORY_OPTIONS)[number]["value"];

const DEFAULT_BOARD_HISTORY: BoardHistory = "30";
const HISTORY_FILTERED_LANES = new Set<BoardLaneId>(["done", "attention"]);
const DAY_IN_MS = 24 * 60 * 60 * 1000;

const IN_PROGRESS_STATUSES = new Set(["in-progress", "running", "retry"]);
const REVIEW_STATUSES = new Set(["in-review", "ready-to-merge"]);
const DONE_STATUSES = new Set(["merged", "accepted", "completed", "approved"]);

export const ACTIVE_BOARD_STATUSES = [
  "pending",
  ...IN_PROGRESS_STATUSES,
  ...REVIEW_STATUSES,
] as const;

export function effectiveWorkItemStatus(value: BoardWorkItemValue): string {
  return (value.status ?? value.developFileStatus ?? "unknown").toLowerCase();
}

export function boardLaneFor(value: BoardWorkItemValue): BoardLaneId {
  const status = effectiveWorkItemStatus(value);
  if (status === "pending") return "todo";
  if (IN_PROGRESS_STATUSES.has(status)) return "in-progress";
  if (REVIEW_STATUSES.has(status)) return "review";
  if (DONE_STATUSES.has(status)) return "done";
  return "attention";
}

export function workItemActivityAt(value: BoardWorkItemValue): string | undefined {
  return value.lastEventAt ?? value.createdAt;
}

export function parseBoardHistory(value: string | undefined): BoardHistory {
  return BOARD_HISTORY_OPTIONS.some((option) => option.value === value)
    ? (value as BoardHistory)
    : DEFAULT_BOARD_HISTORY;
}

export function boardHistoryCutoff(history: Exclude<BoardHistory, "all">, now = Date.now()): string {
  return new Date(now - Number(history) * DAY_IN_MS).toISOString();
}

export function filterBoardItemsByHistory(
  items: ReadonlyArray<BoardWorkItem>,
  history: BoardHistory,
  now = Date.now(),
): BoardWorkItem[] {
  if (history === "all") return [...items];

  const cutoff = now - Number(history) * DAY_IN_MS;
  return items.filter((item) => {
    if (!HISTORY_FILTERED_LANES.has(boardLaneFor(item.value))) return true;
    const activity = workItemActivityAt(item.value);
    if (!activity) return true;
    const timestamp = Date.parse(activity);
    return Number.isNaN(timestamp) || timestamp >= cutoff;
  });
}

export function groupBoardItems(
  items: ReadonlyArray<BoardWorkItem>,
): Record<BoardLaneId, BoardWorkItem[]> {
  const grouped: Record<BoardLaneId, BoardWorkItem[]> = {
    todo: [],
    "in-progress": [],
    review: [],
    done: [],
    attention: [],
  };

  for (const item of items) grouped[boardLaneFor(item.value)].push(item);
  for (const laneItems of Object.values(grouped)) {
    laneItems.sort((a, b) =>
      (workItemActivityAt(b.value) ?? "").localeCompare(
        workItemActivityAt(a.value) ?? "",
      ),
    );
  }
  return grouped;
}
