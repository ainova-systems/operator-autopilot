import Link from "next/link";
import { Activity } from "lucide-react";
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
import { ExecutionsIdFilter } from "@/components/features/executions/executions-id-filter";
import { InlineActions } from "@/components/shared/inline-actions";
import {
  FacetRow,
  ListToolbar,
  ListToolbarClear,
  ListToolbarMore,
  ListToolbarRow,
  ListToolbarToggle,
} from "@/components/shared/list-toolbar";
import { RefreshButton } from "@/components/shared/refresh-button";
import { PageContainer } from "@/components/shared/page-container";
import { PageHeader } from "@/components/shared/page-header";
import { SortableHeader } from "@/components/shared/sortable-header";
import { getActiveKV } from "@/lib/active-kv-registry";
import {
  buildPrUrl,
  buildRepoSlugMap,
  deriveScore,
  workItemPrState,
  workItemStatus,
  type PrState,
} from "@/lib/github-pr";
import {
  compareByOrder,
  compareNumbers,
  compareStrings,
  parseSort,
  withDirection,
  type SortDir,
  type SortState,
} from "@/lib/sort";

interface ExecutionRow {
  readonly stageName?: string;
  readonly agent?: string;
  readonly verdict?: string;
  readonly status?: string;
  readonly startedAt?: string;
  readonly finishedAt?: string;
  readonly durationMs?: number;
  readonly prNumber?: number;
  readonly workItemId?: string;
  readonly repoId?: string;
  readonly instanceId?: string;
  readonly successScore?: number;
  readonly prState?: PrState;
  /** Joined from `work-items/{id}.status` at read time. */
  readonly displayedStatus?: string;
  /** Joined from `work-items/{id}.kind` at read time. */
  readonly workItemKind?: string;
  /** Derived from displayedStatus per the success-rate model. */
  readonly displayedScore?: number | null;
}

function prStateVariant(state: PrState | undefined): Variant {
  if (!state) return "outline";
  if (state === "merged") return "success";
  if (state === "closed") return "destructive";
  if (state === "open") return "secondary";
  return "outline";
}

interface Query {
  readonly stage?: string;
  readonly verdict?: string;
  readonly status?: string;
  /**
   * Single mutually-exclusive quick-filter token. Encodes:
   *   `kind:<name>` → restrict to runs of work-items with this kind
   *   `agent-runs`  → hide cycle/skip rows (only real agent runs)
   *   `failed`      → only status=failed rows
   * One token at a time — picking another deselects the previous.
   */
  readonly focus?: string;
  /** Cross-link from work-item page or free-text filter: substring match on workItemId / scopeKey. */
  readonly workItem?: string;
  /** Free-text filter: exact PR number match. Numeric string. */
  readonly pr?: string;
  /** Cross-link from /instances: filter to runs spawned by this instance. */
  readonly instance?: string;
  readonly sort?: string;
  readonly dir?: string;
}

type Focus =
  | { readonly type: "kind"; readonly kind: string }
  | { readonly type: "agent-runs" }
  | { readonly type: "cycle" }
  | { readonly type: "failed" }
  | { readonly type: "idle" };

function parseFocus(raw: string | undefined): Focus | undefined {
  if (!raw) return undefined;
  if (raw === "agent-runs") return { type: "agent-runs" };
  if (raw === "cycle") return { type: "cycle" };
  if (raw === "failed") return { type: "failed" };
  if (raw === "idle") return { type: "idle" };
  if (raw.startsWith("kind:")) {
    const k = raw.slice("kind:".length);
    return k ? { type: "kind", kind: k } : undefined;
  }
  return undefined;
}

/**
 * A run is "failed" for filter purposes if EITHER the orchestrator
 * recorded a failure terminal status (`failed` / `timed-out`) OR the
 * agent's own verdict came back negative. Checking `status` alone
 * misses stuck-execution-auto-timeout rows that carry
 * `status="timed-out", verdict="failed"` — those are real failures.
 */
function isFailedRow(value: ExecutionRow): boolean {
  if (value.status === "failed" || value.status === "timed-out") return true;
  if (value.verdict === "failed") return true;
  return false;
}

/** True for `pre-stage skipped` rows — `summary` starts with `"skipped:"`. */
function isIdleRow(value: ExecutionRow): boolean {
  const summary = (value as { summary?: string }).summary;
  return typeof summary === "string" && summary.startsWith("skipped:");
}

