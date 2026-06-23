import { AlertCircle } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

interface ErrorAlertProps {
  readonly title?: string;
  readonly message: ReactNode;
  readonly className?: string;
}

export function ErrorAlert({
  title,
  message,
  className,
}: ErrorAlertProps): React.ReactElement {
  return (
    <div
      className={cn(
        "flex items-start gap-3 rounded-md border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive",
        className,
      )}
      role="alert"
    >
      <AlertCircle className="mt-0.5 h-5 w-5 flex-shrink-0" />
      <div className="flex-1 space-y-1">
        {title ? <p className="m-0 font-medium">{title}</p> : null}
        <div className="opacity-90">{message}</div>
      </div>
    </div>
  );
}
