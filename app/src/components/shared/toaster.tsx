"use client";

import { AlertCircle, CheckCircle2, Info, X } from "lucide-react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { cn } from "@/lib/cn";

type ToastKind = "default" | "success" | "error";

interface ToastOptions {
  readonly description?: string;
  readonly kind?: ToastKind;
  readonly duration?: number;
}

interface ToastRecord {
  readonly id: number;
  readonly title: string;
  readonly description?: string;
  readonly kind: ToastKind;
}

type ShowToast = (title: string, opts?: ToastOptions) => void;

const ToastContext = createContext<ShowToast | null>(null);

export function useToast(): ShowToast {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used inside <Toaster>");
  return ctx;
}

const DEFAULT_DURATION = 4000;
const kindStyles: Record<ToastKind, string> = {
  default: "border-border bg-card",
  success:
    "border-functional-success/40 bg-functional-success/10 text-functional-success",
  error: "border-destructive/40 bg-destructive/10 text-destructive",
};
const kindIcon: Record<ToastKind, typeof Info> = {
  default: Info,
  success: CheckCircle2,
  error: AlertCircle,
};

export function Toaster({
  children,
}: {
  readonly children: ReactNode;
}): React.ReactElement {
  const [toasts, setToasts] = useState<ToastRecord[]>([]);
  const nextIdRef = useRef(1);

  const dismiss = useCallback((id: number) => {
    setToasts((cur) => cur.filter((t) => t.id !== id));
  }, []);

  const show = useCallback<ShowToast>(
    (title, opts) => {
      const id = nextIdRef.current++;
      const record: ToastRecord = {
        id,
        title,
        description: opts?.description,
        kind: opts?.kind ?? "default",
      };
      setToasts((cur) => [...cur, record]);
      const duration = opts?.duration ?? DEFAULT_DURATION;
      if (duration > 0) {
        setTimeout(() => dismiss(id), duration);
      }
    },
    [dismiss],
  );

  return (
    <ToastContext.Provider value={show}>
      {children}
      <ToastViewport toasts={toasts} onDismiss={dismiss} />
    </ToastContext.Provider>
  );
}

function ToastViewport({
  toasts,
  onDismiss,
}: {
  readonly toasts: ReadonlyArray<ToastRecord>;
  readonly onDismiss: (id: number) => void;
}): React.ReactElement {
  return (
    <div
      aria-live="polite"
      className="pointer-events-none fixed bottom-4 right-4 z-[100] flex w-full max-w-sm flex-col gap-2"
    >
      {toasts.map((t) => (
        <ToastItem key={t.id} toast={t} onDismiss={() => onDismiss(t.id)} />
      ))}
    </div>
  );
}

function ToastItem({
  toast,
  onDismiss,
}: {
  readonly toast: ToastRecord;
  readonly onDismiss: () => void;
}): React.ReactElement {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setVisible(true), 10);
    return () => clearTimeout(t);
  }, []);
  const Icon = kindIcon[toast.kind];
  return (
    <div
      className={cn(
        "pointer-events-auto flex items-start gap-2 rounded-md border p-3 text-sm shadow-lg transition-all",
        kindStyles[toast.kind],
        visible ? "translate-y-0 opacity-100" : "translate-y-2 opacity-0",
      )}
    >
      <Icon className="mt-0.5 h-4 w-4 flex-shrink-0" />
      <div className="min-w-0 flex-1">
        <p className="m-0 font-medium">{toast.title}</p>
        {toast.description ? (
          <p className="m-0 mt-0.5 text-xs opacity-80">{toast.description}</p>
        ) : null}
      </div>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss"
        className="text-muted-foreground opacity-70 hover:opacity-100"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
