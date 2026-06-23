import { ConnectionsManager } from "@/components/connections/connections-manager";
import { PageContainer } from "@/components/shared/page-container";
import { PageHeader } from "@/components/shared/page-header";
import { getActiveConnectionState, listConnections } from "@/lib/connections";

export default async function ConnectionsPage(): Promise<React.ReactElement> {
  const [connections, activeState] = await Promise.all([
    listConnections(),
    getActiveConnectionState(),
  ]);
  return (
    <PageContainer>
      <PageHeader
        title="Connections"
        description="Each connection points at an Operator instance's SQLite state file. Switch between connections to observe different environments without restarting the app."
      />
      <ConnectionsManager
        connections={connections}
        activeId={activeState?.id ?? null}
      />
    </PageContainer>
  );
}