/** True for whole-cycle summary rows (no work-item, no agent invocation). */
function isCycleRow(value: ExecutionRow): boolean {
  return value.stageName === "cycle";
}

function titleCaseKind(kind: string): string {
  return kind
    .split("-")
    .map((w) => (w ? w.charAt(0).toUpperCase() + w.slice(1) : w))
    .join(" ");
}

/**
 * "Skip" rows are everything that is NOT a real agent invocation —
 * the per-cycle summary row + every stage that ran the run-stage shell
 * but bailed out (locked / no-input / workspace-prep abort). The
 * "Agent runs" focus chip uses this to hide them in one click; the
 * separate "Cycle" and "Idle" chips can also drill into the two
 * sub-categories individually.
 */
function isSkipRow(value: ExecutionRow): boolean {
  return isCycleRow(value) || isIdleRow(value);
}

const SORT_COLUMNS = [
  "id",
  "stage",
  "agent",
  "status",
  "verdict",
  "score",
  "started",
  "duration",
  "pr",
  "workItem",
] as const;
type SortColumn = (typeof SORT_COLUMNS)[number];

interface RouteProps {
  readonly searchParams?: Promise<Query>;
}

type Variant = BadgeProps["variant"];
type Item = { readonly key: string; readonly value: ExecutionRow };

const STATUS_ORDER = ["failed", "running", "completed"];

function statusVariant(status: string | undefined): Variant {
  if (!status) return "outline";
  const s = status.toLowerCase();
  if (s === "completed" || s === "merged" || s === "success" || s === "ok") return "success";
  if (s === "failed" || s === "timed-out" || s === "rejected" || s === "cancelled" || s === "error") return "destructive";
  if (s === "running" || s === "pending" || s === "retry" || s === "in-progress") return "warning";
  if (s === "in-review" || s === "ready-to-merge") return "secondary";
  return "secondary";
}

function verdictVariant(verdict: string | undefined): Variant {
  if (!verdict) return "outline";
  const v = verdict.toLowerCase();
  if (v === "approved" || v === "success" || v === "ok") return "success";
  if (v === "rejected" || v === "failed" || v === "error") return "destructive";
  if (v === "retry" || v === "pending") return "warning";
  return "secondary";
}

function formatScore(score: number | undefined): string {
  if (score == null) return "—";
  if (score === 1) return "1.0";
  if (score === 0) return "0.0";
  return score.toFixed(2);
}

function scoreVariant(score: number | undefined): Variant {
  if (score == null) return "outline";
  if (score >= 0.95) return "success";
  if (score >= 0.5) return "secondary";
  return "destructive";
}

function buildHref(base: Query, patch: Partial<Query>): string {
  const merged = { ...base, ...patch };
  const qs = new URLSearchParams();
  if (merged.stage) qs.set("stage", merged.stage);
  if (merged.status) qs.set("status", merged.status);
  if (merged.verdict) qs.set("verdict", merged.verdict);
  if (merged.focus) qs.set("focus", merged.focus);
  if (merged.workItem) qs.set("workItem", merged.workItem);
  if (merged.pr) qs.set("pr", merged.pr);
  if (merged.instance) qs.set("instance", merged.instance);
  if (merged.sort) qs.set("sort", merged.sort);
  if (merged.dir) qs.set("dir", merged.dir);
  const s = qs.toString();
  return s ? `/executions?${s}` : "/executions";
}

