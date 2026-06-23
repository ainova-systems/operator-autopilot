import Link from "next/link";
import { ChevronDown, SlidersHorizontal } from "lucide-react";
import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { SectionLabel } from "@/components/shared/section-label";
import { cn } from "@/lib/cn";

/**
 * Shared list-page filter toolbar primitives.
 *
 * Every list route composes the same skeleton: an inline row with the
 * search input and a handful of quick toggles, followed by an optional
 * collapsible "More filters" panel for per-facet chips. These exports
 * keep that shell consistent — each page only provides its own data and
 * URL construction.
 */

export function ListToolbar({
  children,
  className,
}: {
  readonly children: ReactNode;
  readonly className?: string;
}): React.ReactElement {
  return <div className={cn("mb-4 space-y-3", className)}>{children}</div>;
}

export function ListToolbarRow({
  children,
  className,
}: {
  readonly children: ReactNode;
  readonly className?: string;
}): React.ReactElement {
  return (
    <div className={cn("flex flex-wrap items-center gap-2", className)}>
      {children}
    </div>
  );
}

interface ListToolbarToggleProps {
  readonly href: string;
  readonly selected: boolean;
  readonly count?: number;
  readonly title?: string;
  readonly children: ReactNode;
}

export function ListToolbarToggle({
  href,
  selected,
  count,
  title,
  children,
}: ListToolbarToggleProps): React.ReactElement {
  return (
    <Link href={href}>
      <Button
        variant={selected ? "secondary" : "outline"}
        size="sm"
        title={title}
      >
        {children}
        {count != null ? (
          <span className="ml-1 text-xs text-muted-foreground">{count}</span>
        ) : null}
      </Button>
    </Link>
  );
}

export function ListToolbarClear({
  href,
}: {
  readonly href: string;
}): React.ReactElement {
  return (
    <Link
      href={href}
      className="text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
    >
      Clear all
    </Link>
  );
}

interface SummaryBadge {
  readonly label: string;
  readonly value: string;
}

export function ListToolbarMore({
  children,
  open,
  label = "More filters",
  summary,
}: {
  readonly children: ReactNode;
  readonly open: boolean;
  readonly label?: string;
  readonly summary?: ReadonlyArray<SummaryBadge>;
}): React.ReactElement {
  return (
    <details open={open} className="group rounded-md border bg-card/40">
      <summary className="flex cursor-pointer select-none list-none items-center gap-2 px-3 py-2 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground [&::-webkit-details-marker]:hidden">
        <SlidersHorizontal className="h-3.5 w-3.5" />
        <span>{label}</span>
        {summary?.map((s) => (
          <Badge key={s.label} variant="secondary" className="font-normal">
            {s.label}: {s.value}
          </Badge>
        ))}
        <ChevronDown className="ml-auto h-3.5 w-3.5 transition-transform group-open:rotate-180" />
      </summary>
      <div className="space-y-3 border-t px-3 py-3">{children}</div>
    </details>
  );
}

interface FacetValue {
  readonly value: string;
  readonly count: number;
  readonly href: string;
}

interface FacetRowProps {
  readonly label: string;
  readonly selected: string | undefined;
  readonly total: number;
  readonly totalHref: string;
  readonly values: ReadonlyArray<FacetValue>;
}

export function FacetRow({
  label,
  selected,
  total,
  totalHref,
  values,
}: FacetRowProps): React.ReactElement {
  return (
    <div>
      <SectionLabel>{label}</SectionLabel>
      <div className="flex flex-wrap items-center gap-2 px-3">
        <Link href={totalHref}>
          <Button variant={selected ? "outline" : "secondary"} size="sm">
            all
            <span className="ml-1 text-xs text-muted-foreground">{total}</span>
          </Button>
        </Link>
        {values.map((v) => (
          <Link key={v.value} href={v.href}>
            <Button
              variant={selected === v.value ? "secondary" : "outline"}
              size="sm"
            >
              {v.value}
              <span className="ml-1 text-xs text-muted-foreground">{v.count}</span>
            </Button>
          </Link>
        ))}
      </div>
    </div>
  );
}
