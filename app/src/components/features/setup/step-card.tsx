"use client";

import { Check, ChevronDown, ChevronRight } from "lucide-react";
import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/cn";
import type { SetupStepStatus } from "@/lib/setup/setup-state";

/**
 * One step of the setup screen. Steps stay visible and re-openable rather
 * than disappearing behind a linear wizard — coming back to fix a token or
 * add a second repository is the common case, not the exception.
 */
export function StepCard({
  index,
  title,
  summary,
  status,
  open,
  onToggle,
  children,
}: {
  readonly index: number;
  readonly title: string;
  readonly summary: string;
  readonly status: SetupStepStatus;
  readonly open: boolean;
  readonly onToggle: () => void;
  readonly children: ReactNode;
}): React.ReactElement {
  const done = status === "done";
  return (
    <Card className={cn(open && "border-primary/50")}>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full items-start gap-3 px-6 py-4 text-left"
      >
        <span
          className={cn(
            "mt-0.5 flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full border text-xs font-semibold",
            done
              ? "border-transparent bg-functional-success/15 text-functional-success"
              : "text-muted-foreground",
          )}
        >
          {done ? <Check className="h-3.5 w-3.5" /> : index}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            <span className="font-medium">{title}</span>
            {done ? <Badge variant="success">Done</Badge> : null}
          </span>
          <span className="mt-0.5 block text-sm text-muted-foreground">{summary}</span>
        </span>
        {open ? (
          <ChevronDown className="mt-1 h-4 w-4 flex-shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="mt-1 h-4 w-4 flex-shrink-0 text-muted-foreground" />
        )}
      </button>
      {open ? <CardContent className="border-t pt-4">{children}</CardContent> : null}
    </Card>
  );
}
