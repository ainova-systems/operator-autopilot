import type { ReactNode } from "react";
import { DashboardShell } from "@/components/shell/dashboard-shell";
import { StatusBarSlot } from "@/components/shell/status-bar-slot";
import { LeftRail } from "@/components/left-rail/left-rail";
import { ThemeProvider } from "@/components/shared/theme-provider";
import { Toaster } from "@/components/shared/toaster";
import { getActiveKV } from "@/lib/active-kv-registry";

export default async function ShellLayout({
  children,
}: {
  readonly children: ReactNode;
}): Promise<React.ReactElement> {
  const active = await getActiveKV();

  return (
    <ThemeProvider>
      <Toaster>
        <DashboardShell
          sidebar={<LeftRail hasActive={active !== null} />}
          statusBar={<StatusBarSlot />}
        >
          {children}
        </DashboardShell>
      </Toaster>
    </ThemeProvider>
  );
}
