import { StatusBar } from "@/components/shared/status-bar";
import { loadStatusBarCounts } from "@/lib/status-bar-data";

export async function StatusBarSlot(): Promise<React.ReactElement> {
  const counts = await loadStatusBarCounts();
  const items: React.ReactNode[] = [
    counts.activeName ? (
      <span key="active">
        <span className="text-foreground">{counts.activeName}</span>
      </span>
    ) : (
      <span key="active">No active connection</span>
    ),
    <span key="work-items">{counts.workItems} work items</span>,
    <span key="executions">{counts.executions} executions</span>,
    <span key="connections">{counts.connections} connections</span>,
  ];
  return <StatusBar items={items} />;
}
