import type { AgentResult, StageDef, Verdict } from "../../types.js";
import type { PrFeedbackPayload } from "../../primitives/pr-feedback-selector.js";
import type { AopApplyResult } from "../../primitives/aop-applier.js";
import { formatDebugRunLinkSuffix } from "../../../delivery/vcs-helpers.js";
import type { BotAttribution } from "../../../delivery/bot-footer.js";
import type { PrFeedbackSupervisorScratch } from "./supervisor-scratch.js";
import type { SupervisorAfterAgentDeps } from "./supervisor-after-agent-deps.js";
import type { SupervisorChanges } from "./supervisor-change-detection.js";
import {
  formatAppliedReviewFeedbackMessage,
  formatNoCodeChangesMessage,
  formatStaleCiFixMessage,
  formatSupervisorTerminalMessage,
} from "./supervisor-bot-messages.js";

export async function routeSupervisorVerdict(
  deps: SupervisorAfterAgentDeps,
  stage: StageDef,
  payload: PrFeedbackPayload,
  scratch: PrFeedbackSupervisorScratch,
  agentResult: AgentResult,
  applied: AopApplyResult,
  changes: SupervisorChanges,
  nextAttribution: BotAttribution,
  ciFailing: boolean,
): Promise<{ verdictOverride?: Verdict; summaryOverride?: string } | void> {
  const suffix = formatDebugRunLinkSuffix(deps.debug, deps.debugRunUrl);

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
  const effectiveVerdict = (applied.verdict !== "approved" || applied.applyErrors.length > 0)
    ? applied.verdict
    : agentResult.verdict;

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
  if (effectiveVerdict === "failed" && applied.applyErrors.length === 0 && changes.changesApplied && ciFailing) {
    await deps.prManager.postBotComment(
      payload.prId,
      formatStaleCiFixMessage(payload.checks.headSha, suffix),
      nextAttribution,
    );
    deps.log?.info(`${stage.name}: PR #${payload.prId} failed verdict rested on stale pre-fix CI but the supervisor pushed a fix — downgrading to in-review for fresh-CI re-evaluation`, {
      stage: stage.name, prNumber: payload.prId,
      effectiveVerdict, ciHead: payload.checks.headSha,
      changesApplied: changes.changesApplied,
      workspaceDirty: changes.workspaceDirty, headAdvanced: changes.headAdvanced,
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

  if (changes.changesApplied) {
    await deps.prManager.postBotComment(
      payload.prId,
      formatAppliedReviewFeedbackMessage(suffix),
      nextAttribution,
    );
    deps.log?.info(`${stage.name}: PR #${payload.prId} fix-in-place with changes — posted applied comment`, {
      stage: stage.name, prNumber: payload.prId,
      changesApplied: true,
      workspaceDirty: changes.workspaceDirty, headAdvanced: changes.headAdvanced,
      preAgentHeadSha: scratch.preAgentHeadSha.slice(0, 12),
      postAgentHeadSha: changes.postAgentHeadSha.slice(0, 12),
    });
  } else {
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
