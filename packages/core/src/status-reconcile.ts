import type { WorkItemStatus } from "./types/domain.js";
import type { StatusSources } from "./schemas/work-item.schema.js";

/**
 * Status reconciliation (architecture-v5.md §6.3, Step 14).
 *
 * Pure functions that transform a set of observed status values from four
 * sources (develop file, feature-branch file, PR label, last execution
 * verdict) into an `effectiveStatus` plus a drift report. No I/O — call
 * sites read observations from KV / git / VCS and pass them in.
 *
 * Order of precedence when choosing `effectiveStatus`:
 *   1. Terminal sticky — if `currentKV.status` is in a terminal state
 *      (completed/failed/cancelled/rejected/duplicate), keep it. This
 *      matches the "terminal state is sticky" rule in §6.3 — once a
 *      verifier signs off, a reverted develop file cannot un-complete it.
 *   2. Last execution verdict (mapped to status) — strong signal from the
 *      stage that just wrote the PR.
 *   3. PR label — the live VCS signal.
 *   4. Develop file frontmatter — the merged-source-of-truth value.
 *   5. Previous KV status, else `"pending"`.
 *
 * Drift is detected BEFORE terminal sticky applies, so the UI can say
 * "completed but develop file flipped back to pending" as a mismatch even
 * while effectiveStatus stays `completed`.
 */

/**
 * Default terminal set used when the caller doesn't provide a per-kind
 * `terminalStatuses` set (back-compat, simple unit tests). Production
 * call sites pull the real set from the kind registry — that's what
 * supports both PR-bound kinds (terminal `merged`) and virtual / DB-only
 * kinds (terminal `completed`).
 */
const DEFAULT_TERMINAL_STATUSES: ReadonlySet<WorkItemStatus> = new Set([
  "completed",
  "failed",
  "cancelled",
  "rejected",
  "duplicate",
  "merged",
  "accepted", // T-601 Phase A: non-VCS terminal-success synonym for `merged`.
]);

/** Reconciliation inputs. `currentKV` carries prior row fields so the
 * reconciler can honor the terminal-sticky rule without re-reading KV.
 *
 * `status` is the prior **computed** status (what last cycle's reconciler
 * returned). `developFileStatus` is the prior raw develop-file literal
 * (renamed from the legacy `effectiveStatus` field 2026-05-13). Both
 * participate as sticky-source candidates: if either was terminal,
 * terminal-sticky preserves it. */
export interface ReconcileInput {
  readonly sources: StatusSources;
  readonly currentKV?: {
    readonly status?: WorkItemStatus;
    readonly developFileStatus?: WorkItemStatus;
  };
  /**
   * Terminal status set for the work item's kind, sourced from the kind
   * registry (`kind.terminalStatuses`). Lets the reconciler distinguish
   * PR-bound kinds (where `merged` is terminal) from virtual / DB-only
   * kinds (where `completed` is terminal and `merged` may not be).
   * When omitted, falls back to a permissive default that includes both.
   */
  readonly terminalStatuses?: ReadonlySet<WorkItemStatus>;
}

/** Reconciliation output. `reason` is a short label suitable for tooltips
 * ("terminal-sticky", "execution-verdict", "pr-label", "develop-file",
 * "initial"). */
export interface ReconcileResult {
  readonly effectiveStatus: WorkItemStatus;
  readonly effectiveStatusReason: string;
}

/** Map a verifier verdict to the work-item status it produces. */
function verdictToStatus(value: string): WorkItemStatus | null {
  switch (value) {
    case "approved": return "completed";
    case "failed": return "failed";
    case "cancelled": return "cancelled";
    case "rejected": return "rejected";
    default: return null;
  }
}

/** Parse a PR label into a work-item status (`ai:in-review` →
 * `in-review`, etc.). Returns `null` for labels that do not map. */
function labelToStatus(value: string): WorkItemStatus | null {
  const stripped = value.replace(/^ai:/, "").trim();
  const known: readonly WorkItemStatus[] = [
    "pending", "in-progress", "completed", "failed",
    "cancelled", "rejected", "duplicate", "reopened",
    "in-review", "ready-to-merge",
  ];
  const hit = known.find((s) => s === stripped);
  return hit ?? null;
}

/**
 * Compute the effective status + reason for a work item given its four
 * observation sources. See module header for the precedence rules.
 */
