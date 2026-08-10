"use client";

import Link from "next/link";
import { CodeBlock } from "@/components/shared/code-view";
import { FormStack } from "@/components/shared/form-stack";

/**
 * Step 4 — start the engine and watch the first cycle.
 *
 * Deliberately instructions rather than a button: the app never starts,
 * stops, or supervises the daemon. It observes the same SQLite file the
 * engine writes, so the honest thing to show here is exactly how to launch
 * the engine and where the evidence will appear.
 */
export function RunStep({
  repoId,
  instanceCount,
}: {
  readonly repoId: string | null;
  readonly instanceCount: number;
}): React.ReactElement {
  const target = repoId ?? "<repo-id>";
  return (
    <FormStack>
      <p className="m-0 text-sm text-muted-foreground">
        Run one cycle from the monorepo root:
      </p>
      <CodeBlock content={`npx tsx --env-file=.env.local engine/entry.ts --once --repo ${target}`} />

      <p className="m-0 text-sm text-muted-foreground">
        Or, if the engine runs in Docker:
      </p>
      <CodeBlock content="docker compose -f deployment/docker-compose.yml up -d" />

      <div className="rounded-md border bg-muted/40 p-3 text-sm">
        {instanceCount > 0 ? (
          <>
            The engine has already run against this database.{" "}
            <Link href="/executions">Executions</Link> shows every stage it has attempted, and{" "}
            <Link href="/work-items">Work Items</Link> shows what it produced.
          </>
        ) : (
          <>
            No engine has started against this database yet. Once one does, it appears under{" "}
            <Link href="/instances">Instances</Link> and this step completes on its own.
          </>
        )}
      </div>

      <p className="m-0 text-sm text-muted-foreground">
        The first cycle opens an <code>ai/init</code> pull request on the managed repository
        proposing its <code>.operator/</code> scaffolding, a handful of analyzers matched to the
        stack, and a few seed findings. Merging that pull request is the onboarding moment —
        closing it makes the next cycle try a different proposal.
      </p>
    </FormStack>
  );
}
