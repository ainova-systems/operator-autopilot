import type { ReactNode } from "react";

export function SectionLabel({
  children,
}: {
  readonly children: ReactNode;
}): React.ReactElement {
  return (
    <div className="flex-shrink-0 px-3 py-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
      {children}
    </div>
  );
}
