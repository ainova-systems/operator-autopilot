import type { DateRange, OperationContext } from "./context.js";

export interface FeedbackSignal {
  readonly source: string;
  readonly type: "ci" | "runtime" | "custom";
  readonly status: "ok" | "warning" | "error";
  readonly message: string;
  readonly capturedAt: string;
}

export interface OutcomeAssessment {
  readonly status: "healthy" | "degraded" | "broken" | "unknown";
  readonly recommendation: "keep" | "rollback" | "investigate" | "wait-more";
  readonly riskScore: number;
}

export interface FeedbackSource {
  readonly id: string;
  collect(input: {
    projectId: string;
    codeReviewId?: number;
    range?: DateRange;
    operation: OperationContext;
  }): Promise<FeedbackSignal[]>;
}

export interface FeedbackCollector {
  readonly sources: FeedbackSource[];
  collectAll(input: {
    projectId: string;
    codeReviewId?: number;
    operation: OperationContext;
  }): Promise<FeedbackSignal[]>;
  assess(signals: FeedbackSignal[]): OutcomeAssessment;
}
