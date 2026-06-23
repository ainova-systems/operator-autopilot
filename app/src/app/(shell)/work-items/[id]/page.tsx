import Link from "next/link";
import { AlertTriangle, ListChecks } from "lucide-react";
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
import { buildPrUrl, buildRepoSlugMap, type PrState } from "@/lib/github-pr";

interface RouteProps {
  readonly params: Promise<{ readonly id: string }>;
}

interface StatusSourceObservation {
  readonly value?: string;
  readonly observedAt?: string;
  readonly sha?: string;
  readonly path?: string;
  readonly branch?: string;
  readonly prNumber?: number;
  readonly executionId?: string;
  readonly stageName?: string;
}

interface PrStateObservation {
  readonly value?: PrState;
  readonly observedAt?: string;
  readonly prNumber?: number;
  readonly branch?: string;
}

interface CheckAnnotationView {
  readonly path: string;
  readonly startLine: number;
  readonly endLine?: number;
  readonly message: string;
  readonly severity: "notice" | "warning" | "failure";
  readonly title?: string;
}

interface CheckRunView {
  readonly name: string;
  readonly conclusion: string;
  readonly completedAt?: string;
  readonly detailsUrl?: string;
  readonly workflowName?: string;
  readonly title?: string;
  readonly summary?: string;
  readonly annotations?: ReadonlyArray<CheckAnnotationView>;
}

interface ChecksObservationView {
  readonly value?: "passing" | "failing" | "pending" | "none";
  readonly observedAt?: string;
  readonly headSha?: string;
  readonly checks?: ReadonlyArray<CheckRunView>;
}

interface ExecutionPreview {
  readonly stageName?: string;
  readonly verdict?: string;
  readonly status?: string;
  readonly successScore?: number | null;
  readonly parentExecutionId?: string;
  readonly startedAt?: string;
  readonly durationMs?: number;
}

interface WorkItemValue {
  readonly id?: string;
  readonly kind?: string;
  readonly title?: string;
  /** Computed status — primary badge value. */
  readonly status?: string;
  /** Source label for `status` (e.g. `pr-label`, `develop-file`). */
  readonly statusReason?: string;
  /** Raw develop-file status literal — observability secondary value. */
  readonly developFileStatus?: string;
  readonly hasDrift?: boolean;
  readonly isActive?: boolean;
  readonly driftDetails?: string[];
  readonly statusSources?: {
    readonly developFile?: StatusSourceObservation;
    readonly featureBranchFile?: StatusSourceObservation;
    readonly prLabel?: StatusSourceObservation;
    readonly executionVerdict?: StatusSourceObservation;
    readonly prState?: PrStateObservation;
    readonly checks?: ChecksObservationView;
  };
  readonly recentExecutionIds?: string[];
  readonly successScore?: number;
  readonly repoId?: string;
}

const TERMINAL_STATUSES = new Set([
  "completed", "failed", "cancelled", "rejected", "duplicate", "ready-to-merge",
]);

function isLegacyTerminal(v: WorkItemValue): boolean {
  if ((v.recentExecutionIds?.length ?? 0) > 0) return false;
  const computed = (v.status ?? "").toLowerCase();
  const raw = (v.developFileStatus ?? "").toLowerCase();
  return TERMINAL_STATUSES.has(computed) || TERMINAL_STATUSES.has(raw);
}

function checksValueVariant(v: ChecksObservationView["value"]): "secondary" | "success" | "destructive" | "warning" | "outline" {
  if (v === "passing") return "success";
  if (v === "failing") return "destructive";
  if (v === "pending") return "warning";
  return "outline";
}

