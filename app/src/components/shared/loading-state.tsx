import { Loader2 } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/cn";

interface LoadingStateProps {
  readonly message?: string;
  readonly fullScreen?: boolean;
  readonly lines?: number;
}

export function LoadingState({
  message,
  fullScreen,
  lines,
}: LoadingStateProps): React.ReactElement {
  if (lines) {
    return (
      <div className="space-y-3 p-2">
        {Array.from({ length: lines }).map((_, i) => (
          <Skeleton key={i} className="h-8 w-full" />
        ))}
      </div>
    );
  }

  return (
    <div
      className={cn(
        "flex items-center justify-center",
        fullScreen ? "h-screen" : "h-full min-h-[12rem]",
      )}
    >
      <div className="text-center">
        <Loader2 className="mx-auto h-8 w-8 animate-spin text-primary" />
        {message ? (
          <p className="mt-3 text-sm text-muted-foreground">{message}</p>
        ) : null}
      </div>
    </div>
  );
}
