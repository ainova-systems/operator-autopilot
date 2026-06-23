"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ErrorAlert } from "@/components/shared/error-alert";
import { InlineActions } from "@/components/shared/inline-actions";
import { useToast } from "@/components/shared/toaster";
import { cn } from "@/lib/cn";

export interface NewRowFormProps {
  readonly category: string;
  /** JSON-stringified starter template the form preloads into the editor. */
  readonly starterTemplate: string;
  /** Suggested label for the id input (e.g. "Repo id", "Stage name"). */
  readonly keyLabel: string;
  /** Placeholder text inside the id input. */
  readonly keyPlaceholder?: string;
}

/**
 * Create a brand-new row in a KV category. Renders a key input + JSON
 * editor preloaded with a category-specific starter template. The PUT
 * route is shared with edits — `kv.put` is idempotent and creates the
 * row when missing. On success the user lands on the view page.
 */
export function NewRowForm(props: NewRowFormProps): React.ReactElement {
  const router = useRouter();
  const toast = useToast();
  const [rowKey, setRowKey] = useState("");
  const [text, setText] = useState(props.starterTemplate);
  const [syntaxError, setSyntaxError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const trimmedKey = rowKey.trim();

  function validate(raw: string): { ok: true; value: unknown } | { ok: false; error: string } {
    try {
      return { ok: true, value: JSON.parse(raw) };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async function onCreate(): Promise<void> {
    if (!trimmedKey) {
      toast(`${props.keyLabel} is required`, { kind: "error" });
      return;
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(trimmedKey)) {
      toast(`${props.keyLabel} must be alphanumeric (dash/underscore allowed)`, { kind: "error" });
      return;
    }
    const parsed = validate(text);
    if (!parsed.ok) {
      setSyntaxError(parsed.error);
      toast("JSON syntax error", { kind: "error", description: "Fix before saving." });
      return;
    }
    setSyntaxError(null);
    setSaving(true);
    try {
      const res = await fetch(
        `/api/kv/${encodeURIComponent(props.category)}/${encodeURIComponent(trimmedKey)}`,
        {
          method: "PUT",
          headers: {
            "Content-Type": "application/json",
            "If-Match": "0",
          },
          body: JSON.stringify({ value: parsed.value, expectedVersion: 0 }),
        },
      );
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        const hint = res.status === 409
          ? ` (key ${trimmedKey} already exists — open it from the list instead)`
          : "";
        toast("Create failed", {
          kind: "error",
          description: `${body.error ?? `HTTP ${res.status}`}${hint}`,
        });
        return;
      }
      toast(`Created ${props.category}/${trimmedKey}`, { kind: "success" });
      setTimeout(() => {
        router.push(`/config/${encodeURIComponent(props.category)}/${encodeURIComponent(trimmedKey)}`);
        router.refresh();
      }, 400);
    } catch (err) {
      toast("Create failed", {
        kind: "error",
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>New {props.category} entry</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <label htmlFor="row-key" className="text-sm font-medium">
            {props.keyLabel}
          </label>
          <input
            id="row-key"
            type="text"
            value={rowKey}
            onChange={(e) => setRowKey(e.target.value)}
            placeholder={props.keyPlaceholder}
            disabled={saving}
            className="w-full rounded-md border bg-background px-3 py-2 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-primary"
          />
          <p className="text-xs text-muted-foreground">
            Identifier used as the KV key. Alphanumeric, dash, or underscore.
          </p>
        </div>

        <div className="space-y-2">
          <label htmlFor="row-value" className="text-sm font-medium">
            Value (JSON)
          </label>
          <textarea
            id="row-value"
            value={text}
            onChange={(e) => setText(e.target.value)}
            disabled={saving}
            spellCheck={false}
            className={cn(
              "w-full min-h-[24rem] resize-y rounded-md border bg-background px-3 py-2 font-mono text-xs focus:outline-none focus:ring-2",
              syntaxError ? "focus:ring-destructive" : "focus:ring-primary",
            )}
          />
          {syntaxError ? <ErrorAlert title="JSON syntax error" message={syntaxError} /> : null}
        </div>

        <InlineActions>
          <Button onClick={onCreate} disabled={saving || !trimmedKey}>
            {saving ? "Creating…" : "Create"}
          </Button>
          <Button
            variant="outline"
            onClick={() => router.push(`/config/${encodeURIComponent(props.category)}`)}
            disabled={saving}
          >
            Cancel
          </Button>
        </InlineActions>
      </CardContent>
    </Card>
  );
}
