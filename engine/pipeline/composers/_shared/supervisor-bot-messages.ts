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

export function formatNoCodeChangesMessage(effectiveSummary: string, suffix: string): string {
  const reasoning = effectiveSummary.trim().slice(0, 1500);
  const reasoningBlock = reasoning ? `\n\n${reasoning}` : "";
  return `No code changes in this cycle.${reasoningBlock}\n\nReply on this PR if you disagree and I'll re-evaluate.${suffix}`;
}
