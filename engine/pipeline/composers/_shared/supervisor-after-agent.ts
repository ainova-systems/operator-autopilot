import type {
  OperationContext, KindRegistry, WorkItemSource, AgentEventStream,
} from "@operator/core";
import type { PRManager } from "../../../delivery/pr-manager.js";
import type { WorkspaceGit } from "../../../infra/git.js";
import type { Logger } from "../../../logging/logger.js";
import { formatDebugRunLinkSuffix } from "../../../delivery/vcs-helpers.js";
import type { BotAttribution } from "../../../delivery/bot-footer.js";
import type { StageDef, AgentResult, Verdict } from "../../types.js";
import type { PrFeedbackPayload } from "../../primitives/pr-feedback-selector.js";
import { applyAgentEvents } from "../../primitives/aop-applier.js";
import { applyThreadDispositions } from "./thread-dispositions.js";
import type { PrFeedbackSupervisorScratch } from "./supervisor-scratch.js";
import {
  formatAppliedReviewFeedbackMessage,
  formatNoCodeChangesMessage,
  formatReviewLimitReachedMessage,
  formatStaleCiFixMessage,
  formatSupervisorTerminalMessage,
} from "./supervisor-bot-messages.js";

export interface SupervisorAfterAgentDeps {
  readonly prManager: PRManager;
  readonly git: WorkspaceGit;
  readonly kindRegistry: KindRegistry;
  readonly workItemSource: WorkItemSource;
  readonly agentEventStream: AgentEventStream;
  readonly log?: Logger;
  readonly debug?: boolean;
  readonly debugRunUrl?: string;
}

function inferKindFromBranch(branch: string, registry: KindRegistry): { kind: string; id: string } | null {
  for (const kindDef of registry.all) {
    const prefix = kindDef.branchPrefix.endsWith("/") ? kindDef.branchPrefix : `${kindDef.branchPrefix}/`;
    if (branch.startsWith(prefix)) {
      const id = branch.slice(prefix.length);
      if (id) return { kind: kindDef.name, id };
    }
  }
  return null;
}

