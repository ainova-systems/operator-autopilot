"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { AlertCircle, X } from "lucide-react";
import { cn } from "@/lib/cn";

interface DialogProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly children: ReactNode;
  readonly className?: string;
}

export function Dialog({
  open,
  onClose,
  children,
  className,
}: DialogProps): React.ReactElement {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) el.showModal();
    if (!open && el.open) el.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onClick={(e) => {
        // Native <dialog> fires e.target === dialog for BOTH backdrop
        // clicks AND clicks on the dialog's own padding (whitespace
        // between children). To close only on real backdrop clicks,
        // verify the click coordinate is outside the dialog's box.
        // Without this check, typing in an input that the click lands
        // near, or clicking on padding above/below the form, closed
        // the modal mid-edit.
        if (e.target !== ref.current) return;
        const rect = ref.current.getBoundingClientRect();
        const insideBox =
          e.clientX >= rect.left &&
          e.clientX <= rect.right &&
          e.clientY >= rect.top &&
          e.clientY <= rect.bottom;
        if (!insideBox) onClose();
      }}
      className={cn(
        "fixed inset-0 z-50 m-auto w-full max-w-md rounded-lg border bg-card p-0 text-card-foreground shadow-lg backdrop:bg-black/60",
        "open:animate-in open:fade-in-0 open:zoom-in-95",
        className,
      )}
    >
      {open && children}
    </dialog>
  );
}

export function DialogHeader({
  title,
  description,
  onClose,
}: {
  readonly title: string;
  readonly description?: string;
  readonly onClose: () => void;
}): React.ReactElement {
  return (
    <div className="flex items-start justify-between px-5 pt-5 pb-2">
      <div>
        <h2 className="text-base font-semibold m-0">{title}</h2>
        {description ? (
          <p className="text-sm text-muted-foreground mt-0.5 m-0">{description}</p>
        ) : null}
      </div>
      <button
        type="button"
        onClick={onClose}
        aria-label="Close"
        className="p-1 rounded-md hover:bg-muted text-muted-foreground"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}

export function DialogBody({ children }: { readonly children: ReactNode }): React.ReactElement {
  return <div className="px-5 py-2 space-y-4">{children}</div>;
}

export function DialogFooter({
  children,
}: {
  readonly children: ReactNode;
}): React.ReactElement {
  return (
    <div className="flex items-center justify-end gap-2 px-5 py-4 mt-2 border-t">
      {children}
    </div>
  );
}

export function DialogError({
  message,
  onDismiss,
}: {
  readonly message: string | null;
  readonly onDismiss?: () => void;
}): React.ReactElement | null {
  if (!message) return null;
  return (
    <div className="mx-5 mt-1 mb-1 flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
      <AlertCircle className="h-4 w-4 mt-0.5 flex-shrink-0" />
      <span className="flex-1 break-words">{message}</span>
      {onDismiss ? (
        <button
          type="button"
          onClick={onDismiss}
          className="opacity-70 hover:opacity-100"
          aria-label="Dismiss"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      ) : null}
    </div>
  );
}

export function DialogInfo({
  children,
}: {
  readonly children: ReactNode;
}): React.ReactElement {
  return (
    <div className="mx-5 mt-1 mb-1 rounded-md border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
      {children}
    </div>
  );
}
