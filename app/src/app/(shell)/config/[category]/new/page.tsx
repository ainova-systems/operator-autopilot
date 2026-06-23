import { notFound } from "next/navigation";
import { Settings2 } from "lucide-react";
import { EmptyState } from "@/components/shared/empty-state";
import { PageContainer } from "@/components/shared/page-container";
import { PageHeader } from "@/components/shared/page-header";
import { NewRowForm } from "@/components/features/config/new-row-form";
import { getActiveKV } from "@/lib/active-kv-registry";
import { isKnownCategory } from "@/lib/kv-write";

/**
 * Per-category starter templates for new KV rows. The shape mirrors the
 * minimum-viable structure for that category — users land with a
 * pre-filled JSON skeleton, edit the values, click Create. Categories
 * not listed here fall through to a generic empty-object skeleton.
 *
 * Today only `repos` carries a meaningful template (Phase 5 P-502
 * partial — moving away from `config/repos.yaml` as the source of
 * truth). Stages / kinds / templates land here as P-502 expands.
 */
const STARTER_TEMPLATES: Record<string, { template: object; keyLabel: string; keyPlaceholder?: string }> = {
  repos: {
    keyLabel: "Repo id",
    keyPlaceholder: "my-repo",
    template: {
      id: "<repo-id>",
      debug: false,
      vcs: {
        platform: "github",
        repo: "owner/repo",
        branch: "main",
        tokenEnvVar: "MANAGED_REPO_GH_TOKEN",
      },
      features: {
        prReview: true,
        taskExecute: true,
        taskSelect: true,
        findingExecute: true,
        findingSelect: true,
        dailyResearch: true,
        improver: true,
      },
      limits: {
        maxActiveTasks: 2,
        maxActiveFindings: 2,
      },
    },
  },
};

interface RouteProps {
  readonly params: Promise<{ readonly category: string }>;
}

export default async function ConfigNewRowPage({
  params,
}: RouteProps): Promise<React.ReactElement> {
  const { category } = await params;
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
  if (!isKnownCategory(category)) return notFound();

  const starter = STARTER_TEMPLATES[category];
  const template = starter?.template ?? {};
  const keyLabel = starter?.keyLabel ?? "Entry id";
  const keyPlaceholder = starter?.keyPlaceholder;

  return (
    <PageContainer>
      <PageHeader
        title={`New ${category} entry`}
        backHref={`/config/${category}`}
        backLabel={`Back to ${category}`}
        description="Fill in the id and edit the JSON template below. Click Create to save."
      />
      <NewRowForm
        category={category}
        starterTemplate={JSON.stringify(template, null, 2)}
        keyLabel={keyLabel}
        keyPlaceholder={keyPlaceholder}
      />
    </PageContainer>
  );
}
