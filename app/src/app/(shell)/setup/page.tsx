import type { KVStore } from "@operator/core";
import { PageContainer } from "@/components/shared/page-container";
import { PageHeader } from "@/components/shared/page-header";
import { SetupWizard } from "@/components/features/setup/setup-wizard";
import { getActiveKV } from "@/lib/active-kv-registry";
import { listConnections } from "@/lib/connections";
import { suggestEngineDbPath } from "@/lib/setup/engine-db-path";

export const dynamic = "force-dynamic";

/**
 * Guided onboarding for a fresh instance.
 *
 * Everything the wizard needs about the current state is read here, on the
 * server: which connections exist, whether one is selected, whether the
 * engine has ever started against it, and whether a repository is already
 * registered. The client component only sequences the steps.
 */
export default async function SetupPage(): Promise<React.ReactElement> {
  const [active, connections] = await Promise.all([getActiveKV(), listConnections()]);
  const counts = active ? await readCounts(active.kv) : { repoCount: 0, instanceCount: 0, firstRepoId: null };

  return (
    <PageContainer>
      <PageHeader
        title="Setup"
        description="Four steps from a fresh checkout to a running cycle. Each step is re-openable, so you can come back and change an answer."
      />
      <SetupWizard
        connections={connections.map((c) => ({ id: c.id, name: c.name, dbPath: c.dbPath }))}
        activeConnectionId={active?.connection.id ?? null}
        activeDbPath={active?.connection.dbPath ?? null}
        suggestedDbPath={suggestEngineDbPath()}
        repoCount={counts.repoCount}
        firstRepoId={counts.firstRepoId}
        instanceCount={counts.instanceCount}
      />
    </PageContainer>
  );
}

async function readCounts(kv: KVStore): Promise<{
  repoCount: number;
  instanceCount: number;
  firstRepoId: string | null;
}> {
  const [repos, instances] = await Promise.all([kv.list("repos"), kv.list("instances")]);
  return {
    repoCount: repos.length,
    instanceCount: instances.length,
    firstRepoId: repos[0]?.key ?? null,
  };
}
