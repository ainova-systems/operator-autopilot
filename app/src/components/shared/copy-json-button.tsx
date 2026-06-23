"use client";

import { Check, Copy } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/shared/toaster";

interface CopyJsonButtonProps {
  readonly payload: unknown;
  readonly label?: string;
  readonly filename?: string;
}

export function CopyJsonButton({
  payload,
  label = "Copy JSON",
}: CopyJsonButtonProps): React.ReactElement {
  const toast = useToast();
  const [copied, setCopied] = useState(false);

  async function onCopy(): Promise<void> {
    const text = JSON.stringify(payload, null, 2);
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
      } else {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
      }
      setCopied(true);
      toast("Copied to clipboard", {
        kind: "success",
        description: `${text.length.toLocaleString()} characters`,
      });
      setTimeout(() => setCopied(false), 1500);
    } catch (err) {
      toast("Copy failed", {
        kind: "error",
        description: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return (
    <Button type="button" variant="outline" size="sm" onClick={onCopy}>
      {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
      {label}
    </Button>
  );
}
