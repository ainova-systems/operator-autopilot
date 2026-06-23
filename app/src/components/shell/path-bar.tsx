"use client";

import { Home, ChevronRight } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Fragment } from "react";

const ROOT_LABELS: Record<string, string> = {
  "work-items": "Work items",
  executions: "Executions",
  config: "Config",
  audit: "Audit",
  connections: "Connections",
  settings: "Settings",
  connect: "Connect",
  debug: "Debug",
  edit: "Edit",
};

function labelFor(segment: string): string {
  const decoded = decodeURIComponent(segment);
  return ROOT_LABELS[decoded] ?? decoded;
}

export function PathBar(): React.ReactElement {
  const pathname = usePathname() ?? "/";
  const rawSegments = pathname.split("/").filter(Boolean);

  const crumbs = rawSegments.map((seg, i) => {
    const href = "/" + rawSegments.slice(0, i + 1).join("/");
    return { href, label: labelFor(seg), isLast: i === rawSegments.length - 1 };
  });

  return (
    <nav
      aria-label="Breadcrumb"
      className="flex flex-shrink-0 items-center gap-1 border-b bg-background/80 px-4 py-2 text-xs text-muted-foreground backdrop-blur sm:px-6 lg:px-8"
    >
      <Link
        href="/"
        aria-label="Home"
        className="inline-flex h-6 w-6 items-center justify-center rounded-sm hover:bg-muted hover:text-foreground"
      >
        <Home className="h-3.5 w-3.5" />
      </Link>
      {crumbs.map(({ href, label, isLast }) => (
        <Fragment key={href}>
          <ChevronRight className="h-3 w-3 flex-shrink-0 opacity-50" aria-hidden />
          {isLast ? (
            <span className="truncate text-foreground">{label}</span>
          ) : (
            <Link href={href} className="truncate hover:text-foreground">
              {label}
            </Link>
          )}
        </Fragment>
      ))}
    </nav>
  );
}
