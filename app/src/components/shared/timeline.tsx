import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

/**
 * Vertical timeline primitive. Renders a stacked sequence of events with
 * a dot + connector rail on the left and an expandable content area on
 * the right. Each event collapses by default; consumers pass richer
 * `details` that render only when the `<details>` block is open. No
 * client JS required — uses the native `<details>/<summary>` element.
 */
export function Timeline({
  children,
  className,
}: {
  readonly children: ReactNode;
  readonly className?: string;
}): React.ReactElement {
  return (
    <ol className={cn("relative m-0 list-none space-y-4 pl-0", className)}>
      {children}
    </ol>
  );
}

export type TimelineTone =
  | "default"
  | "success"
  | "warning"
  | "destructive"
  | "info";

const TONE_DOT: Record<TimelineTone, string> = {
  default: "bg-foreground/55 ring-foreground/15",
  success: "bg-functional-success ring-functional-success/30",
  warning: "bg-functional-warning ring-functional-warning/30",
  destructive: "bg-destructive ring-destructive/30",
  info: "bg-primary ring-primary/30",
};

interface TimelineEventProps {
  readonly time?: string;
  readonly title: ReactNode;
  readonly subtitle?: ReactNode;
  readonly badge?: ReactNode;
  readonly tone?: TimelineTone;
  readonly details?: ReactNode;
  readonly isLast?: boolean;
  readonly pulse?: boolean;
}

export function TimelineEvent({
  time,
  title,
  subtitle,
  badge,
  tone = "default",
  details,
  isLast = false,
  pulse = false,
}: TimelineEventProps): React.ReactElement {
  return (
    <li className="relative pl-6">
      {/* rail */}
      {isLast ? null : (
        <span
          aria-hidden
          className="absolute left-[0.3125rem] top-4 bottom-0 w-px bg-border"
        />
      )}
      {/* dot */}
      <span
        aria-hidden
        className={cn(
          "absolute left-0 top-1.5 inline-block h-2.5 w-2.5 rounded-full ring-4",
          TONE_DOT[tone],
          pulse && "animate-pulse ring-8",
        )}
      />

      {details ? (
        <details className="group">
          <summary className="flex cursor-pointer select-none list-none flex-wrap items-center gap-2 text-sm transition-colors hover:text-foreground [&::-webkit-details-marker]:hidden">
            {time ? (
              <span className="font-mono text-xs text-muted-foreground">
                {time}
              </span>
            ) : null}
            {badge}
            <span className="font-medium">{title}</span>
            {subtitle ? (
              <span className="text-muted-foreground">· {subtitle}</span>
            ) : null}
            <span className="ml-auto text-xs text-muted-foreground opacity-60 group-open:opacity-100">
              click to expand
            </span>
          </summary>
          <div className="mt-2 space-y-2 rounded-md border bg-muted/20 p-3 text-xs">
            {details}
          </div>
        </details>
      ) : (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          {time ? (
            <span className="font-mono text-xs text-muted-foreground">
              {time}
            </span>
          ) : null}
          {badge}
          <span className="font-medium">{title}</span>
          {subtitle ? (
            <span className="text-muted-foreground">· {subtitle}</span>
          ) : null}
        </div>
      )}
    </li>
  );
}
