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
  const effectiveVerdict = (applied.verdict !== "approved" || applied.applyErrors.length > 0)
    ? applied.verdict
    : agentResult.verdict;

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
