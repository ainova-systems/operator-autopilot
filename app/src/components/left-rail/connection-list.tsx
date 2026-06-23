import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { getActiveConnectionState, listConnections } from "@/lib/connections";
import { cn } from "@/lib/cn";

export async function ConnectionList(): Promise<React.ReactElement> {
  const [connections, activeState] = await Promise.all([
    listConnections(),
    getActiveConnectionState(),
  ]);

  if (connections.length === 0) {
    return (
      <div className="px-3 py-2 text-xs text-muted-foreground">
        No connections yet
      </div>
    );
  }

  const activeId = activeState?.id;
  return (
    <div className="flex flex-col gap-0.5">
      {connections.map((c) => {
        const active = c.id === activeId;
        return (
          <Link
            key={c.id}
            href={`/connect/${c.id}`}
            className={cn(
              "flex items-center justify-between gap-2 rounded-md border border-transparent px-3 py-2 text-sm no-underline transition-colors",
              active
                ? "border-primary/60 bg-primary/10 text-foreground"
                : "text-foreground hover:bg-muted",
            )}
          >
            <div className="min-w-0 flex-1 overflow-hidden">
              <div className="truncate font-medium">{c.name}</div>
              <div className="truncate font-mono text-xs text-muted-foreground">
                {c.dbPath}
              </div>
            </div>
            {active ? (
              <Badge variant="success" className="flex-shrink-0">
                active
              </Badge>
            ) : null}
          </Link>
        );
      })}
    </div>
  );
}
