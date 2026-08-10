"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ErrorAlert } from "@/components/shared/error-alert";
import { FormRow, FormStack } from "@/components/shared/form-stack";
import { InlineActions } from "@/components/shared/inline-actions";
import { useToast } from "@/components/shared/toaster";

export interface ConnectionSummary {
  readonly id: string;
  readonly name: string;
  readonly dbPath: string;
}

/**
 * Step 1 — give the app an engine state database.
 *
 * The file does not have to exist: SQLite opens read-write-create, so
 * saving a connection to a fresh path creates a valid, empty engine
 * database. The engine seeds its prompts, stages, and kinds into it on its
 * first start, and never overwrites a row the UI wrote first — which is
 * what lets the rest of this screen run before the engine has ever booted.
 */
export function ConnectStep({
  connections,
  activeConnectionId,
  dbPath,
  onDbPathChange,
  onConnected,
}: {
  readonly connections: readonly ConnectionSummary[];
  readonly activeConnectionId: string | null;
  readonly dbPath: string;
  readonly onDbPathChange: (value: string) => void;
  readonly onConnected: (connection: ConnectionSummary) => void;
}): React.ReactElement {
  const toast = useToast();
  const [name, setName] = useState("local-engine");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const active = connections.find((c) => c.id === activeConnectionId) ?? null;
  const others = connections.filter((c) => c.id !== activeConnectionId);

  async function activate(connection: ConnectionSummary): Promise<void> {
    const res = await fetch("/api/app/active-connection", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: connection.id }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error ?? `Could not select the connection (${res.status})`);
    }
    onDbPathChange(connection.dbPath);
    onConnected(connection);
  }

  async function onCreate(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/app/connections", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim(), dbPath: dbPath.trim() }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? `Could not save the connection (${res.status})`);
      await activate(body.connection as ConnectionSummary);
      toast(`Connected to ${name.trim()}`, { kind: "success" });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function onUseExisting(connection: ConnectionSummary): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await activate(connection);
      toast(`Connected to ${connection.name}`, { kind: "success" });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <FormStack>
      {active ? (
        <div className="rounded-md border bg-muted/40 p-3 text-sm">
          <div className="font-medium">{active.name}</div>
          <div className="font-mono text-xs text-muted-foreground">{active.dbPath}</div>
        </div>
      ) : null}

      {others.length > 0 ? (
        <FormRow>
          <div className="text-sm font-medium">Use a database this app already knows</div>
          <div className="space-y-1">
            {others.map((connection) => (
              <div
                key={connection.id}
                className="flex items-center gap-3 rounded-md border px-3 py-2"
              >
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm">{connection.name}</div>
                  <div className="truncate font-mono text-xs text-muted-foreground">
                    {connection.dbPath}
                  </div>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  onClick={() => void onUseExisting(connection)}
                >
                  Select
                </Button>
              </div>
            ))}
          </div>
        </FormRow>
      ) : null}

      <FormRow>
        <Label htmlFor="setup-conn-name">{active ? "Add another engine" : "Name"}</Label>
        <Input
          id="setup-conn-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="local-engine"
          disabled={busy}
        />
      </FormRow>

      <FormRow>
        <Label htmlFor="setup-db-path">Engine state database</Label>
        <Input
          id="setup-db-path"
          value={dbPath}
          onChange={(e) => onDbPathChange(e.target.value)}
          placeholder="/var/lib/operator/state/operator.db"
          disabled={busy}
          className="font-mono text-xs"
        />
        <p className="m-0 text-xs text-muted-foreground">
          The engine writes this file; the app reads and edits configuration in it. It is created
          if it does not exist yet, so you can point at the path the engine will use and continue.
          Both processes must see the same file — in Docker, that is the shared volume.
        </p>
      </FormRow>

      {error ? <ErrorAlert message={error} /> : null}

      <InlineActions>
        <Button
          type="button"
          disabled={busy || name.trim().length === 0 || dbPath.trim().length === 0}
          onClick={() => void onCreate()}
        >
          {busy ? "Connecting…" : "Create and connect"}
        </Button>
      </InlineActions>
    </FormStack>
  );
}
