import { ListChecks } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { CodeBlock } from "@/components/shared/code-view";
import { CopyJsonButton } from "@/components/shared/copy-json-button";
import { EmptyState } from "@/components/shared/empty-state";
import { InlineActions } from "@/components/shared/inline-actions";
import { PageContainer } from "@/components/shared/page-container";
import { PageHeader } from "@/components/shared/page-header";
import { RefreshButton } from "@/components/shared/refresh-button";
import { getActiveKV } from "@/lib/active-kv-registry";

interface RouteProps {
  readonly params: Promise<{ readonly id: string }>;
}

export default async function WorkItemDebugPage({
  params,
}: RouteProps): Promise<React.ReactElement> {
  const { id } = await params;
  const decoded = decodeURIComponent(id);
  const active = await getActiveKV();
  if (!active) {
    return (
      <PageContainer>
        <EmptyState
          icon={ListChecks}
          title="No connection selected"
          description="Select a connection from the left rail or add a new one."
        />
      </PageContainer>
    );
  }

  const entry = await active.kv.get("work-items", decoded);
  if (!entry) {
    return (
      <PageContainer>
        <PageHeader
          title="Work item not found"
          backHref={`/work-items/${encodeURIComponent(decoded)}`}
        />
        <EmptyState title={`No work item at ${decoded}`} />
      </PageContainer>
    );
  }

  const debugPayload = {
    key: decoded,
    metadata: entry.metadata ?? null,
    value: entry.value,
  };

  return (
    <PageContainer>
      <PageHeader
        title={`${decoded} · debug`}
        backHref={`/work-items/${encodeURIComponent(decoded)}`}
        backLabel="Back to work item"
        description="Raw KV metadata and value for this work item."
        actions={
          <InlineActions>
            <RefreshButton />
            <CopyJsonButton payload={debugPayload} label="Copy JSON" />
          </InlineActions>
        }
      />

      <div className="space-y-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-3">
            <CardTitle className="text-base">Metadata</CardTitle>
            {entry.metadata ? (
              <Badge variant="secondary">{entry.metadata.source}</Badge>
            ) : null}
          </CardHeader>
          <CardContent>
            <CodeBlock content={JSON.stringify(entry.metadata ?? {}, null, 2)} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Raw value</CardTitle>
          </CardHeader>
          <CardContent>
            <CodeBlock content={JSON.stringify(entry.value, null, 2)} />
          </CardContent>
        </Card>
      </div>

      <p className="mt-4 text-xs text-muted-foreground">
        Resync via CLI:{" "}
        <code className="font-mono">npx tsx engine/entry.ts --once --repo &lt;id&gt;</code>{" "}
        (<code>syncFromFiles</code> rewrites this row from develop + VCS labels).
      </p>
    </PageContainer>
  );
}