function applyFilters(
  items: ReadonlyArray<Item>,
  f: {
    stage?: string;
    status?: string;
    verdict?: string;
    focus?: Focus;
    workItem?: string;
    pr?: string;
    instance?: string;
  },
): Item[] {
  // PR filter accepts only digits — non-numeric input is treated as
  // "no filter" so a typo doesn't blank the table.
  const prNumber = f.pr && /^\d+$/.test(f.pr) ? Number(f.pr) : undefined;
  return items.filter(({ value }) => {
    if (f.focus) {
      if (f.focus.type === "agent-runs" && isSkipRow(value)) return false;
      if (f.focus.type === "cycle" && !isCycleRow(value)) return false;
      if (f.focus.type === "idle" && !isIdleRow(value)) return false;
      if (f.focus.type === "failed" && !isFailedRow(value)) return false;
      if (f.focus.type === "kind" && value.workItemKind !== f.focus.kind) return false;
    }
    if (f.stage && value.stageName !== f.stage) return false;
    if (f.status && value.status !== f.status) return false;
    if (f.verdict && value.verdict !== f.verdict) return false;
    if (f.instance && value.instanceId !== f.instance) return false;
    // Match either explicit workItemId or scopeKey (covers pr-review's
    // PR-numbered scope while staying compatible with per-item rows).
    if (f.workItem) {
      const candidates = [value.workItemId, (value as { scopeKey?: string }).scopeKey];
      if (!candidates.some((c) => c && c.includes(f.workItem!))) return false;
    }
    if (prNumber != null && value.prNumber !== prNumber) return false;
    return true;
  });
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
      case "stage":
        return compareStrings(va.stageName, vb.stageName);
      case "agent":
        return compareStrings(va.agent, vb.agent);
      case "status":
        return compareByOrder(va.status, vb.status, STATUS_ORDER);
      case "verdict":
        return compareStrings(va.verdict, vb.verdict);
      case "score":
        return compareNumbers(va.displayedScore ?? undefined, vb.displayedScore ?? undefined);
      case "started":
        return compareStrings(va.startedAt, vb.startedAt);
      case "duration":
        return compareNumbers(va.durationMs, vb.durationMs);
      case "pr":
        return compareNumbers(va.prNumber, vb.prNumber);
      case "workItem":
        return compareStrings(va.workItemId, vb.workItemId);
    }
  };
  return [...items].sort((a, b) => withDirection(cmp(a, b), dir));
}

function sortByOrder(values: string[], order: string[]): string[] {
  return [...values].sort((a, b) => {
    const ai = order.indexOf(a);
    const bi = order.indexOf(b);
    if (ai === -1 && bi === -1) return a.localeCompare(b);
    if (ai === -1) return 1;
    if (bi === -1) return -1;
    return ai - bi;
  });
}

