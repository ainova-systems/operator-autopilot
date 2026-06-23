import Link from "next/link";
import { ListChecks } from "lucide-react";
import { Badge, type BadgeProps } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { CopyJsonButton } from "@/components/shared/copy-json-button";
import { EmptyState } from "@/components/shared/empty-state";
import { InlineActions } from "@/components/shared/inline-actions";
import {
  FacetRow,
  ListToolbar,
  ListToolbarClear,
  ListToolbarMore,
  ListToolbarRow,
  ListToolbarToggle,
} from "@/components/shared/list-toolbar";
import { PageContainer } from "@/components/shared/page-container";
import { PageHeader } from "@/components/shared/page-header";
import { RefreshButton } from "@/components/shared/refresh-button";
import { SortableHeader } from "@/components/shared/sortable-header";
import { WorkItemsSearch } from "@/components/features/work-items/work-items-search";
import { getActiveKV } from "@/lib/active-kv-registry";
import {
  compareByOrder,
  compareNumbers,
  compareStrings,
  parseSort,
  withDirection,
  type SortDir,
  type SortState,
} from "@/lib/sort";

interface WorkItemRow {
  readonly id: string;
  readonly kind?: string;
  readonly title?: string;
  /** Computed status — renders as the row's primary badge. */
  readonly status?: string;
  /** Source label explaining how `status` was computed. */
  readonly statusReason?: string;
  /** Raw develop-file status literal — secondary (debug) badge. */
  readonly developFileStatus?: string;
  readonly priority?: number;
  readonly updatedAt?: string;
  /** Last domain-meaningful event timestamp — primary "activity" sort. */
  readonly lastEventAt?: string;
  readonly createdAt?: string;
  /** Normalized success rate in [0, 1]; absent while item is in flight. */
  readonly successScore?: number;
}

interface Query {
  readonly group?: string;
  readonly q?: string;
  readonly status?: string;
  readonly effective?: string;
  readonly kind?: string;
  readonly sort?: string;
  readonly dir?: string;
}

const SORT_COLUMNS = [
  "id",
  "kind",
  "title",
  "status",
  "develop",
  "score",
  "priority",
  "activity",
] as const;
type SortColumn = (typeof SORT_COLUMNS)[number];

/**
 * Activity timestamp = domain-event timestamp (lastEventAt) when present,
 * otherwise fall back to createdAt so freshly-seeded items still order
 * by their birth time rather than getting parked at "—". updatedAt is
 * intentionally NOT a fallback: it bumps for every cycle re-stamp and
 * would re-cluster all rows on the most recent run.
 */
function activityAt(row: WorkItemRow): string | undefined {
  return row.lastEventAt ?? row.createdAt;
}

interface RouteProps {
  readonly searchParams?: Promise<Query>;
}

type Variant = BadgeProps["variant"];

const STATUS_ORDER = [
  "pending",
  "in-progress",
  "running",
  "in-review",
  "ready-to-merge",
  "rejected",
  "failed",
  "completed",
  "approved",
];

/**
 * Status groups for the toolbar quick filters. Each work-item status
 * maps into exactly one group; items whose status is unknown or absent
 * fall outside every group and are only visible when no group is
 * selected. Per `engine/content/prompts/kinds.yaml`, PR-bound work
 * items (finding, task) carry `merged` as their success terminal —
 * NOT `completed`. The Completed group therefore covers both: `merged`
 * for PR-bound items, `completed`/`approved` for non-PR ones
 * (research, agent-improvement, retrospective-cycle). Likewise
 * Rejected includes `duplicate` since that's a kind-registry terminal
 * unsuccessful status.
 */
const STATUS_GROUPS = {
  active: new Set(["in-progress", "running", "in-review", "ready-to-merge", "retry"]),
  pending: new Set(["pending"]),
  completed: new Set(["merged", "accepted", "completed", "approved"]),
  rejected: new Set(["rejected", "failed", "cancelled", "duplicate"]),
} as const;
type StatusGroup = keyof typeof STATUS_GROUPS;
const STATUS_GROUP_KEYS: readonly StatusGroup[] = ["active", "pending", "completed", "rejected"];

function parseGroup(value: string | undefined): StatusGroup | undefined {
  return STATUS_GROUP_KEYS.find((g) => g === value);
}

function statusGroupOf(value: WorkItemRow): StatusGroup | undefined {
  const s = (value.status ?? value.developFileStatus ?? "").toLowerCase();
  if (!s) return undefined;
  return STATUS_GROUP_KEYS.find((g) => STATUS_GROUPS[g].has(s));
}