export function reconcileEffectiveStatus(input: ReconcileInput): ReconcileResult {
  const { sources, currentKV } = input;
  const terminalSet = input.terminalStatuses ?? DEFAULT_TERMINAL_STATUSES;

  // 0. PR was merged AND `merged` is a valid terminal for this kind →
  // strongest possible signal. Beats terminal-sticky so an item whose
  // KV briefly held `completed` (e.g. legacy state) still upgrades to
  // `merged` when the human merges the PR. For kinds whose terminal
  // set does NOT include `merged` (e.g. virtual/DB-only kinds), this
  // observation is informational only — `prState` lives as a sibling
  // signal in the UI.
  if (sources.prState?.value === "merged" && terminalSet.has("merged" as WorkItemStatus)) {
    return { effectiveStatus: "merged", effectiveStatusReason: "pr-state" };
  }

  // 1. Terminal sticky — protects against TRANSIENT loss of develop
  // file (rebase / fetch race) by holding the prior terminal status.
  // It must NOT survive a real develop-file signal saying otherwise:
  // a finding/task can legitimately cycle terminal → pending again
  // when humans retire its current PR (close-without-merge) and the
  // operator opens a fresh planning PR that bumps frontmatter
  // back to in-progress on a feature branch — all the while develop
  // still says pending. Without this guard the reconciler keeps
  // reporting `merged` (from a prior PR cycle that did merge) and
  // hasDrift fires forever (F20260416-0001/0002 incident).
  //
  // Rule:
  //   - sticky kicks in iff develop-file observation is `missing`
  //     OR the develop value is itself a terminal in this kind's set;
  //   - otherwise step 4 (develop-file) wins.
  const developValue = sources.developFile?.value;
  const developSaysSomethingNonTerminal =
    developValue !== undefined
    && developValue !== "missing"
    && !terminalSet.has(developValue);
  if (!developSaysSomethingNonTerminal) {
    if (currentKV?.status && terminalSet.has(currentKV.status)) {
      return {
        effectiveStatus: currentKV.status,
        effectiveStatusReason: "terminal-sticky",
      };
    }
    if (currentKV?.developFileStatus && terminalSet.has(currentKV.developFileStatus)) {
      return {
        effectiveStatus: currentKV.developFileStatus,
        effectiveStatusReason: "terminal-sticky",
      };
    }
  }

  // 2. Last execution verdict trumps other observations — it's the freshest
  // signal from the stage that just wrote the PR.
  if (sources.executionVerdict) {
    const mapped = verdictToStatus(sources.executionVerdict.value);
    if (mapped) {
      return { effectiveStatus: mapped, effectiveStatusReason: "execution-verdict" };
    }
  }

  // 3. PR label — the live VCS signal. BUT a label is meaningless when no
  // PR exists (prState=none): a stale `ai:ready-to-merge` slot carried
  // forward from a prior PR cycle must not re-latch every cycle and pin a
  // non-terminal item in limbo forever (orphan-latch incident — findings
  // stuck at ready-to-merge with codeReviewId=null while their develop file
  // said in-progress). Skip the label and fall through to develop-file.
  if (sources.prLabel && sources.prState?.value !== "none") {
    const mapped = labelToStatus(sources.prLabel.value);
    if (mapped) {
      return { effectiveStatus: mapped, effectiveStatusReason: "pr-label" };
    }
  }

  // 4. Develop file — merged source of truth for non-in-flight items.
  if (sources.developFile && sources.developFile.value !== "missing") {
    return {
      effectiveStatus: sources.developFile.value,
      effectiveStatusReason: "develop-file",
    };
  }

  // 5. Previous KV status, else default.
  if (currentKV?.status) {
    return { effectiveStatus: currentKV.status, effectiveStatusReason: "initial" };
  }
  return { effectiveStatus: "pending", effectiveStatusReason: "initial" };
}

/** Drift computation result. `driftDetails` entries are `"<source>=<value>"`
 * strings so the UI can render them without schema lookups. */
export interface DriftResult {
  readonly hasDrift: boolean;
  readonly isActive: boolean;
  readonly driftDetails: string[];
}

interface SeenObservation {
  readonly source: string;
  readonly value: string;
}

/**
 * Statuses that tell `isInFlightState` "agent is done with this side".
 *
 * `in-review` and `ready-to-merge` are included because from the engine
 * perspective they both mean "AI has pushed a commit and now waits on
 * someone else" — treating them as terminal for drift detection avoids
 * false "drift" warnings while a PR is sitting idle waiting to be
 * merged. Real terminal lifecycle states (`failed`, `cancelled`,
 * `rejected`, `duplicate`) stay terminal for drift as well.
 */
