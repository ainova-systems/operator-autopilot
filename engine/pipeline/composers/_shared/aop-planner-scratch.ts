import type { WorkItemFileData } from "../../../work-items/work-items.js";
import type { HeadSnapshot } from "../../primitives/head-snapshot-contract.js";
import { createScratchStore } from "./scratch.js";

export interface AopPlannerScratch {
  readonly itemId: string;
  readonly filePath: string;
  readonly item: WorkItemFileData;
  readonly codeReviewId: number | null;
  readonly headSnapshot: HeadSnapshot;
  readonly alreadyPlannedChildren?: ReadonlyArray<string>;
  /**
   * Set by `afterAgent` on the rejected verdict path. `buildPR` reads this
   * to produce a rejection-specific PR title (REJECTED suffix) + body that
   * carries the agent's reasoning, instead of the standard in-progress
   * template. The human reviewer sees the rejection explanation directly
   * in the PR description without opening the execution log.
   */
  rejection?: { agentRole: string; reason: string };
}

export const aopPlannerScratch = createScratchStore<AopPlannerScratch>();
