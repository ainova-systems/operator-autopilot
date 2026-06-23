import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

interface EmptyStateProps {
  readonly icon?: LucideIcon;
  readonly title: string;
  readonly description?: ReactNode;
  readonly dashed?: boolean;
  readonly compact?: boolean;
  readonly variant?: "default" | "error";
  readonly children?: ReactNode;
}

export function EmptyState({
  icon: Icon,
  title,
  description,
  dashed,
  compact,
  variant = "default",
  children,
}: EmptyStateProps): React.ReactElement {
  const isError = variant === "error";

  if (compact) {
    return (
      <p
        className={cn(
          "m-0 p-3 text-sm",
          isError ? "text-destructive" : "text-muted-foreground",
        )}
      >
        {title}
      </p>
    );
  }

  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-3 py-16 text-center",
        isError ? "text-destructive" : "text-muted-foreground",
        dashed && "rounded-lg border border-dashed",
        dashed && isError && "border-destructive/30",
      )}
    >
      {Icon ? <Icon className="h-8 w-8" /> : null}
      <p className="m-0 text-base font-medium text-foreground">{title}</p>
      {description ? (
        <div className="max-w-md text-sm">{description}</div>
      ) : null}
      {children}
    </div>
  );
}
