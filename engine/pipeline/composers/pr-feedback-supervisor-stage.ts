/**
 * Generic stage composer for the "PR feedback supervisor" pattern.
 *
 * Pattern shape (kind-agnostic, stage-name-agnostic):
 *
 *   1. `pr-feedback` selector picks an open AI PR with unread feedback.
 *   2. `WorkspaceScope.prepare` checks out the PR branch.
 *   3. `beforeAgent` enforces the attempt cap, transitions PR label
 *      ai:pending → ai:processing, writes the discussion-thread temp file.
 *   4. `buildRunInput` constructs the configured supervisor-role agent
 *      input (full thread + fresh feedback + CI context).
 *   5. `runStage` invokes the supervisor agent + the configured verifier.
 *   6. `afterAgent` routes the supervisor's stdout through
 *      `applyAgentEvents`: EMIT child-item → source.create (retry-as-new
 *      path), EMIT status-update → source.updateStatus (cancel/duplicate),
 *      EMIT verdict → resolves the stage verdict.
 *
 * Frontmatter ownership: the supervisor agent NEVER writes frontmatter
 * directly. The F3.5 parser guard rejects raw `---` frontmatter outside
 * EMIT blocks. `applyAgentEvents` is the only path that updates
 * `.operator/data/*.md` frontmatter — and it goes through
 * `FileBackedWorkItemSource.updateStatus`.
 *
 * Hook implementations live under `./_shared/`; this module re-exports
 * the public composer surface consumed by `stage-handlers.ts`.
 */

export type { PrFeedbackSupervisorHookDeps } from "./_shared/supervisor-stage-deps.js";
export { buildPrFeedbackSupervisorBeforeAgent } from "./_shared/supervisor-before-agent.js";
export { buildPrFeedbackSupervisorSynthesizeAgentResult } from "./_shared/supervisor-synthesize-agent.js";
export { buildPrFeedbackSupervisorBuildRunInput } from "./_shared/supervisor-build-run-input.js";
export { buildPrFeedbackSupervisorBuildPR } from "./_shared/supervisor-build-pr.js";
export { buildPrFeedbackSupervisorAfterAgent } from "./_shared/supervisor-after-agent-hook.js";
