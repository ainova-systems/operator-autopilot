import Link from "next/link";
import {
  Sidebar,
  SidebarBrand,
  SidebarSection,
} from "@/components/shell/sidebar";
import { SectionLabel } from "@/components/shared/section-label";
import { ThemeToggle } from "@/components/shared/theme-provider";
import { ConnectionList } from "./connection-list";
import { AddConnectionButton } from "./add-connection-button";

const navItemClass =
  "block rounded-md px-3 py-1.5 text-sm text-foreground hover:bg-muted transition-colors no-underline";

export function LeftRail({
  hasActive,
}: {
  readonly hasActive: boolean;
}): React.ReactElement {
  return (
    <Sidebar>
      <div className="flex items-start justify-between px-4">
        <SidebarBrand name="Operator" subtitle="local shell" />
        <ThemeToggle />
      </div>

      <SidebarSection>
        <SectionLabel>Connections</SectionLabel>
        <ConnectionList />
        <AddConnectionButton />
      </SidebarSection>

      {hasActive ? (
        <SidebarSection>
          <SectionLabel>Views</SectionLabel>
          <Link href="/work-items" className={navItemClass}>
            Work Items
          </Link>
          <Link href="/executions" className={navItemClass}>
            Executions
          </Link>
          <Link href="/instances" className={navItemClass}>
            Instances
          </Link>
          <Link href="/config" className={navItemClass}>
            Config
          </Link>
          <Link href="/audit" className={navItemClass}>
            Audit
          </Link>
        </SidebarSection>
      ) : null}

      <SidebarSection className="mt-auto">
        <Link
          href="/connections"
          className={`${navItemClass} text-muted-foreground`}
        >
          Connections
        </Link>
        <Link
          href="/settings"
          className={`${navItemClass} text-muted-foreground`}
        >
          Settings
        </Link>
      </SidebarSection>
    </Sidebar>
  );
}
