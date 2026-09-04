import Link from "next/link";
import { redirect } from "next/navigation";
import { Link2Off } from "lucide-react";
import { EmptyState } from "@/components/shared/empty-state";
import { PageContainer } from "@/components/shared/page-container";
import { buttonVariants } from "@/components/ui/button";
import { getActiveKV } from "@/lib/active-kv-registry";
import { listConnections } from "@/lib/connections";

export const dynamic = "force-dynamic";

export default async function ShellIndex(): Promise<React.ReactElement> {
  const active = await getActiveKV();
  if (active) {
    redirect("/board");
  }
  const connections = await listConnections();
  if (connections.length === 0) {
    return (
      <PageContainer>
        <EmptyState
          icon={Link2Off}
          title="Set up this instance"
          description={
            <>
              <p className="m-0">
                Setup walks through the four things a first run needs: an engine state
                database, a host that has the agent CLIs and a working token, a managed
                repository, and the first cycle.
              </p>
              <p className="m-0 mt-2 text-xs">
                Already have an engine running? Add its <code>state/operator.db</code> from the
                left rail instead.
              </p>
            </>
          }
        >
          <Link href="/setup" className={buttonVariants()}>
            Start setup
          </Link>
        </EmptyState>
      </PageContainer>
    );
  }
  return (
    <PageContainer>
      <EmptyState
        icon={Link2Off}
        title="Select a connection"
        description="Pick a connection from the left rail to view its work items and executions."
      >
        <Link href="/setup" className={buttonVariants({ variant: "outline" })}>
          Open setup
        </Link>
      </EmptyState>
    </PageContainer>
  );
}