function statusVariant(status: string | undefined): Variant {
  if (!status) return "outline";
  const s = status.toLowerCase();
  if (s === "ready-to-merge") return "success";
  if (s === "completed" || s === "approved" || s === "merged" || s === "accepted") return "success";
  if (s === "rejected" || s === "failed" || s === "error" || s === "cancelled") return "destructive";
  if (s === "in-review") return "secondary";
  if (s === "pending" || s === "running" || s === "retry" || s === "in-progress") return "warning";
  return "secondary";
}

function buildHref(base: Query, patch: Partial<Query>): string {
  const merged = { ...base, ...patch };
  const qs = new URLSearchParams();
  if (merged.group) qs.set("group", merged.group);
  if (merged.q) qs.set("q", merged.q);
  if (merged.status) qs.set("status", merged.status);
  if (merged.effective) qs.set("effective", merged.effective);
  if (merged.kind) qs.set("kind", merged.kind);
  if (merged.sort) qs.set("sort", merged.sort);
  if (merged.dir) qs.set("dir", merged.dir);
  const s = qs.toString();
  return s ? `/work-items?${s}` : "/work-items";
}

type Item = { readonly key: string; readonly value: WorkItemRow };

interface AppliedFilters {
  readonly group?: StatusGroup;
  readonly q: string;
  readonly status?: string;
  readonly effective?: string;
  readonly kind?: string;
}

function applyFilters(items: ReadonlyArray<Item>, f: AppliedFilters): Item[] {
  let r: Item[] = [...items];
  if (f.group) r = r.filter(({ value }) => statusGroupOf(value) === f.group);
  if (f.status) r = r.filter(({ value }) => value.status === f.status);
  if (f.effective) {
    r = r.filter(({ value }) => value.developFileStatus === f.effective);
  }
  if (f.kind) r = r.filter(({ value }) => value.kind === f.kind);
  if (f.q) {
    r = r.filter(
      ({ key, value }) =>
        key.toLowerCase().includes(f.q) ||
        (value.title ?? "").toLowerCase().includes(f.q),
    );
  }
  return r;
}

function applySort(
  items: ReadonlyArray<Item>,
  state: SortState<SortColumn>,
): Item[] {
  if (!state.sort || !state.dir) return [...items];
  const { sort, dir } = state;
  const cmp = (a: Item, b: Item): number => {
    const va = a.value;
    const vb = b.value;
    switch (sort) {
      case "id":
        return compareStrings(a.key, b.key);
      case "kind":
        return compareStrings(va.kind, vb.kind);
      case "title":
        return compareStrings(va.title, vb.title);
      case "status":
        return compareByOrder(va.status, vb.status, STATUS_ORDER);
      case "develop":
        return compareByOrder(va.developFileStatus, vb.developFileStatus, STATUS_ORDER);
      case "score":
        return compareNumbers(va.successScore, vb.successScore);
      case "priority":
        return compareNumbers(va.priority, vb.priority);
      case "activity":
        return compareStrings(activityAt(va), activityAt(vb));
    }
  };
  return [...items].sort((a, b) => withDirection(cmp(a, b), dir));
}

function sortedStatuses(counts: Map<string, number>): string[] {
  return Array.from(counts.keys()).sort((a, b) => {
    const ai = STATUS_ORDER.indexOf(a);
    const bi = STATUS_ORDER.indexOf(b);
    if (ai === -1 && bi === -1) return a.localeCompare(b);
    if (ai === -1) return 1;
    if (bi === -1) return -1;
    return ai - bi;
  });
}

