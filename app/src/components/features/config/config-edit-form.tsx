"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { CodeBlock } from "@/components/shared/code-view";
import { ErrorAlert } from "@/components/shared/error-alert";
import { InlineActions } from "@/components/shared/inline-actions";
import { useToast } from "@/components/shared/toaster";
import { cn } from "@/lib/cn";

export interface ConfigEditFormProps {
  readonly category: string;
  readonly rowKey: string;
  readonly initialValue: unknown;
  readonly initialVersion: number;
  readonly readonly: boolean;
  readonly readonlyReason?: string;
  readonly canReset: boolean;
}

export function ConfigEditForm(props: ConfigEditFormProps): React.ReactElement {
  const router = useRouter();
  const toast = useToast();
  const initialText = useMemo(
    () => JSON.stringify(props.initialValue, null, 2),
    [props.initialValue],
  );
  const [text, setText] = useState(initialText);
  const [syntaxError, setSyntaxError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [schemaJson, setSchemaJson] = useState<string | null>(null);
  const [schemaExpanded, setSchemaExpanded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/kv/${encodeURIComponent(props.category)}/schema`)
      .then((r) => (r.ok ? r.json() : null))
      .then((body) => {
        if (cancelled || !body) return;
        setSchemaJson(JSON.stringify(body.schema, null, 2));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [props.category]);

  function validate(raw: string): { ok: true; value: unknown } | { ok: false; error: string } {
    try {
      return { ok: true, value: JSON.parse(raw) };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async function onSave(): Promise<void> {
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
        `/api/kv/${encodeURIComponent(props.category)}/${encodeURIComponent(props.rowKey)}`,
        {
          method: "PUT",
          headers: {
            "Content-Type": "application/json",
            "If-Match": String(props.initialVersion),
          },
          body: JSON.stringify({
            value: parsed.value,
            expectedVersion: props.initialVersion,
          }),
        },
      );
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        const hint = res.status === 409 ? " (row was modified in another tab — reload)" : "";
        toast("Save failed", {
          kind: "error",
          description: `${body.error ?? `HTTP ${res.status}`}${hint}`,
        });
        return;
      }
      toast(`Saved version ${body.metadata?.version ?? "?"}`, { kind: "success" });
      setTimeout(() => {
        router.push(
          `/config/${encodeURIComponent(props.category)}/${encodeURIComponent(props.rowKey)}`,
        );
        router.refresh();
      }, 400);
    } catch (err) {
      toast("Save failed", {
        kind: "error",
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setSaving(false);
    }
  }

  async function onReset(): Promise<void> {
    if (
      !confirm(
        `Reset ${props.category}/${props.rowKey} to shipped baseline? Current edits will be lost.`,
      )
    ) {
      return;
    }
    setSaving(true);
    try {
      const res = await fetch(
        `/api/kv/${encodeURIComponent(props.category)}/${encodeURIComponent(props.rowKey)}/reset`,
        { method: "POST" },
      );
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast("Reset failed", {
          kind: "error",
          description: body.error ?? `HTTP ${res.status}`,
        });
        return;
      }
      toast("Reset to baseline.", { kind: "success" });
      setTimeout(() => {
        router.push(
          `/config/${encodeURIComponent(props.category)}/${encodeURIComponent(props.rowKey)}`,
        );
        router.refresh();
      }, 400);
    } catch (err) {
      toast("Reset failed", {
        kind: "error",
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setSaving(false);
    }
  }

  const disabled = props.readonly || saving;
  return (
    <div className="space-y-4">
      {props.readonly ? (
        <ErrorAlert
          title="Read-only row"
          message={props.readonlyReason ?? "This row cannot be edited from the UI."}
        />
      ) : null}

      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        disabled={disabled}
        spellCheck={false}
        rows={24}
        className={cn(
          "w-full rounded-md border bg-background p-3 font-mono text-xs leading-relaxed",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          "disabled:cursor-not-allowed disabled:opacity-60",
        )}
      />

      {syntaxError ? <ErrorAlert title="JSON syntax" message={syntaxError} /> : null}

      <InlineActions className="justify-end">
        {props.canReset && !props.readonly ? (
          <Button type="button" variant="outline" onClick={onReset} disabled={saving}>
            Reset to baseline
          </Button>
        ) : null}
        {!props.readonly ? (
          <Button type="button" onClick={onSave} disabled={saving}>
            {saving ? "Saving..." : "Save"}
          </Button>
        ) : null}
      </InlineActions>

      {schemaJson ? (
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-3">
            <CardTitle className="text-base">Schema</CardTitle>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setSchemaExpanded((x) => !x)}
            >
              {schemaExpanded ? "Hide" : "Show"}
            </Button>
          </CardHeader>
          <CardContent>
            {schemaExpanded ? (
              <CodeBlock content={schemaJson} />
            ) : (
              <p className="m-0 text-sm text-muted-foreground">
                Click &quot;Show&quot; to view the JSON Schema used for validation on save.
              </p>
            )}
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
