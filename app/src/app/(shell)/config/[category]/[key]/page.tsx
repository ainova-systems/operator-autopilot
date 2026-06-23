import Link from "next/link";
import { Settings2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
import { SourceBadge } from "@/components/features/config/source-badge";
import { getActiveKV } from "@/lib/active-kv-registry";

interface RouteProps {
  readonly params: Promise<{ readonly category: string; readonly key: string }>;
}

export default async function ConfigEntryPage({
  params,
}: RouteProps): Promise<React.ReactElement> {
  const { category, key } = await params;
  const decodedKey = decodeURIComponent(key);
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

  const entry = await active.kv.get(category, decodedKey);
  if (!entry) {
    return (
      <PageContainer>
        <PageHeader
          title="Entry not found"
          backHref={`/config/${category}`}
        />
        <EmptyState title={`No entry at ${decodedKey}`} />
      </PageContainer>
    );
  }

  // yaml-sourced rows are editable from the UI (the first save claims
  // ownership: source flips to `ui` and the seed mirror leaves the row
  // alone) — only an explicit `readonly: true` pins a row to its source.
  // This matches the edit page's gate. Deletion lives on the category
  // list page, not here.
  const isReadonly = entry.metadata?.readonly === true;

  return (
    <PageContainer>
      <PageHeader
        title={`${category}/${decodedKey}`}
        backHref={`/config/${category}`}
        backLabel={`Back to ${category}`}
        actions={
          <InlineActions>
            <RefreshButton />
            <CopyJsonButton
              payload={{
                category,
                key: decodedKey,
                metadata: entry.metadata ?? null,
                value: entry.value,
              }}
              label="Copy JSON"
            />
            {isReadonly ? null : (
              <Link
                href={`/config/${category}/${encodeURIComponent(decodedKey)}/edit`}
              >
                <Button size="sm">Edit</Button>
              </Link>
            )}
          </InlineActions>
        }
      />

      {entry.metadata ? (
        <InlineActions className="mb-4 flex-wrap">
          <SourceBadge source={entry.metadata.source} />
          {entry.metadata.readonly ? (
            <Badge variant="outline">readonly</Badge>
          ) : null}
          {entry.metadata.modifiedFromBaseline ? (
            <Badge
              variant="warning"
              title="Current KV value differs from the shipped engine/content/ baseline"
            >
              modified from baseline
            </Badge>
          ) : null}
          <span className="text-xs text-muted-foreground">
            version {entry.metadata.version ?? 0}
          </span>
        </InlineActions>
      ) : null}

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Value</CardTitle>
        </CardHeader>
        <CardContent>
          <CodeBlock content={JSON.stringify(entry.value, null, 2)} />
        </CardContent>
      </Card>
    </PageContainer>
  );
}
