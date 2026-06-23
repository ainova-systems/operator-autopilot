"use client";

import { Plus } from "lucide-react";
import { useState } from "react";
import { AddConnectionModal } from "./add-connection-modal";

export function AddConnectionButton(): React.ReactElement {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="mx-1 flex w-[calc(100%-0.5rem)] items-center justify-center gap-1.5 rounded-md border border-dashed px-3 py-2 text-sm text-muted-foreground transition-colors hover:border-primary hover:text-primary"
      >
        <Plus className="h-3.5 w-3.5" />
        Add connection
      </button>
      {open ? <AddConnectionModal onClose={() => setOpen(false)} /> : null}
    </>
  );
}
