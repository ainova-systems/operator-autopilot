"use client";

import { RefreshCw } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";

export function RefreshButton({
  label = "Refresh",
}: {
  readonly label?: string;
}): React.ReactElement {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [spin, setSpin] = useState(false);

  function onClick(): void {
    setSpin(true);
    startTransition(() => router.refresh());
    setTimeout(() => setSpin(false), 600);
  }

  const spinning = isPending || spin;
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      onClick={onClick}
      disabled={isPending}
      aria-label={label}
    >
      <RefreshCw className={cn("h-4 w-4", spinning && "animate-spin")} />
      {label}
    </Button>
  );
}
