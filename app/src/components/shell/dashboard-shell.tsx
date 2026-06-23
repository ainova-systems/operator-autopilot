import type { ReactNode } from "react";
import { PathBar } from "./path-bar";

export function DashboardShell({
  sidebar,
  statusBar,
  children,
}: {
  readonly sidebar: ReactNode;
  readonly statusBar?: ReactNode;
  readonly children: ReactNode;
}): React.ReactElement {
  return (
    <div className="flex h-screen flex-col bg-background text-foreground">
      <div className="flex min-h-0 flex-1">
        {sidebar}
        <main className="flex min-h-0 flex-1 flex-col overflow-hidden">
          <PathBar />
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
            {children}
          </div>
        </main>
      </div>
      {statusBar}
    </div>
  );
}