export default async function ExecutionsPage({
  searchParams,
}: RouteProps): Promise<React.ReactElement> {
  const active = await getActiveKV();
  if (!active) {
    return (
      <PageContainer>
        <EmptyState
          icon={Activity}
          title="No connection selected"
          description="Select a connection from the left rail or add a new one."
        />
      </PageContainer>
    );
  }

  const query: Query = await (searchParams ?? Promise.resolve({}));
  const focus = parseFocus(query.focus);
  const sortState = parseSort<SortColumn>(query, SORT_COLUMNS);
  const sortHref = (sort: SortColumn | undefined, dir: SortDir | undefined): string =>
    buildHref(query, { sort, dir });

  const [rows, workItemRows, repoRows, prStateRows] = await Promise.all([
    active.kv.list("executions", { limit: 200, orderBy: "updated_at", order: "desc" }),
    active.kv.list("work-items", { limit: 500 }),
    active.kv.list("repos", { limit: 100 }),
    // Per-PR terminal-state cache (engine writes via observePRState).
    // Lets us label historical execution rows with the actual state of
    // their PR, not the work-item's most recent PR observation.
    active.kv.list("pr-states", { limit: 1000 }),
  ]);
  // Build an O(1) lookup by prNumber for terminal cache hits.
  const prStateCache = new Map<number, PrState>();
  for (const r of prStateRows) {
    const v = r.value as { prNumber?: number; state?: PrState };
    if (typeof v.prNumber === "number" && v.state) prStateCache.set(v.prNumber, v.state);
  }
  const repoSlugs = buildRepoSlugMap(repoRows);
  // Fallback PR lookup: in-flight executions don't yet have a `prNumber`
  // (set only at finalize), so the column shows `—` while the stage is
  // running. Pull the open PR observed on the work item itself so the
  // UI can surface it the moment we know which item the run is touching.
  const workItemPrMap = new Map<string, number>();
  // Track BOTH the state and the PR number it was observed on so we
  // only render the badge when the execution row's prNumber matches.
  // A branch can carry several PRs over its lifetime (e.g. a finding
  // branch where #780 merged, #808 merged, and #820 closed) — the
  // observation only knows the latest one, so historical executions
  // pointing at older PRs must not inherit the latest state.
  const workItemPrStateMap = new Map<string, { state: PrState; prNumber: number | undefined }>();
  const workItemStatusMap = new Map<string, string>();
  const workItemKindMap = new Map<string, string>();
  for (const r of workItemRows) {
    const v = r.value as {
      kind?: string;
      statusSources?: {
        prLabel?: { prNumber?: number };
        prState?: { prNumber?: number };
      };
    };
    const pr = v.statusSources?.prLabel?.prNumber ?? v.statusSources?.prState?.prNumber;
    if (typeof pr === "number") workItemPrMap.set(r.key, pr);
    const state = workItemPrState(r.value);
    if (state) {
      workItemPrStateMap.set(r.key, { state, prNumber: pr });
    }
    const status = workItemStatus(r.value);
    if (status) workItemStatusMap.set(r.key, status);
    if (v.kind) workItemKindMap.set(r.key, v.kind);
  }
  if (rows.length === 0) {
    return (
      <PageContainer>
        <PageHeader
          title="Executions"
          actions={
            <InlineActions>
              <RefreshButton />
            </InlineActions>
          }
        />
        <EmptyState
          icon={Activity}
          title="No executions yet"
          description="Execution history starts populating once the engine runs the runStage primitives against this connection."
          dashed
        />
      </PageContainer>
    );
  }

  const allItems: Item[] = rows.map((r) => {
    const value = r.value as ExecutionRow;
    const fallbackPr = value.workItemId ? workItemPrMap.get(value.workItemId) : undefined;
    const prNumber = value.prNumber ?? fallbackPr;
    // PR state resolution priority:
    //   1. Per-PR terminal cache by prNumber — historical merged/closed
    //      facts captured by engine's `recordTerminalPRStates`.
    //   2. Work-item's latest observation, but only when the row's
    //      prNumber matches that observation's prNumber (avoids
    //      labelling an old PR with the latest PR's state).
    //   3. Otherwise undefined — the badge hides rather than mislead.
    const wiPrState = value.workItemId ? workItemPrStateMap.get(value.workItemId) : undefined;
    const cachedPrState = typeof prNumber === "number" ? prStateCache.get(prNumber) : undefined;
    const prState = cachedPrState
      ?? (wiPrState && prNumber && wiPrState.prNumber === prNumber ? wiPrState.state : undefined);
    const wiStatus = value.workItemId ? workItemStatusMap.get(value.workItemId) : undefined;
    const wiKind = value.workItemId ? workItemKindMap.get(value.workItemId) : undefined;
    // Score must reflect THIS execution's outcome, not the parent
    // work-item's accumulated state. While the run is still in flight,
    // there is no outcome yet — show "—". Only when the execution has
    // terminated do we read its own `successScore` (set at route-verdict
    // finalize) and, as a last fallback, derive from the work-item's
    // current status (covers legacy rows missing their own score).
    const isRunning = value.status === "running";
    const dScore = isRunning
      ? null
      : value.successScore ?? (wiStatus ? deriveScore(wiStatus) : null);
    return {
      key: r.key,
      value: {
        ...value,
        prNumber,
        prState,
        displayedStatus: wiStatus,
        workItemKind: wiKind,
        displayedScore: dScore,
      },
    };
  });

  const baseFilters = { ...query, focus };
  const filtered = applySort(applyFilters(allItems, baseFilters), sortState);

  // Faceted counts — each facet reflects current selection minus itself.
  // The quick-toggle row is mutually exclusive (focus), so chip counts
  // are all computed with focus stripped: each chip shows what would
  // happen if you switched to it.
  const focusContextItems = applyFilters(allItems, { ...baseFilters, focus: undefined });
  const statusContextItems = applyFilters(allItems, { ...baseFilters, status: undefined });
  const stageContextItems = applyFilters(allItems, { ...baseFilters, stage: undefined });
  const verdictContextItems = applyFilters(allItems, { ...baseFilters, verdict: undefined });
  const ranCount = focusContextItems.filter((i) => !isSkipRow(i.value)).length;
  const cycleCount = focusContextItems.filter((i) => isCycleRow(i.value)).length;
  const failedCount = focusContextItems.filter((i) => isFailedRow(i.value)).length;
  const idleCount = focusContextItems.filter((i) => isIdleRow(i.value)).length;

  const statusCounts = new Map<string, number>();
  for (const { value } of statusContextItems) {
    if (value.status) statusCounts.set(value.status, (statusCounts.get(value.status) ?? 0) + 1);
  }
  const stageCounts = new Map<string, number>();
  for (const { value } of stageContextItems) {
    if (value.stageName) stageCounts.set(value.stageName, (stageCounts.get(value.stageName) ?? 0) + 1);
  }
  const verdictCounts = new Map<string, number>();
  for (const { value } of verdictContextItems) {
    if (value.verdict) verdictCounts.set(value.verdict, (verdictCounts.get(value.verdict) ?? 0) + 1);
  }
  const kindCounts = new Map<string, number>();
  for (const { value } of focusContextItems) {
    if (value.workItemKind) {
      kindCounts.set(value.workItemKind, (kindCounts.get(value.workItemKind) ?? 0) + 1);
    }
  }
  const kindChips = Array.from(kindCounts.keys()).sort();

  // Advanced panel auto-opens only when an actual advanced facet is
  // picked (stage / verdict / status / workItem-id / PR input). The
  // mutually-exclusive quick-toggle row (focus) has its own chips and
  // must not pop the panel — that's what made every quick-toggle click
  // cascade into the "More filters" expansion.
  const hasAdvancedFacet = Boolean(
    query.stage || query.verdict || query.status || query.workItem || query.pr,
  );
  const hasAnyFilter = hasAdvancedFacet || Boolean(focus);
  const summaryBadges = [
    query.status ? { label: "status", value: query.status } : null,
    query.stage ? { label: "stage", value: query.stage } : null,
    query.verdict ? { label: "verdict", value: query.verdict } : null,
    query.workItem ? { label: "workItem", value: query.workItem } : null,
    query.pr ? { label: "PR", value: `#${query.pr}` } : null,
  ].filter((x): x is { label: string; value: string } => x !== null);

  const statusValues = sortByOrder(Array.from(statusCounts.keys()), STATUS_ORDER).map((v) => ({
    value: v,
    count: statusCounts.get(v) ?? 0,
    href: buildHref(query, { status: v }),
  }));
  const stageValues = Array.from(stageCounts.keys())
    .sort()
    .map((v) => ({
      value: v,
      count: stageCounts.get(v) ?? 0,
      href: buildHref(query, { stage: v }),
    }));
  const verdictValues = Array.from(verdictCounts.keys())
    .sort()
    .map((v) => ({
      value: v,
      count: verdictCounts.get(v) ?? 0,
      href: buildHref(query, { verdict: v }),
    }));

  return (
    <PageContainer>
      <PageHeader
        title="Executions"
        description={`${filtered.length} of ${allItems.length} runs`}
        actions={
          <InlineActions>
            <RefreshButton />
            <CopyJsonButton
              payload={filtered.map(({ key, value }) => ({ key, value }))}
              label={`Copy ${filtered.length}`}
            />
          </InlineActions>
        }
      />

      <ListToolbar>
        <ListToolbarRow>
          {kindChips.map((k) => {
            const token = `kind:${k}`;
            const selected = focus?.type === "kind" && focus.kind === k;
            return (
              <ListToolbarToggle
                key={k}
                href={buildHref(query, { focus: selected ? undefined : token })}
                selected={selected}
                count={kindCounts.get(k) ?? 0}
                title={`Show only runs whose work item is a ${k}`}
              >
                {titleCaseKind(k)}
              </ListToolbarToggle>
            );
          })}
          <ListToolbarToggle
            href={buildHref(query, {
              focus: focus?.type === "agent-runs" ? undefined : "agent-runs",
            })}
            selected={focus?.type === "agent-runs"}
            count={ranCount}
            title="Only rows where an agent actually invoked — hides cycle summary rows and idle/skipped stage rows"
          >
            Agent runs
          </ListToolbarToggle>
          <ListToolbarToggle
            href={buildHref(query, {
              focus: focus?.type === "cycle" ? undefined : "cycle",
            })}
            selected={focus?.type === "cycle"}
            count={cycleCount}
            title="Only per-cycle summary rows (one per scheduled run, wraps all child stage rows)"
          >
            Cycle
          </ListToolbarToggle>
          <ListToolbarToggle
            href={buildHref(query, {
              focus: focus?.type === "failed" ? undefined : "failed",
            })}
            selected={focus?.type === "failed"}
            count={failedCount}
            title="Rows that ended in failure — status=failed, status=timed-out, or verdict=failed (catches stuck-execution auto-timeouts)"
          >
            Failed
          </ListToolbarToggle>
          <ListToolbarToggle
            href={buildHref(query, {
              focus: focus?.type === "idle" ? undefined : "idle",
            })}
            selected={focus?.type === "idle"}
            count={idleCount}
            title="Stages that ran but had nothing to do — summary starts with 'skipped:' (no input, or workspace locked)"
          >
            Idle
          </ListToolbarToggle>
          {hasAnyFilter ? <ListToolbarClear href="/executions" /> : null}
        </ListToolbarRow>

        <ListToolbarMore open={hasAdvancedFacet} summary={summaryBadges}>
          <ExecutionsIdFilter />
          {statusValues.length > 0 ? (
            <FacetRow
              label="Status"
              selected={query.status}
              total={statusContextItems.length}
              totalHref={buildHref(query, { status: undefined })}
              values={statusValues}
            />
          ) : null}
          {stageValues.length > 0 ? (
            <FacetRow
              label="Stage"
              selected={query.stage}
              total={stageContextItems.length}
              totalHref={buildHref(query, { stage: undefined })}
              values={stageValues}
            />
          ) : null}
          {verdictValues.length > 0 ? (
            <FacetRow
              label="Verdict"
              selected={query.verdict}
              total={verdictContextItems.length}
              totalHref={buildHref(query, { verdict: undefined })}
              values={verdictValues}
            />
          ) : null}
        </ListToolbarMore>
      </ListToolbar>

      <div className="rounded-lg border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <SortableHeader column="id" label="ID" current={sortState} buildHref={sortHref} />
              <SortableHeader column="stage" label="Stage" current={sortState} buildHref={sortHref} />
              <SortableHeader column="agent" label="Agent" current={sortState} buildHref={sortHref} />
              <SortableHeader column="status" label="Status" current={sortState} buildHref={sortHref} />
              <SortableHeader column="verdict" label="Verdict" current={sortState} buildHref={sortHref} />
              <SortableHeader column="score" label="Score" current={sortState} buildHref={sortHref} />
              <SortableHeader column="started" label="Started" current={sortState} buildHref={sortHref} />
              <SortableHeader column="duration" label="Duration" current={sortState} buildHref={sortHref} />
              <SortableHeader column="pr" label="PR" current={sortState} buildHref={sortHref} />
              <SortableHeader column="workItem" label="Work Item" current={sortState} buildHref={sortHref} />
            </TableRow>
          </TableHeader>
          <TableBody>
            {filtered.map(({ key, value }) => (
              <TableRow key={key}>
                <TableCell className="whitespace-nowrap">
                  <Link
                    href={`/executions/${encodeURIComponent(key)}`}
                    className="whitespace-nowrap font-mono text-xs"
                    title={key}
                  >
                    {key}
                  </Link>
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {value.stageName ?? "—"}
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {value.agent ?? "—"}
                </TableCell>
                <TableCell>
                  <Badge variant={statusVariant(value.status)}>
                    {value.status ?? "—"}
                  </Badge>
                </TableCell>
                <TableCell>
                  {value.verdict ? (
                    <Badge variant={verdictVariant(value.verdict)}>
                      {value.verdict}
                    </Badge>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </TableCell>
                <TableCell>
                  <Badge
                    variant={scoreVariant(value.displayedScore ?? undefined)}
                    title={
                      value.displayedScore == null
                        ? "pending — outcome not yet observed"
                        : undefined
                    }
                  >
                    {formatScore(value.displayedScore ?? undefined)}
                  </Badge>
                </TableCell>
                <TableCell className="text-xs text-muted-foreground">
                  {value.startedAt ?? "—"}
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {value.durationMs != null
                    ? `${(value.durationMs / 1000).toFixed(1)}s`
                    : "—"}
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {(() => {
                    if (!value.prNumber) return "—";
                    const slug = value.repoId ? repoSlugs.get(value.repoId) : undefined;
                    const url = buildPrUrl(slug, value.prNumber);
                    const link = url ? (
                      <a
                        href={url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-primary hover:underline"
                      >
                        #{value.prNumber}
                      </a>
                    ) : (
                      <span>#{value.prNumber}</span>
                    );
                    return (
                      <span className="inline-flex items-center gap-1.5">
                        {link}
                        {value.prState ? (
                          <Badge variant={prStateVariant(value.prState)} className="font-normal">
                            {value.prState}
                          </Badge>
                        ) : null}
                      </span>
                    );
                  })()}
                </TableCell>
                <TableCell>
                  {value.workItemId ? (
                    <span className="inline-flex items-center gap-1.5">
                      <Link
                        href={`/work-items/${encodeURIComponent(value.workItemId)}`}
                        className="text-primary hover:underline"
                      >
                        {value.workItemId}
                      </Link>
                      {value.displayedStatus ? (
                        <Badge variant={statusVariant(value.displayedStatus)} className="font-normal">
                          {value.displayedStatus}
                        </Badge>
                      ) : null}
                    </span>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </PageContainer>
  );
}
