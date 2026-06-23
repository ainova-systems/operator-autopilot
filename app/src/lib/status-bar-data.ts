import { getActiveKV } from "./active-kv-registry";
import { listConnections } from "./connections";

export interface StatusBarCounts {
  readonly workItems: number;
  readonly executions: number;
  readonly connections: number;
  readonly activeName: string | null;
}

// Defensive upper bound — StatusBar only displays totals, not row data.
const STATUS_BAR_LIST_LIMIT = 1000;

export async function loadStatusBarCounts(): Promise<StatusBarCounts> {
  const [active, connections] = await Promise.all([
    getActiveKV(),
    listConnections(),
  ]);
  if (!active) {
    return {
      workItems: 0,
      executions: 0,
      connections: connections.length,
      activeName: null,
    };
  }
  const [workItems, executions] = await Promise.all([
    active.kv.list("work-items", { limit: STATUS_BAR_LIST_LIMIT }),
    active.kv.list("executions", { limit: STATUS_BAR_LIST_LIMIT }),
  ]);
  return {
    workItems: workItems.length,
    executions: executions.length,
    connections: connections.length,
    activeName: active.connection.name,
  };
}
