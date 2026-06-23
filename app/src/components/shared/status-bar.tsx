import type { ReactNode } from "react";

interface StatusBarProps {
  readonly items: ReadonlyArray<ReactNode>;
}

export function StatusBar({ items }: StatusBarProps): React.ReactElement {
  return (
    <div className="flex flex-shrink-0 items-center gap-4 border-t px-4 py-2 text-xs text-muted-foreground">
      {items.map((item, i) => (
        <span key={i}>{item}</span>
      ))}
    </div>
  );
}
