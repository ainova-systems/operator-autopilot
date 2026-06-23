"use client";

import { Pencil, Power, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogFooter,
  DialogHeader,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { EmptyState } from "@/components/shared/empty-state";
import { FormRow } from "@/components/shared/form-stack";
import { InlineActions } from "@/components/shared/inline-actions";
import { useToast } from "@/components/shared/toaster";
import type { Connection } from "@/lib/connection-types";

interface Props {
  readonly connections: readonly Connection[];
  readonly activeId: string | null;
}

type EditingState =
  | { readonly kind: "none" }
  | {
      readonly kind: "edit";
      readonly id: string;
      readonly name: string;
      readonly dbPath: string;
    };

export function ConnectionsManager({
  connections,
  activeId,
}: Props): React.ReactElement {
  const router = useRouter();
  const toast = useToast();
  const [editing, setEditing] = useState<EditingState>({ kind: "none" });
  const [busy, setBusy] = useState(false);

  async function onRemove(c: Connection): Promise<void> {
    if (
      !confirm(
        `Remove connection "${c.name}"? The SQLite file at ${c.dbPath} will NOT be deleted.`,
      )
    )
      return;
    setBusy(true);
    try {
      const res = await fetch(
        `/api/app/connections/${encodeURIComponent(c.id)}`,
        { method: "DELETE" },
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        toast("Remove failed", {
          kind: "error",
          description: body.error ?? `HTTP ${res.status}`,
        });
        return;
      }
      const wasActive = c.id === activeId;
      toast(
        wasActive
          ? `Removed "${c.name}" — pick another connection to continue`
          : `Removed connection "${c.name}"`,
      );
      // Stay on /connections either way. Server components on this
      // page + LeftRail re-render and reflect the deletion; the user
      // sees the remaining connections list and can switch to another
      // without being bounced to the empty home page.
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  async function onSwitch(c: Connection): Promise<void> {
    if (c.id === activeId) return;
    setBusy(true);
    try {
      const res = await fetch("/api/app/active-connection", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: c.id }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        toast("Switch failed", {
          kind: "error",
          description: body.error ?? `HTTP ${res.status}`,
        });
        return;
      }
      toast(`Switched to "${c.name}"`);
      // Stay on /connections — user is here to manage, not to be
      // bounced to /work-items mid-click. Refresh invalidates server
      // components so the active badge moves, the "Disconnect active"
      // button appears, and the LeftRail connection list reflects the
      // new selection in place.
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  async function onDisconnect(): Promise<void> {
    setBusy(true);
    try {
      const res = await fetch("/api/app/active-connection", { method: "DELETE" });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        toast("Disconnect failed", {
          kind: "error",
          description: body.error ?? `HTTP ${res.status}`,
        });
        return;
      }
      toast("Disconnected — pick another connection to continue");
      // Stay on /connections — the user came here to manage connections,
      // bouncing them to the empty home page right after a click is
      // disorienting. Refresh invalidates server components so the
      // active badge, "Disconnect active" button, and LeftRail all
      // update in place.
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  function startEdit(c: Connection): void {
    setEditing({ kind: "edit", id: c.id, name: c.name, dbPath: c.dbPath });
  }

  async function onSaveEdit(e: FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    if (editing.kind !== "edit") return;
    setBusy(true);
    try {
      const res = await fetch(
        `/api/app/connections/${encodeURIComponent(editing.id)}`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: editing.name, dbPath: editing.dbPath }),
        },
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        toast("Save failed", {
          kind: "error",
          description: body.error ?? `HTTP ${res.status}`,
        });
        return;
      }
      toast(`Saved connection "${editing.name}"`, { kind: "success" });
      setEditing({ kind: "none" });
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  if (connections.length === 0) {
    return (
      <EmptyState
        title="No connections yet"
        description="Add one from the left rail to start observing an operator instance."
        dashed
      />
    );
  }

  return (
    <div className="space-y-4">
      <div className="rounded-lg border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>DB path</TableHead>
              <TableHead>Last used</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {connections.map((c) => {
              const active = c.id === activeId;
              return (
                <TableRow key={c.id}>
                  <TableCell className="font-medium">{c.name}</TableCell>
                  <TableCell>
                    <code className="font-mono text-xs">{c.dbPath}</code>
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {c.lastUsedAt ?? "—"}
                  </TableCell>
                  <TableCell>
                    {active ? (
                      <Badge variant="success">active</Badge>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    <InlineActions className="justify-end">
                      <Button
                        type="button"
                        variant={active ? "secondary" : "outline"}
                        size="sm"
                        onClick={() => onSwitch(c)}
                        disabled={busy || active}
                        title={
                          active
                            ? "This connection is already active"
                            : "Make this the active connection"
                        }
                      >
                        {active ? "Active" : "Switch"}
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        aria-label="Edit"
                        onClick={() => startEdit(c)}
                        disabled={busy}
                      >
                        <Pencil className="h-4 w-4" />
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        aria-label="Remove"
                        onClick={() => onRemove(c)}
                        disabled={busy}
                        className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </InlineActions>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>

      {activeId ? (
        <div>
          <Button
            type="button"
            variant="outline"
            onClick={onDisconnect}
            disabled={busy}
          >
            <Power className="h-4 w-4" />
            Disconnect active
          </Button>
        </div>
      ) : null}

      {editing.kind === "edit" ? (
        <Dialog open onClose={() => setEditing({ kind: "none" })}>
          <DialogHeader
            title="Edit connection"
            onClose={() => setEditing({ kind: "none" })}
          />
          <form onSubmit={onSaveEdit} className="contents">
            <DialogBody>
              <FormRow>
                <Label htmlFor="edit-name">Name</Label>
                <Input
                  id="edit-name"
                  value={editing.name}
                  onChange={(e) =>
                    setEditing({ ...editing, name: e.target.value })
                  }
                  required
                />
              </FormRow>
              <FormRow>
                <Label htmlFor="edit-path">SQLite database path</Label>
                <Input
                  id="edit-path"
                  value={editing.dbPath}
                  onChange={(e) =>
                    setEditing({ ...editing, dbPath: e.target.value })
                  }
                  required
                />
              </FormRow>
            </DialogBody>
            <DialogFooter>
              <Button
                type="button"
                variant="ghost"
                onClick={() => setEditing({ kind: "none" })}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={busy}>
                {busy ? "Saving..." : "Save"}
              </Button>
            </DialogFooter>
          </form>
        </Dialog>
      ) : null}
    </div>
  );
}
