import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

export function InlineActions({
  children,
  className,
}: {
  readonly children: ReactNode;
  readonly className?: string;
}): React.ReactElement {
  return (
    <div className={cn("flex items-center gap-2", className)}>{children}</div>
  );
}
