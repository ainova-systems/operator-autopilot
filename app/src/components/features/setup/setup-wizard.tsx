"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import type { PreflightReport } from "@/lib/setup/preflight-types";
import { DEFAULT_TOKEN_ENV_VAR } from "@/lib/setup/repo-draft";
import { deriveSetupProgress, type SetupStepId } from "@/lib/setup/setup-state";
import { ConnectStep, type ConnectionSummary } from "./connect-step";
import { PreflightStep } from "./preflight-step";
import { RepoStep } from "./repo-step";
import { RunStep } from "./run-step";
import { StepCard } from "./step-card";

export interface SetupWizardProps {
  readonly connections: readonly ConnectionSummary[];
  readonly activeConnectionId: string | null;
  readonly activeDbPath: string | null;
  readonly suggestedDbPath: string;
  readonly repoCount: number;
  readonly firstRepoId: string | null;
  readonly instanceCount: number;
}

/**
 * Guided first run: connect an engine database, check the host, register a
 * repository, start a cycle.
 *
 * Every write goes through an existing validated endpoint — connections
 * through `/api/app/*`, the repository row through `/api/kv/repos/{id}`.
 * The wizard adds sequencing and explanation, not a second write path.
 */
export function SetupWizard(props: SetupWizardProps): React.ReactElement {
  const router = useRouter();

  const [connections, setConnections] = useState(props.connections);
  const [activeConnectionId, setActiveConnectionId] = useState(props.activeConnectionId);
  const [dbPath, setDbPath] = useState(props.activeDbPath ?? props.suggestedDbPath);
  const [repoCount, setRepoCount] = useState(props.repoCount);
  const [repoId, setRepoId] = useState(props.firstRepoId);
  const [repoSlug, setRepoSlug] = useState("");
  const [tokenEnvVar, setTokenEnvVar] = useState(DEFAULT_TOKEN_ENV_VAR);
  const [preflightPassed, setPreflightPassed] = useState<boolean | undefined>(undefined);

  const progress = deriveSetupProgress({
    hasActiveConnection: activeConnectionId !== null,
    repoCount,
    instanceCount: props.instanceCount,
    ...(preflightPassed === undefined ? {} : { preflightPassed }),
  });

  const [openStep, setOpenStep] = useState<SetupStepId | null>(progress.currentStep);

  function advance(from: SetupStepId): void {
    const order = progress.steps.map((s) => s.id);
    const next = order[order.indexOf(from) + 1];
    setOpenStep(next ?? null);
  }

  function onConnected(connection: ConnectionSummary): void {
    setConnections((prev) =>
      prev.some((c) => c.id === connection.id) ? prev : [...prev, connection],
    );
    setActiveConnectionId(connection.id);
    setPreflightPassed(undefined);
    advance("connect");
    router.refresh();
  }

  function onPreflight(report: PreflightReport): void {
    setPreflightPassed(report.ok);
    if (report.ok) advance("preflight");
  }

  function onRepoCreated(createdId: string): void {
    setRepoCount((prev) => prev + 1);
    setRepoId(createdId);
    advance("repo");
    router.refresh();
  }

  return (
    <div className="space-y-3">
      {progress.steps.map((step, index) => (
        <StepCard
          key={step.id}
          index={index + 1}
          title={step.title}
          summary={step.summary}
          status={step.status}
          open={openStep === step.id}
          onToggle={() => setOpenStep(openStep === step.id ? null : step.id)}
        >
          {step.id === "connect" ? (
            <ConnectStep
              connections={connections}
              activeConnectionId={activeConnectionId}
              dbPath={dbPath}
              onDbPathChange={setDbPath}
              onConnected={onConnected}
            />
          ) : null}
          {step.id === "preflight" ? (
            <PreflightStep
              dbPath={dbPath}
              repoSlug={repoSlug}
              tokenEnvVar={tokenEnvVar}
              onResult={onPreflight}
            />
          ) : null}
          {step.id === "repo" && activeConnectionId === null ? (
            <p className="m-0 text-sm text-muted-foreground">
              Connect an engine database first — the repository row is written into it.
            </p>
          ) : null}
          {step.id === "repo" && activeConnectionId !== null ? (
            <RepoStep
              repoSlug={repoSlug}
              onRepoSlugChange={setRepoSlug}
              tokenEnvVar={tokenEnvVar}
              onTokenEnvVarChange={setTokenEnvVar}
              onCreated={onRepoCreated}
            />
          ) : null}
          {step.id === "run" ? (
            <RunStep repoId={repoId} instanceCount={props.instanceCount} />
          ) : null}
        </StepCard>
      ))}
    </div>
  );
}
