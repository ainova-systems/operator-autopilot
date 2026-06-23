import type { OperationContext } from "./context.js";
import type { WorkItem } from "./domain.js";

export type PipelineName = "research" | "finding" | "task" | "review" | "optimization" | "init";

export interface PipelineContext {
  readonly operation: OperationContext;
  readonly pipeline: PipelineName;
  readonly projectId: string;
  readonly workspacePath: string;
  readonly workItem?: WorkItem;
}

export interface PipelineStageResult {
  readonly status: "completed" | "skipped" | "failed";
  readonly message?: string;
}

export interface PipelineStage {
  readonly id: string;
  readonly requires: string[];
  run(ctx: PipelineContext): Promise<PipelineStageResult>;
}

export interface Pipeline {
  readonly id: PipelineName;
  readonly stages: PipelineStage[];
  run(ctx: PipelineContext): Promise<void>;
}
