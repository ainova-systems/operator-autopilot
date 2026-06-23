import { notFound, redirect } from "next/navigation";
import { Settings2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/shared/empty-state";
import { InlineActions } from "@/components/shared/inline-actions";
import { PageContainer } from "@/components/shared/page-container";
import { PageHeader } from "@/components/shared/page-header";
import { ConfigEditForm } from "@/components/features/config/config-edit-form";
import { SourceBadge } from "@/components/features/config/source-badge";
import { getActiveKV } from "@/lib/active-kv-registry";
import { isKnownCategory } from "@/lib/kv-write";

interface RouteProps {
  readonly params: Promise<{ readonly category: string; readonly key: string }>;
}

function readonlyReason(meta: { readonly?: boolean } | undefined): string | undefined {
  if (meta?.readonly) {
    return "This row is flagged readonly by its source — see metadata.readonly.";
  }
  return undefined;
}

export default async function ConfigEntryEditPage({
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
  if (!isKnownCategory(category)) return notFound();

  const entry = await active.kv.get(category, decodedKey);
  if (!entry) {
    return (
      <PageContainer>
        <PageHeader
          title="Entry not found"
          backHref={`/config/${category}/${encodeURIComponent(decodedKey)}`}
        />
        <EmptyState title={`No entry at ${decodedKey}`} />
      </PageContainer>
    );
  }

  const meta = entry.metadata;
  // 2026-05-20 (Phase 5 P-502 partial): the `source: "yaml"` block was
  // removed. yaml rows are now editable from the UI — the first save
  // flips `source` to `ui` and the seed mirror leaves the row alone on
  // subsequent boots. Only an explicit `readonly: true` keeps a row
  // pinned to the file (no UI category sets this today).
  const isReadonly = meta?.readonly === true;
  if (isReadonly) {
    redirect(`/config/${category}/${encodeURIComponent(decodedKey)}`);
  }
  const canReset = meta?.modifiedFromBaseline === true || meta?.source === "ui";

  return (
    <PageContainer>
      <PageHeader
        title={`Edit ${category}/${decodedKey}`}
        backHref={`/config/${category}/${encodeURIComponent(decodedKey)}`}
        backLabel="Back to entry"
      />

      {meta ? (
        <InlineActions className="mb-4 flex-wrap">
          <SourceBadge source={meta.source} />
          {meta.readonly ? <Badge variant="outline">readonly</Badge> : null}
          <span className="text-xs text-muted-foreground">
            version {meta.version ?? 0}
          </span>
        </InlineActions>
      ) : null}

      <ConfigEditForm
        category={category}
        rowKey={decodedKey}
        initialValue={entry.value}
        initialVersion={meta?.version ?? 0}
        readonly={isReadonly}
        readonlyReason={readonlyReason(meta)}
        canReset={canReset}
      />
    </PageContainer>
  );
}
