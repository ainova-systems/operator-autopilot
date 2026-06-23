import Link from "next/link";
import { Activity } from "lucide-react";
import { Badge, type BadgeProps } from "@/components/ui/badge";
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
import { Timeline, TimelineEvent, type TimelineTone } from "@/components/shared/timeline";
import { getActiveKV } from "@/lib/active-kv-registry";
import {
  buildPrUrl,
  buildRepoSlugMap,
  deriveScore,
  workItemPrState,
  workItemStatus,
  type PrState,
} from "@/lib/github-pr";

interface RouteProps {
  readonly params: Promise<{ readonly id: string }>;
  readonly searchParams?: Promise<{ readonly highlight?: string }>;
}

interface ExecutionValue {
  readonly id?: string;
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
  readonly scopeKey?: string;
  readonly summary?: string;
  readonly error?: string;
  readonly successScore?: number;
  readonly parentExecutionId?: string;
  readonly childExecutionIds?: ReadonlyArray<string>;
}

function prStateVariant(state: PrState | undefined): Variant {
  if (!state) return "outline";
  if (state === "merged") return "success";
  if (state === "closed") return "destructive";
  if (state === "open") return "secondary";
  return "outline";
}

type Variant = BadgeProps["variant"];

function statusVariant(status: string | undefined): Variant {
  if (!status) return "outline";
  const s = status.toLowerCase();
  if (s === "completed" || s === "merged" || s === "success" || s === "ok") return "success";
  if (s === "failed" || s === "rejected" || s === "cancelled" || s === "error") return "destructive";
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

interface EventValue {
  readonly seq?: number;
  readonly timestamp?: string;
  readonly type?: string;
  readonly level?: "info" | "warn" | "error";
  readonly message?: string;
  readonly detail?: string;
  readonly payload?: unknown;
}

function eventTone(type: string, level?: string, payload?: unknown): TimelineTone {
  if (level === "error") return "destructive";
  if (level === "warn") return "warning";
  if (type.includes("error") || type.includes("fail") || type.includes("rejected")) {
    return "destructive";
  }
  if (type.includes("retry")) return "warning";
  if (payload && typeof payload === "object") {
    const p = payload as Record<string, unknown>;
    if (p.verdict === "rejected" || p.verdict === "failed") return "destructive";
    if (p.verdict === "retry") return "warning";
    if (p.committed === false) return "warning";
  }
  if (type === "input.selected" || type === "workspace.prepared") {
    return "info";
  }
  return "success";
}

function formatScore(score: number | undefined): string {
  if (score == null) return "—";
  if (score === 1) return "1.0 ✓";
  if (score === 0) return "0.0 ✗";
  return score.toFixed(2);
}

function scoreVariant(score: number | undefined): "default" | "secondary" | "outline" | "destructive" {
  if (score == null) return "outline";
  if (score >= 0.95) return "default";
  if (score >= 0.5) return "secondary";
  return "destructive";
}

function formatTime(iso: string | undefined): string | undefined {
  if (!iso) return undefined;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toISOString().slice(11, 19);
}

export default async function ExecutionDetailPage({
  params,
  searchParams,
}: RouteProps): Promise<React.ReactElement> {
  const { id } = await params;
  const decoded = decodeURIComponent(id);
  const query: { readonly highlight?: string } = searchParams
    ? await searchParams
    : {};
  const highlightId = query.highlight;
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

  const [execution, events, logEntry, repoRows] = await Promise.all([
    active.kv.get("executions", decoded),
    active.kv.list("execution-events", { keyPrefix: `${decoded}/` }),
    active.kv.get("execution-logs", decoded),
    active.kv.list("repos", { limit: 100 }),
  ]);
  const repoSlugs = buildRepoSlugMap(repoRows);

  if (!execution) {
    return (
      <PageContainer>
        <PageHeader title="Execution not found" backHref="/executions" />
        <EmptyState title={`No execution at ${decoded}`} />
      </PageContainer>
    );
  }

  const value = execution.value as ExecutionValue;
  const childIds = Array.isArray(value.childExecutionIds) ? value.childExecutionIds : [];
  const childEntries = childIds.length > 0
    ? await Promise.all(
        childIds.map(async (cid) => {
          const entry = await active.kv.get("executions", cid);
          return { id: cid, value: (entry?.value ?? null) as ExecutionValue | null };
        }),
      )
    : [];

  // Resolve PR state for the current row + each child via the work-item KV row.
  const workItemIds = new Set<string>();
  if (value.workItemId) workItemIds.add(value.workItemId);
  for (const c of childEntries) if (c.value?.workItemId) workItemIds.add(c.value.workItemId);
  const workItemRows = await Promise.all(
    Array.from(workItemIds).map(async (id) => ({
      id,
      entry: await active.kv.get("work-items", id),
    })),
  );
  const prStateMap = new Map<string, PrState>();
  const wiStatusMap = new Map<string, string>();
  for (const { id, entry } of workItemRows) {
    if (!entry) continue;
    const state = workItemPrState(entry.value);
    if (state) prStateMap.set(id, state);
    const status = workItemStatus(entry.value);
    if (status) wiStatusMap.set(id, status);
  }
  const prStateFor = (e: ExecutionValue | null | undefined): PrState | undefined =>
    e?.workItemId ? prStateMap.get(e.workItemId) : undefined;
  const wiStatusFor = (e: ExecutionValue | null | undefined): string | undefined =>
    e?.workItemId ? wiStatusMap.get(e.workItemId) : undefined;
  const ownPrState = prStateFor(value);
  const ownWiStatus = wiStatusFor(value);
  const ownDisplayedScore = ownWiStatus ? deriveScore(ownWiStatus) : (value.successScore ?? null);

  const logBody =
    logEntry && typeof logEntry.value === "object" && logEntry.value !== null && "body" in logEntry.value
      ? String((logEntry.value as { body: unknown }).body)
      : logEntry
        ? JSON.stringify(logEntry.value, null, 2)
        : null;

  const debugPayload = {
    id: decoded,
    metadata: execution.metadata ?? null,
    execution: value,
    events: events.map((e) => ({ key: e.key, value: e.value })),
    log: logEntry?.value ?? null,
    children: childEntries,
  };

  return (
    <PageContainer>
      <PageHeader
        title={`${value.stageName ?? "stage"} · ${decoded}`}
        backHref="/executions"
        backLabel="Back to executions"
        actions={
          <InlineActions>
            <RefreshButton />
            <CopyJsonButton payload={debugPayload} label="Copy JSON" />
          </InlineActions>
        }
        description={
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span>
              verdict=<Badge variant="secondary">{value.verdict ?? "?"}</Badge>
            </span>
            <span>
              status=<Badge variant={statusVariant(value.status)}>
                {value.status ?? "?"}
              </Badge>
            </span>
            <span>
              score=<Badge
                variant={scoreVariant(ownDisplayedScore ?? undefined)}
                title={ownDisplayedScore == null ? "pending — outcome not yet observed" : undefined}
              >
                {formatScore(ownDisplayedScore ?? undefined)}
              </Badge>
            </span>
            {value.durationMs != null ? (
              <span>{(value.durationMs / 1000).toFixed(1)}s</span>
            ) : null}
            {value.prNumber ? (() => {
              const slug = value.repoId ? repoSlugs.get(value.repoId) : undefined;
              const url = buildPrUrl(slug, value.prNumber);
              return (
                <span className="inline-flex items-center gap-1">
                  {url ? (
                    <a
                      href={url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-primary hover:underline"
                    >
                      PR #{value.prNumber}
                    </a>
                  ) : (
                    <>PR #{value.prNumber}</>
                  )}
                  {ownPrState ? (
                    <Badge variant={prStateVariant(ownPrState)} className="font-normal">
                      {ownPrState}
                    </Badge>
                  ) : null}
                </span>
              );
            })() : null}
            {value.workItemId ? (
              <span className="inline-flex items-center gap-1">
                <Link
                  href={`/work-items/${encodeURIComponent(value.workItemId)}`}
                  className="text-primary hover:underline"
                >
                  {value.workItemId}
                </Link>
                {ownWiStatus ? (
                  <Badge variant={statusVariant(ownWiStatus)} className="font-normal">
                    {ownWiStatus}
                  </Badge>
                ) : null}
              </span>
            ) : null}
            {value.parentExecutionId ? (
              <Link
                href={`/executions/${encodeURIComponent(value.parentExecutionId)}?highlight=${encodeURIComponent(decoded)}`}
                className="text-primary hover:underline"
                title="Open the parent cycle and highlight this stage"
              >
                ↑ parent cycle
              </Link>
            ) : null}
          </span>
        }
      />

      <div className="space-y-4">
        {value.summary ? (
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Reviewer summary</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="whitespace-pre-wrap text-sm">{value.summary}</div>
            </CardContent>
          </Card>
        ) : null}

        {value.error ? (
          <Card className="border-destructive/50">
            <CardHeader className="pb-3">
              <CardTitle className="text-base text-destructive">Error</CardTitle>
            </CardHeader>
            <CardContent>
              <CodeBlock content={value.error} />
            </CardContent>
          </Card>
        ) : null}

        {childEntries.length > 0 ? (
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">
                Stage runs ({childEntries.length})
              </CardTitle>
            </CardHeader>
            <CardContent>
              <ul className="m-0 list-none space-y-1 pl-0">
                {childEntries.map(({ id: cid, value: cv }) => {
                  const highlighted = cid === highlightId;
                  const stageLabel = cv?.stageName ?? "stage";
                  const itemLabel = cv?.workItemId ?? cv?.scopeKey ?? null;
                  const childWiStatus = wiStatusFor(cv);
                  const childDisplayedScore = childWiStatus
                    ? deriveScore(childWiStatus)
                    : (cv?.successScore ?? null);
                  return (
                    <li
                      key={cid}
                      className={
                        highlighted
                          ? "rounded-md border border-primary/40 bg-primary/5 px-3 py-2"
                          : "rounded-md border border-transparent px-3 py-2 hover:bg-muted/40"
                      }
                    >
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
                        <Link
                          href={`/executions/${encodeURIComponent(cid)}`}
                          className="inline-flex items-center gap-x-2 hover:underline"
                        >
                          <span className="font-mono text-xs text-muted-foreground">
                            {cid}
                          </span>
                          <span className="font-medium">{stageLabel}</span>
                        </Link>
                        {cv?.status ? (
                          <Badge variant={statusVariant(cv.status)}>{cv.status}</Badge>
                        ) : (
                          <Badge variant="outline">no status</Badge>
                        )}
                        {cv?.verdict ? (
                          <Badge variant={verdictVariant(cv.verdict)}>{cv.verdict}</Badge>
                        ) : null}
                        <Badge
                          variant={scoreVariant(childDisplayedScore ?? undefined)}
                          title={childDisplayedScore == null ? "pending" : undefined}
                        >
                          {formatScore(childDisplayedScore ?? undefined)}
                        </Badge>
                        {cv?.durationMs != null ? (
                          <span className="text-xs text-muted-foreground">
                            {(cv.durationMs / 1000).toFixed(1)}s
                          </span>
                        ) : null}
                        {cv?.prNumber ? (() => {
                          const slug = cv.repoId ? repoSlugs.get(cv.repoId) : undefined;
                          const url = buildPrUrl(slug, cv.prNumber);
                          const childPrState = prStateFor(cv);
                          return (
                            <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                              {url ? (
                                <a
                                  href={url}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="text-primary hover:underline"
                                >
                                  PR #{cv.prNumber}
                                </a>
                              ) : (
                                <>PR #{cv.prNumber}</>
                              )}
                              {childPrState ? (
                                <Badge variant={prStateVariant(childPrState)} className="font-normal">
                                  {childPrState}
                                </Badge>
                              ) : null}
                            </span>
                          );
                        })() : null}
                        {cv?.workItemId ? (
                          <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                            <Link
                              href={`/work-items/${encodeURIComponent(cv.workItemId)}`}
                              className="text-primary hover:underline"
                            >
                              {cv.workItemId}
                            </Link>
                            {childWiStatus ? (
                              <Badge variant={statusVariant(childWiStatus)} className="font-normal">
                                {childWiStatus}
                              </Badge>
                            ) : null}
                          </span>
                        ) : itemLabel ? (
                          <span className="text-xs text-muted-foreground">{itemLabel}</span>
                        ) : null}
                        {!cv ? (
                          <Badge variant="outline">missing</Badge>
                        ) : null}
                      </div>
                    </li>
                  );
                })}
              </ul>
            </CardContent>
          </Card>
        ) : null}

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Metadata</CardTitle>
          </CardHeader>
          <CardContent>
            <CodeBlock content={JSON.stringify(value, null, 2)} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Events ({events.length})</CardTitle>
          </CardHeader>
          <CardContent>
            {events.length === 0 ? (
              <p className="m-0 text-sm text-muted-foreground">No events recorded.</p>
            ) : (
              <Timeline>
                {(() => {
                  const isRunning =
                    (value.status ?? "").toLowerCase() === "running" ||
                    !value.finishedAt;
                  return events.map((e, i) => {
                  const ev = e.value as EventValue;
                  const type = (ev.type ?? "").toLowerCase();
                  const tone = eventTone(type, ev.level, ev.payload);
                  const isCurrent = isRunning && i === events.length - 1;
                  // Most agent.attempt.* events carry full prompts /
                  // stdout / verify stderr / reviewer feedback in the
                  // `detail` field. Render those as expandable text
                  // blocks so the operator can read the actual context
                  // sent to the agent and the response received,
                  // without spelunking the JSON payload.
                  const hasDetail = typeof ev.detail === "string" && ev.detail.length > 0;
                  const hasPayload = ev.payload != null;
                  const detailBody = hasDetail || hasPayload
                    ? (
                        <div className="space-y-2">
                          {hasDetail ? (
                            <details>
                              <summary className="cursor-pointer text-xs text-muted-foreground">
                                detail · {(ev.detail ?? "").length} chars
                              </summary>
                              <CodeBlock className="mt-2" content={ev.detail ?? ""} />
                            </details>
                          ) : null}
                          {hasPayload ? (
                            <details>
                              <summary className="cursor-pointer text-xs text-muted-foreground">
                                payload
                              </summary>
                              <CodeBlock
                                className="mt-2"
                                content={JSON.stringify(ev.payload, null, 2)}
                              />
                            </details>
                          ) : null}
                        </div>
                      )
                    : null;
                  return (
                    <TimelineEvent
                      key={e.key}
                      time={formatTime(ev.timestamp)}
                      title={ev.type ?? "event"}
                      subtitle={ev.message}
                      tone={tone}
                      badge={
                        <Badge variant="secondary" className="font-normal">
                          {ev.level ?? ev.type ?? "?"}
                        </Badge>
                      }
                      isLast={i === events.length - 1}
                      pulse={isCurrent}
                      details={detailBody}
                    />
                  );
                });
                })()}
              </Timeline>
            )}
          </CardContent>
        </Card>

        {logBody ? (
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Log blob</CardTitle>
            </CardHeader>
            <CardContent>
              <details>
                <summary className="cursor-pointer text-sm text-muted-foreground">
                  click to expand
                </summary>
                <CodeBlock className="mt-3" content={logBody} />
              </details>
            </CardContent>
          </Card>
        ) : null}
      </div>
    </PageContainer>
  );
}
