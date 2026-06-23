import { redirect } from "next/navigation";
import { Link2Off } from "lucide-react";
import { EmptyState } from "@/components/shared/empty-state";
import { PageContainer } from "@/components/shared/page-container";
import { getActiveKV } from "@/lib/active-kv-registry";
import { listConnections } from "@/lib/connections";

export default async function ShellIndex(): Promise<React.ReactElement> {
  const active = await getActiveKV();
  if (active) {
    redirect("/work-items");
  }
  const connections = await listConnections();
  if (connections.length === 0) {
    return (
      <PageContainer>
        <EmptyState
          icon={Link2Off}
          title="Add your first connection"
          description={
            <>
              <p className="m-0">
                Connect the Operator app to a running engine instance by pointing it at
                that instance&apos;s SQLite state file (usually <code>state/operator.db</code>).
              </p>
              <p className="m-0 mt-2 text-xs">
                Dev tip: set <code>OPERATOR_DB_PATH</code> before starting the app and a
                default connection is auto-created on first request.
              </p>
            </>
          }
        />
      </PageContainer>
    );
  }
  return (
    <PageContainer>
      <EmptyState
        icon={Link2Off}
        title="Select a connection"
        description="Pick a connection from the left rail to view its work items and executions."
      />
    </PageContainer>
  );
}
