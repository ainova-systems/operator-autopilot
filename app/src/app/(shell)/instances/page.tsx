import Link from "next/link";
import { Server } from "lucide-react";
import type { InstanceEntry } from "@operator/core";
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
  ListToolbar,
  ListToolbarClear,
  ListToolbarRow,
  ListToolbarToggle,
} from "@/components/shared/list-toolbar";
import { PageContainer } from "@/components/shared/page-container";
import { PageHeader } from "@/components/shared/page-header";
import { RefreshButton } from "@/components/shared/refresh-button";
import { getActiveKV } from "@/lib/active-kv-registry";
import {
  classifyInstance,
  type InstanceStatus,
} from "@/lib/instance-status";

type Variant = BadgeProps["variant"];

interface Query {
  readonly all?: string;
}

interface RouteProps {
  readonly searchParams?: Promise<Query>;
}

const STATUS_LABELS: Record<InstanceStatus, string> = {
  running: "running",
  offline: "offline",
  stopped: "stopped",
};

function statusVariant(s: InstanceStatus): Variant {
  if (s === "running") return "success";
  if (s === "offline") return "warning";
  return "secondary";
}

function relTime(iso: string | undefined, now: number): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso ?? "—";
  const ms = now - t;
  if (ms < 0) return "just now";
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s ago`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
  return `${Math.floor(ms / 86_400_000)}d ago`;
}

function uptime(startedAt: string, until: string | undefined, now: number): string {
  const start = Date.parse(startedAt);
  if (!Number.isFinite(start)) return "—";
  const end = until ? Date.parse(until) : now;
  const ms = Math.max(0, end - start);
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m`;
  if (ms < 86_400_000) return `${(ms / 3_600_000).toFixed(1)}h`;
  return `${(ms / 86_400_000).toFixed(1)}d`;
}

export default async function InstancesPage({
  searchParams,
}: RouteProps): Promise<React.ReactElement> {
  const active = await getActiveKV();
  if (!active) {
    return (
      <PageContainer>
        <EmptyState
          icon={Server}
          title="No connection selected"
          description="Select a connection from the left rail or add a new one."
        />
      </PageContainer>
    );
  }

  const query: Query = await (searchParams ?? Promise.resolve({}));
  const showAll = query.all === "1";
  const now = Date.now();

  const rows = await active.kv.list("instances", { limit: 200 });

  if (rows.length === 0) {
    return (
      <PageContainer>
        <PageHeader
          title="Instances"
          actions={
            <InlineActions>
              <RefreshButton />
            </InlineActions>
          }
        />
        <EmptyState
          icon={Server}
          title="No instances registered yet"
          description="Engine processes register themselves on boot and emit a heartbeat every few seconds. Start the daemon to see it here."
          dashed
        />
      </PageContainer>
    );
  }

  const enriched = rows
    .map((r) => {
      const value = r.value as InstanceEntry;
      const status = classifyInstance(value, now);
      return { key: r.key, value, status };
    })
    .sort((a, b) => {
      // Active first, then most-recent heartbeat first.
      if (a.status === "running" && b.status !== "running") return -1;
      if (a.status !== "running" && b.status === "running") return 1;
      return (b.value.lastHeartbeatAt ?? "").localeCompare(a.value.lastHeartbeatAt ?? "");
    });

  const visible = showAll
    ? enriched
    : enriched.filter((r) => r.status === "running");

  const counts = {
    running: enriched.filter((r) => r.status === "running").length,
    offline: enriched.filter((r) => r.status === "offline").length,
    stopped: enriched.filter((r) => r.status === "stopped").length,
  };

  return (
    <PageContainer>
      <PageHeader
        title="Instances"
        description={`${counts.running} running · ${counts.offline} offline · ${counts.stopped} stopped`}
        actions={
          <InlineActions>
            <RefreshButton />
            <CopyJsonButton
              payload={visible.map(({ key, value, status }) => ({ key, value, status }))}
              label={`Copy ${visible.length}`}
            />
          </InlineActions>
        }
      />

      <ListToolbar>
        <ListToolbarRow>
          <ListToolbarToggle
            href={showAll ? "/instances" : "/instances?all=1"}
            selected={showAll}
            count={counts.offline + counts.stopped}
            title="Show offline and stopped instances too"
          >
            Show all
          </ListToolbarToggle>
          {showAll ? <ListToolbarClear href="/instances" /> : null}
        </ListToolbarRow>
      </ListToolbar>

      <div className="rounded-lg border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableCell>ID</TableCell>
              <TableCell>Host</TableCell>
              <TableCell>Mode</TableCell>
              <TableCell>Version</TableCell>
              <TableCell>Status</TableCell>
              <TableCell>Started</TableCell>
              <TableCell>Last seen</TableCell>
              <TableCell>Cycles</TableCell>
              <TableCell>Executions</TableCell>
            </TableRow>
          </TableHeader>
          <TableBody>
            {visible.map(({ key, value, status }) => (
              <TableRow key={key}>
                <TableCell className="whitespace-nowrap font-mono text-xs" title={key}>
                  {key}
                </TableCell>
                <TableCell className="text-muted-foreground">
                  <span className="font-mono text-xs">{value.hostname}</span>
                  <span className="ml-1 text-xs text-muted-foreground">pid {value.pid}</span>
                </TableCell>
                <TableCell>
                  <Badge variant="outline">{value.mode}</Badge>
                  {value.repoFilter ? (
                    <span className="ml-1 text-xs text-muted-foreground">
                      repo={value.repoFilter}
                    </span>
                  ) : null}
                  {value.forceAction ? (
                    <span className="ml-1 text-xs text-muted-foreground">
                      action={value.forceAction}
                    </span>
                  ) : null}
                </TableCell>
                <TableCell className="font-mono text-xs text-muted-foreground">
                  {value.version}
                </TableCell>
                <TableCell>
                  <Badge variant={statusVariant(status)}>{STATUS_LABELS[status]}</Badge>
                  {value.stopReason ? (
                    <span className="ml-1 text-xs text-muted-foreground">
                      ({value.stopReason})
                    </span>
                  ) : null}
                </TableCell>
                <TableCell className="text-xs text-muted-foreground" title={value.startedAt}>
                  {uptime(value.startedAt, value.stoppedAt, now)} ago · {relTime(value.startedAt, now)}
                </TableCell>
                <TableCell className="text-xs text-muted-foreground" title={value.lastHeartbeatAt}>
                  {relTime(value.lastHeartbeatAt, now)}
                </TableCell>
                <TableCell className="text-xs text-muted-foreground">
                  {value.cycleCount ?? 0}
                </TableCell>
                <TableCell>
                  <Link
                    href={`/executions?instance=${encodeURIComponent(value.id)}`}
                    className="text-primary hover:underline"
                  >
                    runs →
                  </Link>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </PageContainer>
  );
}