function ChecksCard({ observation }: { readonly observation: ChecksObservationView }): React.ReactElement {
  const checks = observation.checks ?? [];
  const failing = checks.filter((c) => /failure|timed_out|action_required|startup_failure/i.test(c.conclusion ?? ""));
  const pending = checks.filter((c) => /^(in_progress|queued|pending|)$/i.test(c.conclusion ?? ""));
  const passing = checks.filter((c) => !failing.includes(c) && !pending.includes(c));
  return (
    <Card className="mb-8">
      <CardHeader className="flex flex-row items-center justify-between pb-3">
        <CardTitle className="text-base">CI checks</CardTitle>
        <Badge variant={checksValueVariant(observation.value)}>
          {observation.value ?? "not observed"}
        </Badge>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-center gap-4 text-xs text-muted-foreground">
          {observation.headSha ? <span>Head: <code className="font-mono">{observation.headSha.slice(0, 8)}</code></span> : null}
          {observation.observedAt ? <span>Observed: {observation.observedAt}</span> : null}
          <span>Total: {checks.length}</span>
          {failing.length > 0 ? <Badge variant="destructive" className="font-normal">{failing.length} failing</Badge> : null}
          {pending.length > 0 ? <Badge variant="warning" className="font-normal">{pending.length} pending</Badge> : null}
          {passing.length > 0 ? <Badge variant="success" className="font-normal">{passing.length} passing</Badge> : null}
        </div>
        {failing.length > 0 ? (
          <div>
            <p className="mb-2 text-sm font-semibold text-destructive">Failing</p>
            <ul className="m-0 list-none space-y-3 pl-0">
              {failing.map((c) => <CheckRow key={c.name} check={c} />)}
            </ul>
          </div>
        ) : null}
        {pending.length > 0 ? (
          <div>
            <p className="mb-2 text-sm font-semibold text-functional-warning">Pending</p>
            <ul className="m-0 list-none space-y-2 pl-0">
              {pending.map((c) => (
                <li key={c.name} className="flex flex-wrap items-center gap-2 text-sm">
                  <span className="font-medium">{c.name}</span>
                  <Badge variant="warning" className="font-normal">{c.conclusion || "pending"}</Badge>
                  {c.detailsUrl ? (
                    <a href={c.detailsUrl} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline text-xs">
                      logs ↗
                    </a>
                  ) : null}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {passing.length > 0 ? (
          <details>
            <summary className="cursor-pointer text-sm text-muted-foreground">
              {passing.length} passing checks
            </summary>
            <ul className="mt-2 list-disc space-y-1 pl-5 text-sm">
              {passing.map((c) => (
                <li key={c.name}>
                  <span className="font-medium">{c.name}</span> · <span className="text-muted-foreground">{c.conclusion}</span>
                </li>
              ))}
            </ul>
          </details>
        ) : null}
      </CardContent>
    </Card>
  );
}

function CheckRow({ check }: { readonly check: CheckRunView }): React.ReactElement {
  return (
    <li className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{check.name}</span>
        <Badge variant="destructive" className="font-normal">{check.conclusion}</Badge>
        {check.workflowName ? <span className="text-xs text-muted-foreground">workflow: {check.workflowName}</span> : null}
        {check.detailsUrl ? (
          <a href={check.detailsUrl} target="_blank" rel="noopener noreferrer" className="ml-auto text-primary hover:underline text-xs">
            full logs ↗
          </a>
        ) : null}
      </div>
      {check.title ? <p className="mt-2 text-sm font-semibold">{check.title}</p> : null}
      {check.summary ? (
        <details className="mt-2">
          <summary className="cursor-pointer text-xs text-muted-foreground">summary</summary>
          <pre className="mt-2 whitespace-pre-wrap rounded bg-muted/40 p-2 text-xs">{check.summary}</pre>
        </details>
      ) : null}
      {check.annotations && check.annotations.length > 0 ? (
        <details className="mt-2" open>
          <summary className="cursor-pointer text-xs text-muted-foreground">
            annotations ({check.annotations.length})
          </summary>
          <ul className="mt-2 m-0 list-none space-y-1 pl-0 text-xs">
            {check.annotations.map((a, i) => (
              <li key={`${a.path}:${a.startLine}:${i}`} className="rounded border border-border bg-muted/30 p-2">
                <code className="font-mono text-xs">{a.path}:{a.startLine}{a.endLine && a.endLine !== a.startLine ? `-${a.endLine}` : ""}</code>
                {a.title ? <span className="ml-2 font-semibold">{a.title}</span> : null}
                <p className="m-0 mt-1 whitespace-pre-wrap">{a.message}</p>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </li>
  );
}

function ObservationCard({
  label,
  obs,
}: {
  readonly label: string;
  readonly obs: StatusSourceObservation | undefined;
}): React.ReactElement {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between pb-3">
        <CardTitle className="text-base">{label}</CardTitle>
        <Badge variant={obs?.value ? "secondary" : "outline"}>
          {obs?.value ?? "not observed"}
        </Badge>
      </CardHeader>
      <CardContent>
        {obs ? (
          <CodeBlock content={JSON.stringify(obs, null, 2)} />
        ) : (
          <p className="m-0 text-sm text-muted-foreground">
            This source has not been observed yet on this cycle.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

export default async function WorkItemDetailPage({
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

  const [entry, repoRows] = await Promise.all([
    active.kv.get("work-items", decoded),
    active.kv.list("repos", { limit: 100 }),
  ]);
  const recentIdsForFetch = (entry?.value as { recentExecutionIds?: string[] } | undefined)?.recentExecutionIds ?? [];
  const executionEntries = await Promise.all(
    recentIdsForFetch.map(async (eid) => ({
      id: eid,
      value: ((await active.kv.get("executions", eid))?.value ?? null) as ExecutionPreview | null,
    })),
  );
  if (!entry) {
    return (
      <PageContainer>
        <PageHeader title="Work item not found" backHref="/work-items" />
        <EmptyState
          title={`No work item at ${decoded}`}
          description="It may have been deleted or not yet synced from VCS."
        />
      </PageContainer>
    );
  }

  const value = entry.value as WorkItemValue;
  const sources = value.statusSources ?? {};
  const recentIds = value.recentExecutionIds ?? [];
  const repoSlugs = buildRepoSlugMap(repoRows);
  // Work items are not tagged with `repoId` (one connection ↔ one repo by
  // convention), so when the column is missing fall back to the only repo
  // in the KV. Multi-repo connections will need an explicit join later.
  const repoSlug = value.repoId
    ? repoSlugs.get(value.repoId)
    : repoSlugs.values().next().value;
  const prNumber = sources.prState?.prNumber ?? sources.prLabel?.prNumber;
  const prUrl = buildPrUrl(repoSlug, prNumber);
  const prState = sources.prState?.value;

  const debugPayload = {
    key: decoded,
    metadata: entry.metadata ?? null,
    value,
  };

  return (
    <PageContainer>
      <PageHeader
        title={value.title ?? decoded}
        backHref="/work-items"
        backLabel="Back to work items"
        actions={
          <InlineActions>
            <RefreshButton />
            <CopyJsonButton payload={debugPayload} label="Copy JSON" />
          </InlineActions>
        }
        description={
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <code className="font-mono text-xs">{decoded}</code>
            <span>·</span>
            <span>{value.kind ?? "?"}</span>
            <span>·</span>
            <span>
              status=<Badge variant="secondary">{value.status ?? "?"}</Badge>
            </span>
            <span>
              develop=<Badge variant="outline">{value.developFileStatus ?? "?"}</Badge>
            </span>
            <span className="text-muted-foreground">
              ({value.statusReason ?? "?"})
            </span>
            {value.isActive ? <Badge variant="secondary">active</Badge> : null}
            {value.hasDrift ? <Badge variant="warning">drift</Badge> : null}
            {isLegacyTerminal(value) ? (
              <Badge variant="outline" title="No execution runs recorded; status came from develop file before tracking started.">
                legacy
              </Badge>
            ) : null}
            {prNumber ? (
              <>
                <span>·</span>
                {prUrl ? (
                  <a
                    href={prUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-primary hover:underline"
                  >
                    PR #{prNumber}
                  </a>
                ) : (
                  <span>PR #{prNumber}</span>
                )}
                {prState ? (
                  <Badge
                    variant={
                      prState === "merged" ? "success"
                        : prState === "closed" ? "destructive"
                          : prState === "open" ? "secondary"
                            : "outline"
                    }
                    className="font-normal"
                  >
                    {prState}
                  </Badge>
                ) : null}
              </>
            ) : null}
            <span>·</span>
            <Link
              href={`/work-items/${encodeURIComponent(decoded)}/debug`}
              className="text-primary hover:underline"
            >
              debug
            </Link>
          </span>
        }
      />

      {value.hasDrift && value.driftDetails && value.driftDetails.length > 0 ? (
        <Card className="mb-6 border-functional-warning/50">
          <CardHeader className="flex flex-row items-center gap-2 pb-3">
            <AlertTriangle className="h-4 w-4 text-functional-warning" />
            <CardTitle className="text-base">Drift detected</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="m-0 list-disc space-y-1 pl-5 text-sm">
              {value.driftDetails.map((d) => (
                <li key={d}>{d}</li>
              ))}
            </ul>
          </CardContent>
        </Card>
      ) : null}

      <h2 className="mb-3 text-base font-semibold">Status sources</h2>
      <div className="mb-8 grid gap-3 md:grid-cols-2">
        <ObservationCard label="Develop file" obs={sources.developFile} />
        <ObservationCard label="Feature branch file" obs={sources.featureBranchFile} />
        <ObservationCard label="PR label" obs={sources.prLabel} />
        <ObservationCard label="Execution verdict" obs={sources.executionVerdict} />
      </div>

      {sources.checks ? (
        <>
          <h2 className="mb-3 text-base font-semibold">CI checks</h2>
          <ChecksCard observation={sources.checks} />
        </>
      ) : null}

      <h2 className="mb-3 text-base font-semibold">Executions</h2>
      {recentIds.length === 0 ? (
        <div className="mb-8 space-y-2">
          <p className="text-sm text-muted-foreground">
            {isLegacyTerminal(value)
              ? "Legacy item — terminal status was already set on develop before the operator started tracking executions, so no run history is recorded."
              : "No execution runs recorded yet."}
          </p>
          <p className="text-xs text-muted-foreground">
            <Link
              href={`/executions?workItem=${encodeURIComponent(decoded)}`}
              className="text-primary hover:underline"
            >
              Search all executions for {decoded} →
            </Link>
          </p>
        </div>
      ) : (
        <ul className="mb-8 m-0 list-none space-y-1 pl-0 text-sm">
          {executionEntries.map(({ id: eid, value: ev }) => {
            // Deep-link target: when this execution carries a parent cycle id,
            // open the parent cycle and let the cycle tree highlight this row
            // (handled by the executions/[id] page via ?highlight=). Without
            // a parent we fall back to the execution's own detail page.
            const target = ev?.parentExecutionId
              ? `/executions/${encodeURIComponent(ev.parentExecutionId)}?highlight=${encodeURIComponent(eid)}`
              : `/executions/${encodeURIComponent(eid)}`;
            const stage = ev?.stageName ?? "stage";
            return (
              <li key={eid} className="rounded-md border border-transparent px-3 py-2 hover:bg-muted/40">
                <Link href={target} className="flex flex-wrap items-center gap-x-2 gap-y-1 hover:underline">
                  <span className="font-mono text-xs text-muted-foreground">{eid}</span>
                  <span className="font-medium">{stage}</span>
                  {ev?.verdict ? (
                    <Badge variant="secondary" className="font-normal">{ev.verdict}</Badge>
                  ) : null}
                  {ev?.status ? (
                    <Badge variant="outline" className="font-normal">{ev.status}</Badge>
                  ) : null}
                  {ev?.durationMs != null ? (
                    <span className="text-xs text-muted-foreground">
                      {(ev.durationMs / 1000).toFixed(1)}s
                    </span>
                  ) : null}
                  {ev?.parentExecutionId ? (
                    <span className="ml-auto text-xs text-muted-foreground" title="Opens parent cycle with this stage highlighted">
                      ↑ cycle
                    </span>
                  ) : null}
                </Link>
              </li>
            );
          })}
        </ul>
      )}

      <h2 className="mb-3 text-base font-semibold">Raw KV</h2>
      <Card>
        <CardContent className="pt-6">
          <CodeBlock content={JSON.stringify(value, null, 2)} />
        </CardContent>
      </Card>
    </PageContainer>
  );
}
