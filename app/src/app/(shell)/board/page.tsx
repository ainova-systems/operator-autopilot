import Link from "next/link";
import { Columns3, List } from "lucide-react";
import { EmptyState } from "@/components/shared/empty-state";
import { WorkItemKindBadge } from "@/components/features/work-items/work-item-kind-badge";
import { InlineActions } from "@/components/shared/inline-actions";
import { PageContainer } from "@/components/shared/page-container";
import { PageHeader } from "@/components/shared/page-header";
import { RefreshButton } from "@/components/shared/refresh-button";
import { Badge, type BadgeProps } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { getActiveKV } from "@/lib/active-kv-registry";
import {
  loadWorkItemKindPresentations,
  type WorkItemKindPresentation,
} from "@/lib/work-item-kind-presentation";
import {
  BOARD_HISTORY_OPTIONS,
  BOARD_LANES,
  effectiveWorkItemStatus,
  filterBoardItemsByHistory,
  groupBoardItems,
  parseBoardHistory,
  workItemActivityAt,
  type BoardWorkItem,
} from "@/lib/work-item-board";
import { loadBoardWorkItems } from "@/lib/work-item-board-data";

export const dynamic = "force-dynamic";

type BadgeVariant = BadgeProps["variant"];

function statusVariant(status: string): BadgeVariant {
  if (["merged", "accepted", "completed", "approved"].includes(status)) return "success";
  if (["failed", "rejected", "cancelled", "duplicate", "error"].includes(status)) {
    return "destructive";
  }
  if (["pending", "running", "retry", "in-progress"].includes(status)) return "warning";
  return "secondary";
}

function formatActivity(value: string | undefined): string {
  if (!value) return "No activity yet";
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return value;
  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
    year: date.getFullYear() === new Date().getFullYear() ? undefined : "numeric",
  }).format(date);
}

function WorkItemCard({
  item,
  kindPresentation,
}: {
  readonly item: BoardWorkItem;
  readonly kindPresentation: WorkItemKindPresentation | undefined;
}): React.ReactElement {
  const { key, value } = item;
  const status = effectiveWorkItemStatus(value);
  const activity = workItemActivityAt(value);

  return (
    <Link
      href={`/work-items/${encodeURIComponent(key)}`}
      className="group block rounded-lg border bg-card p-3 text-card-foreground shadow-sm transition hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <div className="mb-2 flex items-start gap-2">
        <code className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground">
          {key}
        </code>
        <Badge variant={statusVariant(status)} className="shrink-0 px-2 py-0 text-[10px]">
          {status}
        </Badge>
      </div>
      <h3 className="m-0 text-sm font-medium leading-snug group-hover:text-primary">
        {value.title ?? "Untitled work item"}
      </h3>
      <div className="mt-3 flex items-center gap-2 text-xs text-muted-foreground">
        <WorkItemKindBadge kind={value.kind} presentation={kindPresentation} />
        {value.priority != null ? <span>Priority {value.priority}</span> : null}
        <time className="ml-auto" dateTime={activity} title={activity}>
          {formatActivity(activity)}
        </time>
      </div>
    </Link>
  );
}

interface BoardPageProps {
  readonly searchParams?: Promise<{ readonly history?: string }>;
}

export default async function BoardPage({
  searchParams,
}: BoardPageProps): Promise<React.ReactElement> {
  const active = await getActiveKV();
  if (!active) {
    return (
      <PageContainer>
        <EmptyState
          icon={Columns3}
          title="No connection selected"
          description="Select a connection from the left rail or add a new one."
        />
      </PageContainer>
    );
  }

  const query = await (
    searchParams ?? Promise.resolve<{ readonly history?: string }>({})
  );
  const history = parseBoardHistory(query.history);
  const items = await loadBoardWorkItems(active.kv, history);
  const visibleItems = filterBoardItemsByHistory(items, history);
  const kindPresentations = await loadWorkItemKindPresentations(
    active.kv,
    new Set(items.flatMap(({ value }) => (value.kind ? [value.kind] : []))),
  );
  const grouped = groupBoardItems(visibleItems);

  return (
    <PageContainer className="flex flex-col overflow-hidden">
      <PageHeader
        title="Board"
        description={`${visibleItems.length} work items shown, grouped by lifecycle`}
        actions={
          <InlineActions>
            <Link href="/work-items" className={buttonVariants({ variant: "outline" })}>
              <List className="mr-2 h-4 w-4" />
              List
            </Link>
            <RefreshButton />
          </InlineActions>
        }
      />

      <div className="mb-4 flex flex-wrap items-center gap-2" aria-label="Board history filter">
        <span className="mr-1 text-xs font-medium text-muted-foreground">
          Done &amp; attention history
        </span>
        {BOARD_HISTORY_OPTIONS.map((option) => (
          <Link
            key={option.value}
            href={option.value === "30" ? "/board" : `/board?history=${option.value}`}
            className={buttonVariants({
              variant: history === option.value ? "secondary" : "outline",
              size: "sm",
            })}
          >
            {option.label}
          </Link>
        ))}
        {history !== "all" ? (
          <span className="ml-1 text-xs text-muted-foreground">
            Older Done and Needs attention items are hidden
          </span>
        ) : null}
      </div>

      {items.length === 0 ? (
        <EmptyState
          icon={Columns3}
          title="No work items yet"
          description={
            <>
              Run the engine against this connection (<code>npm run exec</code>) to produce
              findings and tasks.
            </>
          }
          dashed
        />
      ) : (
        <div
          className="grid min-h-0 flex-1 auto-cols-[minmax(18rem,1fr)] grid-flow-col gap-4 overflow-x-auto pb-2"
          aria-label="Work-item board"
        >
          {BOARD_LANES.map((lane) => {
            return (
              <section
                key={lane.id}
                className="flex min-h-0 flex-col rounded-lg border bg-muted/35"
                aria-labelledby={`lane-${lane.id}`}
              >
                <div className="flex items-start gap-3 border-b px-3 py-3">
                  <div className="min-w-0 flex-1">
                    <h2 id={`lane-${lane.id}`} className="m-0 text-sm font-semibold">
                      {lane.label}
                    </h2>
                    <p className="m-0 mt-0.5 truncate text-xs text-muted-foreground">
                      {lane.description}
                    </p>
                  </div>
                  <Badge variant="outline" className="bg-background">
                    {grouped[lane.id].length}
                  </Badge>
                </div>
                <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-2">
                  {grouped[lane.id].length > 0 ? (
                    grouped[lane.id].map((item) => (
                      <WorkItemCard
                        key={item.key}
                        item={item}
                        kindPresentation={
                          item.value.kind ? kindPresentations.get(item.value.kind) : undefined
                        }
                      />
                    ))
                  ) : (
                    <p className="m-0 rounded-md border border-dashed px-3 py-6 text-center text-xs text-muted-foreground">
                      No work items
                    </p>
                  )}
                </div>
              </section>
            );
          })}
        </div>
      )}
    </PageContainer>
  );
}
