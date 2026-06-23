import type { OperationContext } from "@operator/core";
import type { FeedbackCollector, FeedbackSignal, FeedbackSource, OutcomeAssessment } from "@operator/core";

/**
 * Default feedback collector.
 * Aggregates signals from all registered sources and assesses outcome.
 */
export class DefaultFeedbackCollector implements FeedbackCollector {
  readonly sources: FeedbackSource[];

  constructor(sources: FeedbackSource[]) {
    this.sources = sources;
  }

  async collectAll(input: {
    projectId: string;
    codeReviewId?: number;
    operation: OperationContext;
  }): Promise<FeedbackSignal[]> {
    const signals: FeedbackSignal[] = [];
    for (const source of this.sources) {
      try {
        const collected = await source.collect({
          projectId: input.projectId,
          codeReviewId: input.codeReviewId,
          operation: input.operation,
        });
        signals.push(...collected);
      } catch {
        // Individual source failure is non-fatal
      }
    }
    return signals;
  }

  assess(signals: FeedbackSignal[]): OutcomeAssessment {
    if (signals.length === 0) {
      return { status: "unknown", recommendation: "wait-more", riskScore: 0 };
    }

    const errors = signals.filter((s) => s.status === "error");
    const warnings = signals.filter((s) => s.status === "warning");

    if (errors.length > 0) {
      return {
        status: "broken",
        recommendation: "rollback",
        riskScore: Math.min(1, errors.length * 0.3 + 0.4),
      };
    }

    if (warnings.length > 0) {
      return {
        status: "degraded",
        recommendation: "investigate",
        riskScore: Math.min(1, warnings.length * 0.15 + 0.1),
      };
    }

    return { status: "healthy", recommendation: "keep", riskScore: 0 };
  }
}

/**
 * GitHub CI feedback source.
 * Reads check run results from GitHub API after merge.
 * Ports the CI feedback collection from V1 (gh_get_failed_checks).
 */
export class GitHubCIFeedbackSource implements FeedbackSource {
  readonly id = "github-ci";

  constructor(
    private readonly getCheckStatus: (codeReviewId: number) => Promise<Array<{ name: string; conclusion: string }>>,
  ) {}

  async collect(input: {
    projectId: string;
    codeReviewId?: number;
    operation: OperationContext;
  }): Promise<FeedbackSignal[]> {
    if (!input.codeReviewId) return [];

    const checks = await this.getCheckStatus(input.codeReviewId);
    const now = new Date().toISOString();

    return checks.map((check) => ({
      source: "github-ci",
      type: "ci" as const,
      status: check.conclusion === "success" ? "ok" as const
        : check.conclusion === "failure" ? "error" as const
        : "warning" as const,
      message: `${check.name}: ${check.conclusion}`,
      capturedAt: now,
    }));
  }
}
