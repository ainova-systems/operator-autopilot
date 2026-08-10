/**
 * Progress model for the guided setup screen.
 *
 * Each step is "done" when something observable says so — a selected
 * connection, a `repos/*` row, an `instances/*` row proving the engine has
 * actually started against this database. The one exception is the
 * preflight, which has no persisted trace: the wizard passes its own result
 * in, so a page reload starts it over rather than claiming a check that was
 * never re-run.
 */
export const SETUP_STEPS = ["connect", "preflight", "repo", "run"] as const;

export type SetupStepId = (typeof SETUP_STEPS)[number];

export type SetupStepStatus = "done" | "todo";

interface SetupStepState {
  readonly id: SetupStepId;
  readonly title: string;
  readonly summary: string;
  readonly status: SetupStepStatus;
}

export interface SetupSnapshot {
  /** A connection is saved AND selected — the app has an engine database. */
  readonly hasActiveConnection: boolean;
  /** Rows in `kv:repos/*` — at least one managed repository is registered. */
  readonly repoCount: number;
  /** Rows in `kv:instances/*` — the engine has started against this database. */
  readonly instanceCount: number;
  /** Result of the most recent preflight run in this browser session. */
  readonly preflightPassed?: boolean;
}

export interface SetupProgress {
  readonly steps: readonly SetupStepState[];
  /** First step still to do — where the wizard opens. */
  readonly currentStep: SetupStepId;
  readonly complete: boolean;
}

const STEP_COPY: Record<SetupStepId, { title: string; summary: string }> = {
  connect: {
    title: "Connect an engine",
    summary: "Point the app at the engine's SQLite state file, creating it if it does not exist yet.",
  },
  preflight: {
    title: "Check this host",
    summary: "Confirm git, the agent CLIs, and the git host token are in place before the first cycle.",
  },
  repo: {
    title: "Add a managed repository",
    summary: "Register the repository the operator will work on, and which branch it works from.",
  },
  run: {
    title: "Run the first cycle",
    summary: "Start the engine and watch it open its onboarding pull request.",
  },
};

export function deriveSetupProgress(snapshot: SetupSnapshot): SetupProgress {
  const done: Record<SetupStepId, boolean> = {
    connect: snapshot.hasActiveConnection,
    preflight: snapshot.preflightPassed === true,
    repo: snapshot.repoCount > 0,
    run: snapshot.instanceCount > 0,
  };

  const steps = SETUP_STEPS.map((id) => ({
    id,
    title: STEP_COPY[id].title,
    summary: STEP_COPY[id].summary,
    status: done[id] ? ("done" as const) : ("todo" as const),
  }));

  const firstTodo = steps.find((s) => s.status === "todo");
  return {
    steps,
    currentStep: firstTodo?.id ?? "run",
    complete: firstTodo === undefined,
  };
}
