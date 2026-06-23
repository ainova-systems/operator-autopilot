import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

export function Sidebar({
  children,
  className,
}: {
  readonly children: ReactNode;
  readonly className?: string;
}): React.ReactElement {
  return (
    <aside
      className={cn(
        "flex w-64 flex-shrink-0 flex-col gap-4 border-r bg-card/60 py-4",
        className,
      )}
    >
      {children}
    </aside>
  );
}

export function SidebarBrand({
  name,
  subtitle,
}: {
  readonly name: string;
  readonly subtitle?: string;
}): React.ReactElement {
  return (
    <div>
      <div className="text-base font-semibold leading-tight">{name}</div>
      {subtitle ? (
        <div className="text-xs text-muted-foreground">{subtitle}</div>
      ) : null}
    </div>
  );
}

export function SidebarSection({
  children,
  className,
}: {
  readonly children: ReactNode;
  readonly className?: string;
}): React.ReactElement {
  return (
    <div className={cn("flex flex-col gap-0.5 px-2", className)}>{children}</div>
  );
}
