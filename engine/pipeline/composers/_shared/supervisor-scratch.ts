import { createScratchStore } from "./scratch.js";

export interface PrFeedbackSupervisorScratch {
  readonly prId: number;
  readonly branch: string;
  readonly prType: string;
  readonly reviewAttempts: number;
  readonly maxAttempts: number;
  readonly limitReached: boolean;
  readonly threadFile: string;
  readonly newFeedback: string;
  checksContextFile: string;
  /**
   * HEAD SHA captured at beforeAgent (post workspace checkout). Used in
   * afterAgent to detect whether the supervisor agent committed during
   * the run. `git.isClean()` alone returned `true` after a successful
   * commit, leading the engine to misreport "No code changes" when the
   * agent had in fact committed and pushed — the 2026-05-20 PR-887
   * regression. Empty string when capture failed (best-effort; the
   * afterAgent comparison treats empty as "unknown, fall back to dirty
   * check").
   */
  preAgentHeadSha: string;
}

export const prFeedbackSupervisorScratch = createScratchStore<PrFeedbackSupervisorScratch>();

export const prFeedbackSupervisorScratchKey = (prId: number): string => String(prId);
