import { FileClock } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { CodeBlock } from "@/components/shared/code-view";
import { CopyJsonButton } from "@/components/shared/copy-json-button";
import { EmptyState } from "@/components/shared/empty-state";
import { FormRow } from "@/components/shared/form-stack";
import { InlineActions } from "@/components/shared/inline-actions";
import { PageContainer } from "@/components/shared/page-container";
import { PageHeader } from "@/components/shared/page-header";
import { RefreshButton } from "@/components/shared/refresh-button";
import { listAuditLog } from "@/lib/audit-log";
import { getActiveKV } from "@/lib/active-kv-registry";

interface RouteProps {
  readonly searchParams: Promise<{
    readonly category?: string;
    readonly key?: string;
  }>;
}

export default async function AuditPage({
  searchParams,
}: RouteProps): Promise<React.ReactElement> {
  const active = await getActiveKV();
  if (!active) {
    return (
      <PageContainer>
        <EmptyState
          icon={FileClock}
          title="No connection selected"
          description="Select a connection from the left rail or add a new one."
        />
      </PageContainer>
    );
  }
  const { category, key } = await searchParams;
  const rows = await listAuditLog(active.kv, { category, key, limit: 100 });

  return (
    <PageContainer>
      <PageHeader
        title="Audit log"
        description="Every successful edit to a KV row through this app's UI is recorded below. Showing newest first, up to 100 rows."
        actions={
          <InlineActions>
            <RefreshButton />
            {rows.length > 0 ? (
              <CopyJsonButton payload={rows} label={`Copy ${rows.length}`} />
            ) : null}
          </InlineActions>
        }
      />

      <form className="mb-6 flex flex-wrap items-end gap-3">
        <FormRow className="min-w-[16rem] flex-1">
          <Label htmlFor="audit-category">Category</Label>
          <Input
            id="audit-category"
            name="category"
            defaultValue={category ?? ""}
            placeholder="e.g. prompts"
          />
        </FormRow>
        <FormRow className="min-w-[16rem] flex-1">
          <Label htmlFor="audit-key">Key</Label>
          <Input
            id="audit-key"
            name="key"
            defaultValue={key ?? ""}
            placeholder="e.g. agents/creator"
          />
        </FormRow>
        <Button type="submit">Filter</Button>
      </form>

      {rows.length === 0 ? (
        <EmptyState
          icon={FileClock}
          title="No edits yet"
          description="Edit a row through the Config UI and it will show up here with a full diff."
        />
      ) : (
        <div className="space-y-3">
          {rows.map((r) => (
            <Card key={`${r.timestamp}-${r.category}-${r.key}`}>
              <CardHeader className="flex flex-row items-start justify-between gap-4 pb-3">
                <CardTitle className="flex items-center gap-2 text-base">
                  <Badge variant={r.subOp === "delete" ? "destructive" : "secondary"}>
                    {r.subOp}
                  </Badge>
                  <code className="font-mono text-sm">
                    {r.category}/{r.key}
                  </code>
                </CardTitle>
                <span className="flex-shrink-0 text-xs text-muted-foreground">
                  v{r.versionBefore}→v{r.versionAfter} · {r.timestamp}
                </span>
              </CardHeader>
              <CardContent>
                <CodeBlock content={r.diff} />
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </PageContainer>
  );
}
