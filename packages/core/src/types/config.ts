type DeliveryMethod = "auto-commit" | "auto-merge-pr" | "human-review-pr" | "always-pr";

export interface ProjectRef {
  readonly id: string;
  readonly name?: string;
  readonly repository: string;
}

export interface LabelsConfig {
  readonly pending: string;
  readonly processing: string;
  /**
   * Applied-changes / review-loop-active label. Signals "AI handled
   * current feedback, waiting on the next CI run or comment". The
   * pr-feedback selector scans PRs with this label for fresh feedback.
   */
  readonly inReview: string;
  /**
   * Terminal handoff label — AI verified the PR is ready, only the human
   * merge is outstanding. The pr-feedback selector excludes PRs carrying
   * this label so the review loop does not re-enter a merge-ready PR.
   */
  readonly readyToMerge: string;
  readonly failed: string;
  readonly manual?: string;
  /** Task no longer needed or not processable — closes PR, no retry. */
  readonly cancelled?: string;
  /** Task scope wrong — closes PR, future retrospective recreates task. */
  readonly rejected?: string;
}

export interface BranchConventions {
  readonly aiPrefix: string;
  readonly init: string;
  readonly tasks: string;
  readonly findings: string;
  readonly research: string;
  readonly improver: string;
}

export interface PRConventions {
  readonly task: string;
  readonly finding: string;
  readonly research: string;
  readonly improver: string;
  readonly init: string;
  readonly failed?: string;
  readonly manual?: string;
}

export interface PatternConventions {
  readonly taskId: string;
  readonly findingPrefix: string;
}

export interface ConventionsConfig {
  readonly labels: LabelsConfig;
  readonly branches: BranchConventions;
  readonly prPrefixes: PRConventions;
  readonly patterns: PatternConventions;
  readonly commentMarker: string;
}

/**
 * PR-lifecycle automation knobs. Each field is `null` (rule disabled) or
 * a non-negative number of hours. Defaults live in
 * `engine-defaults/global.lifecycle`; per-repo overrides land on
 * `repos/{id}.lifecycle`; per-work-item overrides come from frontmatter
 * `lifecycle_*` fields. Resolution order: item < repo < defaults.
 */
export interface LifecycleConfig {
  readonly promoteToReadyAfterIdleHours?: number | null;
  readonly autoMergeReadyAfterHours?: number | null;
  readonly autoCloseStuckAfterHours?: number | null;
}

export interface DefaultsConfig {
  readonly schedules: {
    readonly prReviewMinutes: number;
    readonly taskSelectMinutes: number;
    readonly findingSelectMinutes: number;
    readonly dailyResearchHour: number;
    readonly improverDayOfWeek: number;
    readonly prLifecycleMinutes: number;
  };
  readonly limits: {
    readonly maxReviewAttempts: number;
  };
  readonly review: {
    /** Bot logins whose comments do NOT trigger a review cycle (noise filter). */
    readonly ignoredBotLogins: ReadonlyArray<string>;
  };
  readonly lifecycle: LifecycleConfig;
}

export interface VCSProjectConfig {
  readonly platform: string;
  readonly repo: string;
  readonly branch: string;
  readonly tokenEnvVar: string;
}

export interface TrackerProjectConfig {
  readonly platform: string;
  readonly project?: string;
  readonly repo?: string;
  readonly tokenEnvVar?: string;
}

export interface ProjectFeaturesConfig {
  readonly prReview?: boolean;
  readonly findingSelect?: boolean;
  readonly findingExecute?: boolean;
  readonly taskSelect?: boolean;
  readonly taskExecute?: boolean;
  readonly dailyResearch?: boolean;
  readonly improver?: boolean;
}

export interface ProjectLimitsConfig {
  readonly maxActiveTasks?: number;
  readonly maxActiveFindings?: number;
}

export interface DeliveryConfig {
  readonly low: DeliveryMethod;
  readonly medium: DeliveryMethod;
  readonly high: DeliveryMethod;
  readonly overrides?: Record<string, DeliveryMethod>;
}

export interface VerificationCheckConfig {
  readonly type: "build" | "tests" | "custom";
  readonly command: string;
  readonly timeoutMs?: number;
}

export interface VerificationConfig {
  readonly command?: string;
  readonly checks?: VerificationCheckConfig[];
}

export interface FeedbackSourceConfig {
  readonly type: "github-ci" | "health-check" | "custom";
  readonly url?: string;
  readonly script?: string;
  readonly intervals?: string[];
}

export interface FeedbackConfig {
  readonly sources?: FeedbackSourceConfig[];
}

export interface ProjectConfig {
  readonly id: string;
  readonly vcs: VCSProjectConfig;
  readonly tracker?: TrackerProjectConfig;
  readonly features?: ProjectFeaturesConfig;
  readonly limits?: ProjectLimitsConfig;
  readonly delivery?: DeliveryConfig;
  readonly verification?: VerificationConfig;
  readonly feedback?: FeedbackConfig;
  /**
   * Per-repo override of the engine-defaults `lifecycle` block. Fields
   * left undefined inherit the global default; explicit `null` on a
   * field disables the rule for this repo even if the default has it on.
   */
  readonly lifecycle?: LifecycleConfig;
  /** Append a CI run link to failure-path PR comments (GitHub Actions only). */
  readonly debug?: boolean;
}

export interface OperatorConfig {
  readonly defaults: DefaultsConfig;
  readonly conventions: ConventionsConfig;
  readonly repos: ProjectConfig[];
}