const COMPLETED_STATUSES: ReadonlySet<WorkItemStatus> = new Set([
  "completed", "failed", "cancelled", "rejected", "duplicate", "merged", "accepted",
  "in-review", "ready-to-merge",
]);

function collectObservations(sources: StatusSources): SeenObservation[] {
  const seen: SeenObservation[] = [];
  if (sources.developFile && sources.developFile.value !== "missing") {
    seen.push({ source: "develop-file", value: sources.developFile.value });
  }
  if (sources.featureBranchFile && sources.featureBranchFile.value !== "missing") {
    seen.push({ source: "feature-branch-file", value: sources.featureBranchFile.value });
  }
  if (sources.prLabel) {
    const mapped = labelToStatus(sources.prLabel.value);
    if (mapped) seen.push({ source: "pr-label", value: mapped });
  }
  if (sources.executionVerdict) {
    const mapped = verdictToStatus(sources.executionVerdict.value);
    if (mapped) seen.push({ source: "execution-verdict", value: mapped });
  }
  return seen;
}

function valueBySource(seen: SeenObservation[], source: string): string | undefined {
  return seen.find((s) => s.source === source)?.value;
}

/**
 * Decide whether an observation set represents a normal in-flight PR state
 * rather than an actual drift. Heuristic encoded here:
 *
 *   PR is open (prState = "open") AND feature-branch, pr-label and
 *   execution-verdict all report a terminal status (completed/failed/…) AND
 *   develop-file is still `pending` / `in-progress` (has not received the
 *   merge yet).
 *
 * That is the expected state of every AI-authored PR between "AI finished
 * its work" and "human merges to develop". We do NOT surface it as drift.
 *
 * Any other mismatch — e.g. develop file *ahead* of feature branch, PR
 * already merged but develop still pending, pr-label stuck on processing
 * while verdict is failed — still flips `hasDrift: true` so operators see
 * the real issue.
 */
function isInFlightState(seen: SeenObservation[], sources: StatusSources): boolean {
  if (sources.prState?.value !== "open") return false;

  const develop = valueBySource(seen, "develop-file");
  const branch = valueBySource(seen, "feature-branch-file");
  const label = valueBySource(seen, "pr-label");
  const verdict = valueBySource(seen, "execution-verdict");

  const branchDone = branch ? COMPLETED_STATUSES.has(branch as WorkItemStatus) : false;
  const labelDone = label ? COMPLETED_STATUSES.has(label as WorkItemStatus) : false;
  const verdictDone = verdict ? COMPLETED_STATUSES.has(verdict as WorkItemStatus) : false;

  const agentSideDone = (branchDone || labelDone || verdictDone)
    && (!branch || COMPLETED_STATUSES.has(branch as WorkItemStatus))
    && (!label || COMPLETED_STATUSES.has(label as WorkItemStatus))
    && (!verdict || COMPLETED_STATUSES.has(verdict as WorkItemStatus));

  const developLagging = !develop
    || develop === "pending"
    || develop === "in-progress"
    || develop === "reopened";

  return agentSideDone && developLagging;
}

/**
 * Compare every observed source value and report mismatches.
 *
 * "Drift" means the observation set is inconsistent in a way the engine
 * did NOT intentionally produce. An open PR whose branch is completed but
 * whose develop file is still `pending` is an intentional in-flight state
 * (`isActive: true`, `hasDrift: false`); anything else with differing
 * values is drift proper.
 *
 * Called before `reconcileEffectiveStatus` so the UI can flag drift on
 * terminal-sticky rows ("effectiveStatus = completed but develop reverted").
 */
export function computeDrift(sources: StatusSources): DriftResult {
  const seen = collectObservations(sources);

  if (seen.length < 2) {
    return { hasDrift: false, isActive: false, driftDetails: [] };
  }

  const unique = new Set(seen.map((s) => s.value));
  if (unique.size <= 1) {
    return { hasDrift: false, isActive: false, driftDetails: [] };
  }

  if (isInFlightState(seen, sources)) {
    return { hasDrift: false, isActive: true, driftDetails: [] };
  }

  return {
    hasDrift: true,
    isActive: false,
    driftDetails: seen.map((s) => `${s.source}=${s.value}`),
  };
}
