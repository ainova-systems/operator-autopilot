import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PageContainer } from "@/components/shared/page-container";
import { PageHeader } from "@/components/shared/page-header";
import { resolveAppDbPath } from "@/lib/env-paths";

export default function SettingsPage(): React.ReactElement {
  const dbPath = resolveAppDbPath();
  return (
    <PageContainer>
      <PageHeader
        title="Settings"
        description="App-level configuration, independent of any managed operator instance."
      />
      <div className="space-y-4">
        <Card>
          <CardHeader>
            <CardTitle>App state database</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <p className="m-0 text-muted-foreground">
              The app stores its connection registry and UI preferences in a local
              SQLite file, separate from any managed operator instance.
            </p>
            <p className="m-0">
              <code className="rounded bg-muted/60 px-1.5 py-0.5 font-mono text-xs">
                {dbPath}
              </code>
            </p>
            <p className="m-0 text-xs text-muted-foreground">
              Override with the <code>OPERATOR_APP_DB_PATH</code> environment variable.
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>About</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="m-0 text-sm text-muted-foreground">
              Operator Console — local observability UI for the Operator engine.
            </p>
          </CardContent>
        </Card>
      </div>
    </PageContainer>
  );
}
