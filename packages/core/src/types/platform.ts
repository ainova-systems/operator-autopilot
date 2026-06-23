import type { CodeReview, Comment, Label, WorkItem } from "./domain.js";

export interface PlatformCapabilities {
  readonly codeReviews: boolean;
  readonly labels: boolean;
  readonly branches: boolean;
  readonly comments: boolean;
  readonly workItems: boolean;
  readonly issueHierarchy: boolean;
}

export interface CheckAnnotation {
  readonly path: string;
  readonly startLine: number;
  readonly endLine?: number;
  readonly message: string;
  readonly severity: "notice" | "warning" | "failure";
  readonly title?: string;
}

export interface CheckRun {
  readonly name: string;
  readonly conclusion: string;
  readonly completedAt?: string;
  /** Commit SHA the check was run against. */
  readonly headSha?: string;
  /** Direct link to the workflow run / external CI page. */
  readonly detailsUrl?: string;
  /** Workflow name (when the check originates from GitHub Actions). */
  readonly workflowName?: string;
  /** Workflow run id, useful for log drill-downs in the UI. */
  readonly workflowRunId?: number;
  /** `output.title` — short failure summary. */
  readonly title?: string;
  /** `output.summary` — markdown summary, truncated by the adapter. */
  readonly summary?: string;
  /** `output.text` — long-form details, truncated by the adapter. */
  readonly text?: string;
  /** `annotations[]` — file:line:message rows attached to the check. */
  readonly annotations?: CheckAnnotation[];
}

export interface VCSPlatform {
  readonly id: string;
  readonly capabilities: PlatformCapabilities;

  getCodeReviews(options?: { state?: "open" | "closed" | "all" }): Promise<CodeReview[]>;
  getCodeReview(id: number): Promise<CodeReview | null>;
  createCodeReview(input: {
    title: string;
    body: string;
    baseBranch: string;
    headBranch: string;
    draft?: boolean;
  }): Promise<CodeReview>;
  updateCodeReview(id: number, input: { title?: string; body?: string; draft?: boolean }): Promise<void>;
  closeCodeReview(id: number): Promise<void>;
  /**
   * Optional: merge a code review (squash-merge by default for AI PRs).
   * Resolves `true` when the merge succeeded and `false` when the
   * platform refused (conflicts, failing checks, missing approvals,
   * etc.) so `pr-lifecycle` can log the rejection without blowing up
   * the sweep. Adapters that do not implement merging leave the method
   * out and `pr-lifecycle` skips the auto-merge rule for this platform.
   */
  mergeCodeReview?(id: number): Promise<boolean>;

  getComments(codeReviewId: number): Promise<Comment[]>;
  getReviewComments(codeReviewId: number): Promise<Comment[]>;
  postComment(codeReviewId: number, body: string): Promise<Comment>;

  getLabels(codeReviewId: number): Promise<Label[]>;
  addLabel(codeReviewId: number, label: string): Promise<void>;
  removeLabel(codeReviewId: number, label: string): Promise<void>;

  /** Get CI check runs for a PR's head commit. Returns empty array if unsupported. */
  getCheckRuns?(codeReviewId: number): Promise<CheckRun[]>;

  createBranch(name: string, fromBranch: string): Promise<void>;
  deleteBranch(name: string): Promise<void>;
  listBranches(prefix?: string): Promise<string[]>;
  /**
   * Optional: return the ISO timestamp of the branch tip commit. Used
   * by `cleanupBranches` to identify orphan branches (no PR + older
   * than the orphan threshold). Adapters that cannot cheaply expose
   * this leave the method out and the cleanup falls back to
   * "skip orphan handling" — safe but less aggressive.
   */
  getBranchTipCommitTime?(name: string): Promise<string | null>;
}

export interface TrackerPlatform {
  readonly id: string;
  readonly capabilities: PlatformCapabilities;

  getWorkItems(filters?: {
    status?: string[];
    labels?: string[];
    limit?: number;
  }): Promise<WorkItem[]>;
  getWorkItem(id: string): Promise<WorkItem | null>;
  updateWorkItem(id: string, patch: Partial<WorkItem>): Promise<void>;
  postWorkItemComment(id: string, body: string): Promise<Comment>;
  createWorkItem?(input: { title: string; body: string; labels?: string[] }): Promise<WorkItem>;
}
