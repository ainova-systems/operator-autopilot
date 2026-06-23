import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

interface PageHeaderProps {
  readonly title: string;
  readonly description?: ReactNode;
  readonly badge?: ReactNode;
  readonly actions?: ReactNode;
  readonly bordered?: boolean;
  readonly backHref?: string;
  readonly backLabel?: string;
}

export function PageHeader({
  title,
  description,
  badge,
  actions,
  bordered,
  backHref,
  backLabel = "Back",
}: PageHeaderProps): React.ReactElement {
  return (
    <div className={cn("mb-6", bordered && "pb-4 border-b")}>
      <div className="flex items-start gap-3">
        {backHref ? (
          <Link
            href={backHref}
            aria-label={backLabel}
            title={backLabel}
            className={cn(
              "mt-1 inline-flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-md border",
              "text-muted-foreground transition-colors",
              "hover:border-primary hover:bg-accent hover:text-foreground",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            )}
          >
            <ArrowLeft className="h-5 w-5" />
          </Link>
        ) : null}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-3">
            <h1 className="m-0 truncate text-2xl font-semibold leading-tight">
              {title}
            </h1>
            {badge}
            {actions ? (
              <div className="ml-auto flex items-center gap-2">{actions}</div>
            ) : null}
          </div>
          {description ? (
            <div className="mt-1 text-sm text-muted-foreground">{description}</div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
