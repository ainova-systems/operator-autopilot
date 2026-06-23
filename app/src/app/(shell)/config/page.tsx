import Link from "next/link";
import { Settings2 } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/shared/empty-state";
import { PageContainer } from "@/components/shared/page-container";
import { PageHeader } from "@/components/shared/page-header";
import { getActiveKV } from "@/lib/active-kv-registry";

const EDITABLE_CATEGORIES = [
  "prompts",
  "templates",
  "agent-roles",
  "workflow-stages",
  "work-item-kinds",
  "reviewer-criteria",
  "analyzers",
  "repos",
] as const;

export default async function ConfigIndexPage(): Promise<React.ReactElement> {
  const active = await getActiveKV();
  if (!active) {
    return (
      <PageContainer>
        <EmptyState
          icon={Settings2}
          title="No connection selected"
          description="Select a connection from the left rail or add a new one."
        />
      </PageContainer>
    );
  }

  const counts = await Promise.all(
    EDITABLE_CATEGORIES.map(async (cat) => {
      const rows = await active.kv.list(cat);
      return { cat, count: rows.length };
    }),
  );

  return (
    <PageContainer>
      <PageHeader
        title="Config"
        description={
          <>
            Runtime configuration categories, seeded from{" "}
            <code>engine/content/</code> and <code>config/repos.yaml</code> on
            engine startup.
          </>
        }
      />

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {counts.map(({ cat, count }) => (
          <Link
            key={cat}
            href={`/config/${cat}`}
            className="no-underline transition-transform hover:-translate-y-0.5"
          >
            <Card className="h-full hover:border-primary/40">
              <CardHeader className="flex flex-row items-center justify-between pb-3">
                <CardTitle className="text-base">{cat}</CardTitle>
                <span className="text-xs text-muted-foreground">
                  {count} {count === 1 ? "row" : "rows"}
                </span>
              </CardHeader>
              <CardContent className="pt-0">
                <p className="m-0 text-xs text-muted-foreground">
                  View and edit entries in this category.
                </p>
              </CardContent>
            </Card>
          </Link>
        ))}
      </div>
    </PageContainer>
  );
}
