import type { WorkspaceGit } from "../../infra/git.js";

/**
 * Captured HEAD reference taken before an agent invocation. Used by
 * stages that enforce the read-only-agent contract — the agent is
 * supposed to emit AOP records (or write workspace files in non-read-
 * only mode) but must not push commits / move HEAD by itself. After
 * the agent returns, the orchestrator re-reads HEAD and rejects the
 * run if it moved.
 */
export interface HeadSnapshot {
  readonly sha: string | null;
}

/**
 * Capture the workspace's current HEAD as a snapshot suitable for
 * later verification. `headSha()` is best-effort: callers that wrap
 * `captureHeadSnapshot` in a `try`/`catch` and forward `null` for
 * `sha` opt out of the contract for that invocation.
 */
export async function captureHeadSnapshot(
  git: WorkspaceGit,
): Promise<HeadSnapshot> {
  const sha = await git.headSha();
  return { sha };
}

/**
 * Outcome of a HEAD-unchanged verification.
 *
 * `ok = true` means the current HEAD equals the captured pre-snapshot
 * SHA. `ok = false` means the agent moved HEAD — a contract violation
 * the caller treats as a terminal verdict. `message` is a short
 * human-readable description populated only on violation; the caller
 * decides how to wrap it (verdictOverride, summaryOverride, PR
 * comment, log payload, StageLogicError code).
 */
export interface HeadSnapshotVerifyResult {
  readonly ok: boolean;
  readonly preSha: string | null;
  readonly postSha: string;
  readonly message: string | null;
}

/**
 * Verify the workspace's HEAD has not moved since {@link captureHeadSnapshot}.
 *
 * The primitive is kind-agnostic and stage-agnostic — it does not
 * mutate any work-item state, does not log, does not throw. The
 * caller is responsible for translating a violation into the
 * stage-specific response (status flip, verdict override, PR comment,
 * `StageLogicError` with a stage-specific `code`).
 */
export async function verifyHeadUnchanged(
  git: WorkspaceGit,
  snapshot: HeadSnapshot,
): Promise<HeadSnapshotVerifyResult> {
  const postSha = await git.headSha();
  if (postSha === snapshot.sha) {
    return { ok: true, preSha: snapshot.sha, postSha, message: null };
  }
  return {
    ok: false,
    preSha: snapshot.sha,
    postSha,
    message: `agent modified branch directly (forbidden for read-only agent); HEAD ${snapshot.sha?.slice(0, 7) ?? "<none>"} → ${postSha.slice(0, 7)}`,
  };
}
