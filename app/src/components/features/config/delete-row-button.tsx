"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/shared/toaster";

export interface DeleteRowButtonProps {
  readonly category: string;
  readonly rowKey: string;
}

/**
 * Delete one KV row through `DELETE /api/kv/[category]/[key]`. Renders a
 * destructive button gated behind a confirm dialog. On success the user is
 * redirected back to the category list. The route rejects readonly rows
 * (403) and the caller only mounts this button for non-readonly,
 * non-baseline rows, so the common error path here is a transient API
 * failure surfaced through the toast.
 */
export function DeleteRowButton(props: DeleteRowButtonProps): React.ReactElement {
  const router = useRouter();
  const toast = useToast();
  const [deleting, setDeleting] = useState(false);

  async function onDelete(): Promise<void> {
    if (!confirm(`Delete ${props.category}/${props.rowKey}? This cannot be undone.`)) {
      return;
    }
    setDeleting(true);
    try {
      const res = await fetch(
        `/api/kv/${encodeURIComponent(props.category)}/${encodeURIComponent(props.rowKey)}`,
        { method: "DELETE" },
      );
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast("Delete failed", {
          kind: "error",
          description: body.error ?? `HTTP ${res.status}`,
        });
        return;
      }
      toast(`Deleted ${props.category}/${props.rowKey}`, { kind: "success" });
      setTimeout(() => {
        router.push(`/config/${encodeURIComponent(props.category)}`);
        router.refresh();
      }, 400);
    } catch (err) {
      toast("Delete failed", {
        kind: "error",
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setDeleting(false);
    }
  }

  return (
    <Button
      type="button"
      variant="destructive"
      size="sm"
      onClick={onDelete}
      disabled={deleting}
    >
      <Trash2 className="h-4 w-4" />
      {deleting ? "Deleting…" : "Delete"}
    </Button>
  );
}