export async function processSupervisorAfterAgent(
  deps: SupervisorAfterAgentDeps,
  stage: StageDef,
  payload: PrFeedbackPayload,
  scratch: PrFeedbackSupervisorScratch,
  agentResult: AgentResult,
  ctx: OperationContext,
): Promise<{ verdictOverride?: Verdict; summaryOverride?: string } | void> {
  const suffix = formatDebugRunLinkSuffix(deps.debug, deps.debugRunUrl);
  const ciFailing = payload.checks.value === "failing";
  const nextAttribution: BotAttribution = {
    responded: new Set(payload.respondedIds),
    ciHead: payload.checks.headSha,
    ciAttempt: ciFailing
      ? { current: payload.ciAttempts + 1, max: payload.maxCiRetryAttempts }
      : undefined,
  };

  if (scratch.limitReached) {
    const msg = formatReviewLimitReachedMessage(scratch.reviewAttempts, scratch.maxAttempts, suffix);
    await deps.prManager.postBotComment(payload.prId, msg, nextAttribution);
    deps.log?.info(`${stage.name}: PR #${payload.prId} limit reached — verdict override failed`, {
      stage: stage.name, prNumber: payload.prId,
      reviewAttempts: scratch.reviewAttempts, maxAttempts: scratch.maxAttempts,
    });
    return {
      verdictOverride: "failed",
      summaryOverride: `review cycle limit reached (${scratch.reviewAttempts}/${scratch.maxAttempts})`,
    };
  }

  // 2026-05-13: removed defense-in-depth "approved + ciFailing →
  // override to failed" check. The verifier (inside the agent chain
  // when stage has reviewEnabled: true) is the authority on whether
  // the supervisor's fix addresses CI. Defense-in-depth duplicated
  // verifier and second-guessed it from a stale CI observation —
  // CI was observed at cycle start (BEFORE supervisor committed via
  // Bash) so it always looked "failing" even when the fix had just
  // been pushed and CI re-run hadn't completed yet. The canonical
  // case: supervisor correctly fixed all 47 backend test failures
  // and 14 Copilot comments and
  // committed/pushed, but the post-verifier check flipped to failed
  // because checks.headSha was the pre-commit SHA. Per user guidance:
  // "verify process should be able to detect commits and verify them
  // even if committed — if OK act as usual; if wrong comment back to
  // redo/fix. Committed work has no difference except technical to
  // detect changes." Trust verifier — if its judgment is wrong, the
  // next pr-feedback cycle picks the PR up with fresh CI data.

  const activeItem = inferKindFromBranch(payload.branch, deps.kindRegistry);
  const applied = await applyAgentEvents(
    agentResult.output,
    {
      stream: deps.agentEventStream,
      source: deps.workItemSource,
      registry: deps.kindRegistry,
      log: deps.log,
    },
    {
      workItem: activeItem ? { id: activeItem.id, kind: activeItem.kind } : undefined,
    },
    ctx,
  );
  deps.log?.info(`${stage.name}: PR #${payload.prId} applied ${applied.applied.childItems.length} child-item(s), ${applied.applied.statusUpdates.length} status-update(s); applier verdict=${applied.verdict}`, {
    stage: stage.name, prNumber: payload.prId,
    applierVerdict: applied.verdict,
    childItems: applied.applied.childItems.length,
    statusUpdates: applied.applied.statusUpdates.length,
    bodyUpdates: applied.applied.bodyUpdates.length,
    applyErrors: applied.applyErrors.length,
  });

  // Answer + resolve inline review threads the supervisor disposed of
  // this cycle. Runs on every agent path (fix-in-place, cancel, escalate,
  // …) so no reviewer comment is left without a note. Bot threads (Copilot)
  // are resolved; human threads get the note but stay open for the human.
  if (payload.reviewThreads.length > 0 || applied.commentReplies.length > 0) {
    await applyThreadDispositions({
      prId: payload.prId,
      stage: stage.name,
      commentReplies: applied.commentReplies,
      reviewThreads: payload.reviewThreads,
      freshReviewCommentIds: payload.freshReviewCommentIds,
      prManager: deps.prManager,
      log: deps.log,
    });
  }

  // "Changes applied" detection — true when EITHER the workspace
  // has uncommitted edits OR the agent advanced HEAD by committing
  // directly via Bash. Pre-2026-05-20 the check only inspected the
  // dirty flag; a post-commit clean tree was reported as "No code
  // changes" even though the agent had committed (PR-887). The
  // headSha comparison catches that path — falls back to the dirty
  // check when the pre-agent SHA was not captured. Hoisted above the
  // verdict branches so the stale-CI guard below sees it too.
  const workspaceDirty = !(await deps.git.isClean());
  let postAgentHeadSha = "";
  try {
    postAgentHeadSha = (await deps.git.headSha()).trim();
  } catch (err) {
    deps.log?.warn(`${stage.name}: failed to capture post-agent HEAD SHA (falling back to dirty-only check)`, {
      stage: stage.name, prNumber: payload.prId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  const headAdvanced = scratch.preAgentHeadSha.length > 0
    && postAgentHeadSha.length > 0
    && scratch.preAgentHeadSha !== postAgentHeadSha;
  const changesApplied = workspaceDirty || headAdvanced;

  // Stale-CI guard — completes the 2026-05-13 stale-CI fix (PR-1186).
  // `payload.checks` is observed at cycle start, BEFORE the supervisor
  // edits/commits, so a `failed` verdict resting on it — the verifier
  // hard-rule "approved while CI failing", or the supervisor declining to
  // approve over red CI — is judging a run the just-pushed fix already
  // supersedes. When the supervisor DID push a fix in response to that
  // failing CI, never latch terminal `ai:failed` on the stale observation:
  // leave the PR in-review so fresh CI on the new commit decides and the
  // next pr-feedback cycle re-evaluates (the recovery the 2026-05-13 note
  // promised but the selector's `ai:failed` exclusion otherwise blocks).
  // Bounded by the maxReviewAttempts cap in beforeAgent, so a genuinely
  // unfixed failure still reaches `ai:failed` once the review budget is
  // spent. Excludes `cancelled` (a human /cancel is a real terminal) and
  // apply/parse errors (real contract violations, not CI staleness).
  const effectiveVerdict = (applied.verdict !== "approved" || applied.applyErrors.length > 0)
    ? applied.verdict
    : agentResult.verdict;
  if (effectiveVerdict === "failed" && applied.applyErrors.length === 0 && changesApplied && ciFailing) {
    await deps.prManager.postBotComment(
      payload.prId,
      formatStaleCiFixMessage(payload.checks.headSha, suffix),
      nextAttribution,
    );
    deps.log?.info(`${stage.name}: PR #${payload.prId} failed verdict rested on stale pre-fix CI but the supervisor pushed a fix — downgrading to in-review for fresh-CI re-evaluation`, {
      stage: stage.name, prNumber: payload.prId,
      effectiveVerdict, ciHead: payload.checks.headSha,
      changesApplied, workspaceDirty, headAdvanced,
    });
    return { verdictOverride: "approved", summaryOverride: applied.summary || agentResult.summary };
  }

  if (applied.verdict !== "approved" || applied.applyErrors.length > 0) {
    const reason = applied.summary || agentResult.summary || "supervisor decision";
    const detail = applied.applyErrors.length > 0
      ? `\n\nApply errors: ${applied.applyErrors.map((e) => `${e.code}: ${e.message}`).join("; ")}`
      : "";
    await deps.prManager.postBotComment(
      payload.prId,
      formatSupervisorTerminalMessage(reason, detail, suffix),
      nextAttribution,
    );
    deps.log?.info(`${stage.name}: PR #${payload.prId} verdict=${applied.verdict} — posted terminal comment`, {
      stage: stage.name, prNumber: payload.prId,
      verdict: applied.verdict, reason,
    });
    return {
      verdictOverride: applied.verdict,
      summaryOverride: applied.summary,
    };
  }

  const effectiveSummary = applied.summary || agentResult.summary;

  if (changesApplied) {
    await deps.prManager.postBotComment(
      payload.prId,
      formatAppliedReviewFeedbackMessage(suffix),
      nextAttribution,
    );
    deps.log?.info(`${stage.name}: PR #${payload.prId} fix-in-place with changes — posted applied comment`, {
      stage: stage.name, prNumber: payload.prId,
      changesApplied: true, workspaceDirty, headAdvanced,
      preAgentHeadSha: scratch.preAgentHeadSha.slice(0, 12),
      postAgentHeadSha: postAgentHeadSha.slice(0, 12),
    });
  } else {
    // The engine asserts ONLY the fact it can observe (clean tree +
    // unchanged HEAD ⇒ no code changes this cycle). It must NOT
    // editorialize the REASON: a verdict=approved + no-changes run can
    // mean "feedback genuinely already addressed" OR "supervisor chose
    // escalate" (supervisor.md maps escalate → approved + no changes).
    // The old hard-coded "considered the feedback already addressed"
    // contradicted the agent's own reasoning on escalate cycles
    // (PR #892, 2026-05-21). The WHY lives in the agent's
    // reasoning block below — never in a fixed engine sentence.
    await deps.prManager.postBotComment(
      payload.prId,
      formatNoCodeChangesMessage(effectiveSummary ?? "", suffix),
      nextAttribution,
    );
    deps.log?.info(`${stage.name}: PR #${payload.prId} fix-in-place no changes — posted no-changes comment, leaving at ai:in-review`, {
      stage: stage.name, prNumber: payload.prId, changesApplied: false,
    });
  }
  return { summaryOverride: effectiveSummary };
}
