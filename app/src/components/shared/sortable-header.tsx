import Link from "next/link";
import { ArrowDown, ArrowUp, ArrowUpDown } from "lucide-react";
import type { ReactNode } from "react";
import { TableHead } from "@/components/ui/table";
import { cn } from "@/lib/cn";
import { nextSort, type SortDir, type SortState } from "@/lib/sort";

/**
 * Server-rendered, link-driven sortable column header.
 *
 * Each click navigates to a new URL produced by `buildHref` with the
 * tri-state cycle (none → asc → desc → none). Pages remain server
 * components; sort state lives in `searchParams` alongside the existing
 * filter parameters.
 */
export function SortableHeader<C extends string>({
  column,
  label,
  current,
  buildHref,
  title,
  className,
}: {
  readonly column: C;
  readonly label: ReactNode;
  readonly current: SortState<C>;
  readonly buildHref: (sort: C | undefined, dir: SortDir | undefined) => string;
  readonly title?: string;
  readonly className?: string;
}): React.ReactElement {
  const next = nextSort(current, column);
  const active = current.sort === column;
  const Icon = !active ? ArrowUpDown : current.dir === "asc" ? ArrowUp : ArrowDown;
  return (
    <TableHead className={className}>
      <Link
        href={buildHref(next.sort, next.dir)}
        className={cn(
          "inline-flex items-center gap-1 hover:text-foreground",
          active ? "text-foreground" : undefined,
        )}
        title={title}
        scroll={false}
      >
        <span>{label}</span>
        <Icon className={cn("h-3 w-3", active ? "opacity-100" : "opacity-40")} />
      </Link>
    </TableHead>
  );
}
