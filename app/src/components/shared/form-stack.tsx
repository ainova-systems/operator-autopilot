import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

export function FormStack({
  children,
  className,
}: {
  readonly children: ReactNode;
  readonly className?: string;
}): React.ReactElement {
  return <div className={cn("space-y-4", className)}>{children}</div>;
}

export function FormRow({
  children,
  className,
}: {
  readonly children: ReactNode;
  readonly className?: string;
}): React.ReactElement {
  return <div className={cn("space-y-1.5", className)}>{children}</div>;
}
