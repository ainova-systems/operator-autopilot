export function formatReviewLimitReachedMessage(
  reviewAttempts: number,
  maxAttempts: number,
  suffix: string,
): string {
  return `⚠️ **Review cycle limit reached** — This PR has gone through ${reviewAttempts} review-fix cycles (limit: ${maxAttempts}). The supervisor was unable to resolve all feedback within the allowed iterations. Marking as failed — manual intervention required.${suffix}`;
}

export function formatStaleCiFixMessage(ciHeadSha: string | undefined, suffix: string): string {
  return `Applied review feedback. The failing check(s) were observed on the pre-fix commit (${ciHeadSha?.slice(0, 12) ?? "unknown"}); the pushed fix supersedes that run — leaving the PR in review so fresh CI on the new commit decides.${suffix}`;
}

export function formatSupervisorTerminalMessage(
  reason: string,
  applyErrorDetail: string,
  suffix: string,
): string {
  return `Supervisor decision: ${reason}.${applyErrorDetail}${suffix}`;
}

export function formatAppliedReviewFeedbackMessage(suffix: string): string {
  return `Applied review feedback.${suffix}`;
}

/**
 * Format the no-changes bot comment for a supervisor cycle.
 *
 * The engine asserts ONLY the fact it can observe (clean tree + unchanged HEAD
 * ⇒ no code changes this cycle). It must NOT editorialize the REASON: a
 * verdict=approved + no-changes run can mean "feedback genuinely already
 * addressed" OR "supervisor chose escalate" (supervisor.md maps escalate →
 * approved + no changes). A fixed engine sentence contradicted the agent's
 * own reasoning on escalate cycles (PR #892, 2026-05-21). The WHY lives in
 * the agent's reasoning block below — never in a fixed engine sentence.
 */
export function formatNoCodeChangesMessage(effectiveSummary: string, suffix: string): string {
  const reasoning = effectiveSummary.trim().slice(0, 1500);
  const reasoningBlock = reasoning ? `\n\n${reasoning}` : "";
  return `No code changes in this cycle.${reasoningBlock}\n\nReply on this PR if you disagree and I'll re-evaluate.${suffix}`;
}
