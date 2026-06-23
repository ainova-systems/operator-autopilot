import Link from "next/link";
import { Settings2, Plus } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { CopyJsonButton } from "@/components/shared/copy-json-button";
import { EmptyState } from "@/components/shared/empty-state";
import { InlineActions } from "@/components/shared/inline-actions";
import { PageContainer } from "@/components/shared/page-container";
import { PageHeader } from "@/components/shared/page-header";
import { RefreshButton } from "@/components/shared/refresh-button";
import { SourceBadge } from "@/components/features/config/source-badge";
import { DeleteRowButton } from "@/components/features/config/delete-row-button";
import { getActiveKV } from "@/lib/active-kv-registry";

const KNOWN_CATEGORIES = new Set([
  "prompts",
  "templates",
  "agent-roles",
  "workflow-stages",
  "work-item-kinds",
  "reviewer-criteria",
  "analyzers",
  "repos",
]);

interface RouteProps {
  readonly params: Promise<{ readonly category: string }>;
}

export default async function ConfigCategoryPage({
  params,
}: RouteProps): Promise<React.ReactElement> {
  const { category } = await params;
  const active = await getActiveKV();
  if (!active) {
    return (
      <PageContainer>
        <EmptyState
          icon={Settings2}
          title="No connection selected"
          description="Select a connection from the left rail or add a new one."
        />
      </PageContainer>
    );
  }

  if (!KNOWN_CATEGORIES.has(category)) {
    return (
      <PageContainer>
        <PageHeader title="Unknown category" backHref="/config" />
        <EmptyState title={`No such category: ${category}`} />
      </PageContainer>
    );
  }

  const rows = await active.kv.list(category);

  return (
    <PageContainer>
      <PageHeader
        title={category}
        backHref="/config"
        backLabel="Back to config"
        description={`${rows.length} ${rows.length === 1 ? "entry" : "entries"}`}
        actions={
          <InlineActions>
            <RefreshButton />
            {rows.length > 0 ? (
              <CopyJsonButton
                payload={rows.map((r) => ({
                  key: r.key,
                  metadata: r.metadata ?? null,
                  value: r.value,
                }))}
                label={`Copy ${rows.length}`}
              />
            ) : null}
            {category === "repos" ? (
              <Link
                href={`/config/${category}/new`}
                className="inline-flex items-center justify-center gap-1 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90 focus:outline-none focus:ring-2 focus:ring-primary"
              >
                <Plus className="h-4 w-4" />
                New repo
              </Link>
            ) : null}
          </InlineActions>
        }
      />

      {rows.length === 0 ? (
        <EmptyState
          title={`No ${category} entries`}
          description="Run the engine against this connection to seed this category."
          dashed
        />
      ) : (
        <div className="rounded-lg border bg-card">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Key</TableHead>
                <TableHead>Source</TableHead>
                <TableHead>Readonly</TableHead>
                <TableHead>Baseline</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => (
                <TableRow key={r.key}>
                  <TableCell className="whitespace-nowrap">
                    <Link
                      href={`/config/${category}/${encodeURIComponent(r.key)}`}
                      className="whitespace-nowrap font-mono text-xs text-primary hover:underline"
                    >
                      {r.key}
                    </Link>
                  </TableCell>
                  <TableCell>
                    <SourceBadge source={r.metadata?.source} />
                  </TableCell>
                  <TableCell>
                    {r.metadata?.readonly ? (
                      <Badge variant="outline">readonly</Badge>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell>
                    {r.metadata?.modifiedFromBaseline ? (
                      <Badge
                        variant="warning"
                        title="Current KV value differs from the shipped engine/content/ baseline"
                      >
                        modified
                      </Badge>
                    ) : (
                      <span className="text-muted-foreground">baseline</span>
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    {/* Delete is offered for instance/UI rows (repos,
                        UI-added entries) but hidden for shipped `content`
                        baselines, where "Reset to baseline" on the edit
                        page is the right action — deleting one only
                        triggers a re-seed on the next engine boot. */}
                    {r.metadata?.readonly !== true &&
                    r.metadata?.source !== "content" ? (
                      <DeleteRowButton category={category} rowKey={r.key} />
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </PageContainer>
  );
}