export default async function WorkItemsPage({
  searchParams,
}: RouteProps): Promise<React.ReactElement> {
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

  const query: Query = await (searchParams ?? Promise.resolve({}));
  const group = parseGroup(query.group);
  const qRaw = (query.q ?? "").trim();
  const q = qRaw.toLowerCase();
  const statusFilter = query.status;
  const effectiveFilter = query.effective;
  const kindFilter = query.kind;
  const parsedSort = parseSort<SortColumn>(query, SORT_COLUMNS);
  // Default ordering keeps recently-active items on top — the user's
  // primary scanning intent. Stale rows with no activity sink to the
  // bottom. Explicit ?sort=… overrides as usual.
  const sortState: SortState<SortColumn> =
    parsedSort.sort ? parsedSort : { sort: "activity", dir: "desc" };
  const sortHref = (sort: SortColumn | undefined, dir: SortDir | undefined): string =>
    buildHref(query, { sort, dir });

  const rows = await active.kv.list("work-items", { limit: 200 });
  if (rows.length === 0) {
    return (
      <PageContainer>
        <PageHeader
          title="Work items"
          actions={
            <InlineActions>
              <RefreshButton />
            </InlineActions>
          }
        />
        <EmptyState
          icon={ListChecks}
          title="No work items yet"
          description={
            <>
              Run the engine against this connection (<code>npm run exec</code>)
              to produce findings and tasks.
            </>
          }
          dashed
        />
      </PageContainer>
    );
  }

  const allItems: Item[] = rows.map((r) => ({
    key: r.key,
    value: r.value as WorkItemRow,
  }));

  const filters: AppliedFilters = {
    group,
    q,
    status: statusFilter,
    effective: effectiveFilter,
    kind: kindFilter,
  };

  const items = applySort(applyFilters(allItems, filters), sortState);

  const statusContextItems = applyFilters(allItems, { ...filters, status: undefined });
  const effectiveContextItems = applyFilters(allItems, { ...filters, effective: undefined });
  const kindContextItems = applyFilters(allItems, { ...filters, kind: undefined });
  const groupContextItems = applyFilters(allItems, { ...filters, group: undefined });

  const statusCounts = new Map<string, number>();
  for (const { value } of statusContextItems) {
    if (value.status) {
      statusCounts.set(value.status, (statusCounts.get(value.status) ?? 0) + 1);
    }
  }
  const effectiveCounts = new Map<string, number>();
  for (const { value } of effectiveContextItems) {
    if (value.developFileStatus) {
      effectiveCounts.set(
        value.developFileStatus,
        (effectiveCounts.get(value.developFileStatus) ?? 0) + 1,
      );
    }
  }
  const kindCounts = new Map<string, number>();
  for (const { value } of kindContextItems) {
    if (value.kind) kindCounts.set(value.kind, (kindCounts.get(value.kind) ?? 0) + 1);
  }
  const groupCounts: Record<StatusGroup, number> = {
    active: 0,
    pending: 0,
    completed: 0,
    rejected: 0,
  };
  for (const { value } of groupContextItems) {
    const g = statusGroupOf(value);
    if (g) groupCounts[g] += 1;
  }

  const filterBits: string[] = [];
  if (group) filterBits.push(group);
  if (statusFilter) filterBits.push(`status=${statusFilter}`);
  if (effectiveFilter) filterBits.push(`effective=${effectiveFilter}`);
  if (kindFilter) filterBits.push(`kind=${kindFilter}`);
  const filterDescription = filterBits.length ? ` · ${filterBits.join(" · ")}` : "";
  const hasAnyFilter =
    Boolean(group) ||
    Boolean(statusFilter) ||
    Boolean(effectiveFilter) ||
    Boolean(kindFilter) ||
    Boolean(q);

  const summaryBadges = [
    statusFilter ? { label: "status", value: statusFilter } : null,
    effectiveFilter ? { label: "develop", value: effectiveFilter } : null,
    kindFilter ? { label: "kind", value: kindFilter } : null,
  ].filter((x): x is { label: string; value: string } => x !== null);

  const statusValues = sortedStatuses(statusCounts).map((v) => ({
    value: v,
    count: statusCounts.get(v) ?? 0,
    href: buildHref(query, { status: v }),
  }));
  const effectiveValues = sortedStatuses(effectiveCounts).map((v) => ({
    value: v,
    count: effectiveCounts.get(v) ?? 0,
    href: buildHref(query, { effective: v }),
  }));
  const kindValues = Array.from(kindCounts.keys())
    .sort()
    .map((v) => ({
      value: v,
      count: kindCounts.get(v) ?? 0,
      href: buildHref(query, { kind: v }),
    }));

  return (
    <PageContainer>
      <PageHeader
        title="Work items"
        description={`${items.length} total${q ? ` matching "${qRaw}"` : ""}${filterDescription}`}
        actions={
          <InlineActions>
            <RefreshButton />
            <CopyJsonButton
              payload={items.map(({ key, value }) => ({ key, value }))}
              label={`Copy ${items.length}`}
            />
          </InlineActions>
        }
      />

      <ListToolbar>
        <ListToolbarRow>
          <WorkItemsSearch />
          <ListToolbarToggle
            href={buildHref(query, { group: group === "active" ? undefined : "active" })}
            selected={group === "active"}
            count={groupCounts.active}
            title="Items the engine is currently working on — in-progress, running, in-review, or ready-to-merge"
          >
            Active
          </ListToolbarToggle>
          <ListToolbarToggle
            href={buildHref(query, { group: group === "pending" ? undefined : "pending" })}
            selected={group === "pending"}
            count={groupCounts.pending}
            title="Items waiting to be picked up by a stage"
          >
            Pending
          </ListToolbarToggle>
          <ListToolbarToggle
            href={buildHref(query, { group: group === "completed" ? undefined : "completed" })}
            selected={group === "completed"}
            count={groupCounts.completed}
            title="Items that finished successfully — merged (PR landed), or completed/approved for non-PR items"
          >
            Completed
          </ListToolbarToggle>
          <ListToolbarToggle
            href={buildHref(query, { group: group === "rejected" ? undefined : "rejected" })}
            selected={group === "rejected"}
            count={groupCounts.rejected}
            title="Items that terminated unsuccessfully — rejected, failed, cancelled, or duplicate"
          >
            Rejected
          </ListToolbarToggle>
          {hasAnyFilter ? <ListToolbarClear href="/work-items" /> : null}
        </ListToolbarRow>

        <ListToolbarMore
          open={Boolean(statusFilter || effectiveFilter || kindFilter)}
          summary={summaryBadges}
        >
          <FacetRow
            label="Status"
            selected={statusFilter}
            total={statusContextItems.length}
            totalHref={buildHref(query, { status: undefined })}
            values={statusValues}
          />
          <FacetRow
            label="Develop"
            selected={effectiveFilter}
            total={effectiveContextItems.length}
            totalHref={buildHref(query, { effective: undefined })}
            values={effectiveValues}
          />
          {kindValues.length > 0 ? (
            <FacetRow
              label="Kind"
              selected={kindFilter}
              total={kindContextItems.length}
              totalHref={buildHref(query, { kind: undefined })}
              values={kindValues}
            />
          ) : null}
        </ListToolbarMore>
      </ListToolbar>

      <div className="rounded-lg border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <SortableHeader column="id" label="ID" current={sortState} buildHref={sortHref} />
              <SortableHeader column="kind" label="Kind" current={sortState} buildHref={sortHref} />
              <SortableHeader column="title" label="Title" current={sortState} buildHref={sortHref} />
              <SortableHeader column="status" label="Status" current={sortState} buildHref={sortHref} />
              <SortableHeader
                column="develop"
                label="Develop"
                current={sortState}
                buildHref={sortHref}
                title="Raw develop-file status — the literal frontmatter value on the merged branch."
              />
              <SortableHeader
                column="score"
                label="Score"
                current={sortState}
                buildHref={sortHref}
                title="Normalized success rate (0=failure, 1=success); blank while in flight."
              />
              <SortableHeader column="priority" label="Priority" current={sortState} buildHref={sortHref} />
              <SortableHeader
                column="activity"
                label="Activity"
                current={sortState}
                buildHref={sortHref}
                title="Last domain event — status change, new execution, or observation transition. Stale rows fall to the bottom."
              />
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map(({ key, value }) => (
              <TableRow key={key}>
                <TableCell className="whitespace-nowrap">
                  <Link
                    href={`/work-items/${encodeURIComponent(key)}`}
                    className="whitespace-nowrap font-mono text-xs"
                  >
                    {key}
                  </Link>
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {value.kind ?? "—"}
                </TableCell>
                <TableCell>{value.title ?? "—"}</TableCell>
                <TableCell>
                  <Badge
                    variant={statusVariant(value.status)}
                    title={value.statusReason}
                  >
                    {value.status ?? "—"}
                  </Badge>
                </TableCell>
                <TableCell>
                  <Badge variant="outline">
                    {value.developFileStatus ?? "—"}
                  </Badge>
                </TableCell>
                <TableCell>
                  {value.successScore != null ? (
                    <Badge
                      variant={
                        value.successScore >= 0.95 ? "success"
                          : value.successScore >= 0.5 ? "secondary"
                            : "destructive"
                      }
                    >
                      {value.successScore === 1
                        ? "1.0"
                        : value.successScore === 0
                          ? "0.0"
                          : value.successScore.toFixed(2)}
                    </Badge>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {value.priority ?? "—"}
                </TableCell>
                <TableCell
                  className="text-xs text-muted-foreground"
                  title={
                    value.updatedAt && value.updatedAt !== activityAt(value)
                      ? `Row last written: ${value.updatedAt}`
                      : undefined
                  }
                >
                  {activityAt(value) ?? "—"}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </PageContainer>
  );
}
