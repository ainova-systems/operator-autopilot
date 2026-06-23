"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogError,
  DialogFooter,
  DialogHeader,
  DialogInfo,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { FormRow } from "@/components/shared/form-stack";
import { useToast } from "@/components/shared/toaster";

type TestState =
  | { readonly kind: "idle" }
  | { readonly kind: "testing"; readonly message: string }
  | { readonly kind: "ok"; readonly message: string }
  | { readonly kind: "err"; readonly message: string };

export function AddConnectionModal({
  onClose,
}: {
  readonly onClose: () => void;
}): React.ReactElement {
  const router = useRouter();
  const toast = useToast();
  const [name, setName] = useState("");
  const [dbPath, setDbPath] = useState("");
  const [saving, setSaving] = useState(false);
  const [test, setTest] = useState<TestState>({ kind: "idle" });
  const [saveError, setSaveError] = useState<string | null>(null);

  async function onTest(): Promise<void> {
    if (!name || !dbPath) {
      setTest({ kind: "err", message: "Name and path are required before testing" });
      return;
    }
    setTest({ kind: "testing", message: "Opening database..." });
    try {
      const res = await fetch("/api/app/connections/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, dbPath }),
      });
      const body = await res.json();
      if (res.ok && body.ok) {
        setTest({ kind: "ok", message: body.message ?? "Connection OK" });
      } else {
        setTest({ kind: "err", message: body.message ?? body.error ?? "Test failed" });
      }
    } catch (err) {
      setTest({ kind: "err", message: err instanceof Error ? err.message : String(err) });
    }
  }

  async function onSave(e: FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    setSaving(true);
    setSaveError(null);
    try {
      const res = await fetch("/api/app/connections", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, dbPath }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setSaveError(body.error ?? `Save failed (${res.status})`);
        setSaving(false);
        return;
      }
      const body = await res.json();
      const connectionId = body.connection?.id;
      if (connectionId) {
        await fetch("/api/app/active-connection", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: connectionId }),
        });
      }
      toast(`Connected to ${name}`, { kind: "success" });
      onClose();
      router.refresh();
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
      setSaving(false);
    }
  }

  return (
    <Dialog open onClose={onClose}>
      <DialogHeader
        title="Add connection"
        description="Point the app at a running engine's SQLite state file."
        onClose={onClose}
      />
      <form onSubmit={onSave} className="contents">
        <DialogBody>
          <FormRow>
            <Label htmlFor="conn-name">Name</Label>
            <Input
              id="conn-name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="local-engine"
              required
            />
          </FormRow>
          <FormRow>
            <Label htmlFor="conn-path">SQLite database path</Label>
            <Input
              id="conn-path"
              type="text"
              value={dbPath}
              onChange={(e) => setDbPath(e.target.value)}
              placeholder="/abs/path/to/state/operator.db"
              required
            />
          </FormRow>

          {test.kind === "testing" ? <DialogInfo>{test.message}</DialogInfo> : null}
          {test.kind === "ok" ? (
            <div className="rounded-md border border-functional-success/40 bg-functional-success/10 px-3 py-2 text-sm text-functional-success">
              {test.message}
            </div>
          ) : null}
        </DialogBody>
        <DialogError
          message={test.kind === "err" ? test.message : saveError}
          onDismiss={() => {
            setSaveError(null);
            if (test.kind === "err") setTest({ kind: "idle" });
          }}
        />
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="button" variant="outline" onClick={onTest} disabled={saving}>
            Test
          </Button>
          <Button type="submit" disabled={saving}>
            {saving ? "Saving..." : "Save"}
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}
