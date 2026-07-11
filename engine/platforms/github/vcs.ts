import type { Octokit } from "@octokit/rest";
import type { CodeReview, Comment, Label, ReviewThread } from "@operator/core";
import type { CheckRun, CheckAnnotation, PlatformCapabilities, VCSPlatform } from "@operator/core";
import type { Logger } from "../../logging/logger.js";
import { reRunFailedJobs, fetchJobLogTail } from "./actions.js";
import {
  fetchReviewThreads,
  replyToReviewThread,
  resolveReviewThread,
} from "./review-threads.js";

const SUMMARY_TRUNCATE = 2000;
const TEXT_TRUNCATE = 4000;
const ANNOTATIONS_PER_CHECK_LIMIT = 50;

// ── Label color defaults (ports gh-label.sh get_default_color) ──────────

// GitHub label palette. Lifecycle progression encoded by colour so the operator
// can be read at a glance from the PR list:
//   yellow → blue → light blue → green   (or red on failure)
//   queued   working   human's turn  go-merge
const LABEL_COLORS: Record<string, string> = {
  "ai:pending":         "fbca04", // yellow — queued
  "ai:processing":      "0366d6", // blue — operator actively working
  "ai:in-review":       "bfdadc", // light cyan — handoff, waiting on human
  "ai:ready-to-merge":  "0e8a16", // green — go-merge signal
  "ai:failed":          "d73a4a", // red — execution failed after retries
  "ai:cancelled":       "cccccc", // gray — terminal: cancelled
  "ai:rejected":        "b60205", // dark red — terminal: rejected by reviewer
  "ai:manual":          "6f42c1", // purple — human-driven path
};

function defaultLabelColor(label: string): string {
  if (LABEL_COLORS[label]) return LABEL_COLORS[label];
  if (label.startsWith("ai:")) return "6f42c1";
  return "ededed";
}

// ── Minimal types for GitHub API responses ──────────────────────────────

interface GhPR {
  number: number;
  title: string;
  html_url: string;
  head: { ref: string };
  base: { ref: string };
  draft?: boolean;
  labels: GhLabel[];
  merged?: boolean;
  merged_at?: string | null;
  updated_at?: string;
  state: string;
}

interface GhLabel {
  name?: string;
  color?: string;
  description?: string | null;
}

/**
 * Minimal subset of the GitHub `check-runs` payload consumed by
 * {@link GitHubVCS.mapCheckRun}. Mirrors the Octokit response shape
 * without depending on the generated types — keeps the mapper testable
 * with hand-rolled fixtures.
 */
interface GhCheckRunPayload {
  readonly id: number;
  readonly name: string;
  readonly conclusion?: string | null;
  readonly completed_at?: string | null;
  readonly details_url?: string | null;
  readonly html_url?: string | null;
  readonly app?: { name?: string | null } | null;
  readonly output?: {
    title?: string | null;
    summary?: string | null;
    text?: string | null;
  } | null;
}

function truncate(s: string | null | undefined, max: number): string | undefined {
  if (typeof s !== "string" || s.length === 0) return undefined;
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function mapSeverity(level: string | null | undefined): "notice" | "warning" | "failure" {
  switch (level) {
    case "failure": return "failure";
    case "warning": return "warning";
    default: return "notice";
  }
}

const RUN_ID_PATTERN = /\/actions\/runs\/(\d+)/;
function extractWorkflowRunId(url: string | null | undefined): number | undefined {
  if (typeof url !== "string") return undefined;
  const m = RUN_ID_PATTERN.exec(url);
  if (!m) return undefined;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : undefined;
}

const JOB_ID_PATTERN = /\/job\/(\d+)/;
function extractJobId(url: string | null | undefined): number | undefined {
  if (typeof url !== "string") return undefined;
  const m = JOB_ID_PATTERN.exec(url);
  if (!m) return undefined;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : undefined;
}

/** Conclusions that count as a hard failure for re-run / transient checks. */
const FAILING_CONCLUSIONS = new Set([
  "failure", "timed_out", "action_required", "startup_failure",
]);

/** Job logs are immutable until a re-run mints new job ids — cache generously. */
const JOB_LOG_TTL_MS = 300_000;

interface GhComment {
  id: number;
  user?: { login?: string; type?: string } | null;
  body?: string | null;
  created_at: string;
  updated_at?: string;
  author_association?: string;
}

interface GhReviewComment {
  id: number;
  user?: { login?: string; type?: string } | null;
  body?: string | null;
  created_at: string;
  updated_at?: string;
  path: string;
  author_association?: string;
}

/**
 * Short-TTL in-memory cache entry for `getCodeReviews` results. A single
 * cycle calls this method dozens of times (syncFilesToState per work item,
 * pr-feedback selector per PR, retrospective helpers per closed PR) so
 * caching per-state for a fraction of cycle duration eliminates the
 * hot-loop spam without stale-data risk.
 */
interface GetCodeReviewsCacheEntry {
  readonly expiresAt: number;
  readonly value: CodeReview[];
}

const GET_CODE_REVIEWS_TTL_MS = 60_000;

/**
 * GitHub VCS platform via Octokit REST API.
 */
export class GitHubVCS implements VCSPlatform {
  readonly id = "github";
  readonly capabilities: PlatformCapabilities = {
    codeReviews: true,
    labels: true,
    branches: true,
    comments: true,
    workItems: false,
    issueHierarchy: false,
  };

  private readonly getCodeReviewsCache = new Map<string, GetCodeReviewsCacheEntry>();
  private readonly jobLogCache = new Map<number, { expiresAt: number; value: string | undefined }>();

  constructor(
    private readonly octokit: Octokit,
    private readonly owner: string,
    private readonly repo: string,
    private readonly logger?: Logger,
  ) {}

  // ── Code reviews ────────────────────────────────────────────────────

  async getCodeReviews(options?: { state?: "open" | "closed" | "all" }): Promise<CodeReview[]> {
    const state = options?.state ?? "open";
    const now = Date.now();
    const cached = this.getCodeReviewsCache.get(state);
    if (cached && cached.expiresAt > now) return cached.value;

    let value: CodeReview[];
    if (state === "open") {
      const prs = await this.octokit.paginate(this.octokit.rest.pulls.list, {
        owner: this.owner, repo: this.repo, state: "open", per_page: 100,
      });
      value = (prs as GhPR[]).map(mapPRToCodeReview);
    } else {
      // For closed/all: single page (100 most recently updated) to avoid expensive full pagination
      const { data } = await this.octokit.rest.pulls.list({
        owner: this.owner, repo: this.repo, state, sort: "updated", direction: "desc", per_page: 100,
      });
      value = (data as unknown as GhPR[]).map(mapPRToCodeReview);
    }

    this.getCodeReviewsCache.set(state, { expiresAt: now + GET_CODE_REVIEWS_TTL_MS, value });
    return value;
  }

  /**
   * Evict the `getCodeReviews` cache. Call right after mutating a PR
   * (create/close/label) so the next read reflects the write.
   */
  invalidateCodeReviewsCache(): void {
    this.getCodeReviewsCache.clear();
  }

  async getCodeReview(id: number): Promise<CodeReview | null> {
    try {
      const { data } = await this.octokit.rest.pulls.get({
        owner: this.owner, repo: this.repo, pull_number: id,
      });
      return mapPRToCodeReview(data as unknown as GhPR);
    } catch (err: unknown) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  async createCodeReview(input: {
    title: string;
    body: string;
    baseBranch: string;
    headBranch: string;
    draft?: boolean;
  }): Promise<CodeReview> {
    const { data } = await this.octokit.rest.pulls.create({
      owner: this.owner,
      repo: this.repo,
      title: input.title,
      body: input.body,
      base: input.baseBranch,
      head: input.headBranch,
      draft: input.draft ?? false,
    });
    this.invalidateCodeReviewsCache();
    return mapPRToCodeReview(data as unknown as GhPR);
  }

  async updateCodeReview(
    id: number,
    input: { title?: string; body?: string; draft?: boolean },
  ): Promise<void> {
    // Update title/body via REST
    if (input.title !== undefined || input.body !== undefined) {
      await this.octokit.rest.pulls.update({
        owner: this.owner,
        repo: this.repo,
        pull_number: id,
        ...(input.title !== undefined && { title: input.title }),
        ...(input.body !== undefined && { body: input.body }),
      });
    }

    // Draft→ready requires GraphQL (REST API doesn't support draft changes)
    if (input.draft === false) {
      try {
        const { data: pr } = await this.octokit.rest.pulls.get({
          owner: this.owner, repo: this.repo, pull_number: id,
        });
        if (pr.draft) {
          await this.octokit.graphql(`
            mutation($id: ID!) {
              markPullRequestReadyForReview(input: { pullRequestId: $id }) {
                pullRequest { id }
              }
            }
          `, { id: pr.node_id });
        }
      } catch {
        // Non-fatal — PR may already be ready or token lacks GraphQL scope
      }
    }
  }

  async closeCodeReview(id: number): Promise<void> {
    await this.octokit.rest.pulls.update({
      owner: this.owner, repo: this.repo, pull_number: id, state: "closed",
    });
    this.invalidateCodeReviewsCache();
  }

  /**
   * Squash-merge a PR. Returns `true` on success and `false` when GitHub
   * rejects the merge (conflicts, failing required checks, branch
   * protection, missing approvals). The lifecycle sweep uses the
   * boolean to log a rejection reason without aborting subsequent PRs.
   */
  async mergeCodeReview(id: number): Promise<boolean> {
    try {
      await this.octokit.rest.pulls.merge({
        owner: this.owner, repo: this.repo, pull_number: id,
        merge_method: "squash",
      });
      this.invalidateCodeReviewsCache();
      return true;
    } catch (err: unknown) {
      // GitHub returns 405 (Method Not Allowed) when the PR is not
      // mergeable (conflicts, failing checks, branch protection block).
      // 409 surfaces when a `sha` mismatch — concurrent push moved the
      // tip after our last read. Both are recoverable; treat as "skip".
      const status = (err as { status?: number })?.status;
      if (status === 405 || status === 409 || isNotFound(err)) return false;
      throw err;
    }
  }

  // ── Comments ────────────────────────────────────────────────────────

  async getComments(codeReviewId: number): Promise<Comment[]> {
    const comments = await this.octokit.paginate(
      this.octokit.rest.issues.listComments,
      { owner: this.owner, repo: this.repo, issue_number: codeReviewId, per_page: 100 },
    );
    return (comments as GhComment[]).map(mapComment);
  }

  async getReviewComments(codeReviewId: number): Promise<Comment[]> {
    const comments = await this.octokit.paginate(
      this.octokit.rest.pulls.listReviewComments,
      { owner: this.owner, repo: this.repo, pull_number: codeReviewId, per_page: 100 },
    );
    return (comments as GhReviewComment[]).map(mapReviewComment);
  }

  async postComment(codeReviewId: number, body: string): Promise<Comment> {
    const { data } = await this.octokit.rest.issues.createComment({
      owner: this.owner, repo: this.repo, issue_number: codeReviewId, body,
    });
    return mapComment(data as unknown as GhComment);
  }

  // ── Review threads (inline diff conversations, GraphQL) ─────────────

  /**
   * List the PR's resolvable review threads with resolved state + root-author
   * type. GraphQL-only (REST exposes neither the thread node id nor the
   * resolved flag). Delegates to {@link fetchReviewThreads}.
   */
  async getReviewThreads(codeReviewId: number): Promise<ReviewThread[]> {
    return fetchReviewThreads(this.octokit, this.owner, this.repo, codeReviewId);
  }

  /** Post a threaded reply, keyed by the thread's GraphQL node id. */
  async replyToReviewThread(input: { threadId: string; body: string }): Promise<void> {
    await replyToReviewThread(this.octokit, input.threadId, input.body);
  }

  /** Mark a review thread resolved, keyed by its GraphQL node id. */
  async resolveReviewThread(threadId: string): Promise<void> {
    await resolveReviewThread(this.octokit, threadId);
  }

  // ── Labels (ports gh-label.sh) ──────────────────────────────────────

  async getLabels(codeReviewId: number): Promise<Label[]> {
    const labels = await this.octokit.paginate(
      this.octokit.rest.issues.listLabelsOnIssue,
      { owner: this.owner, repo: this.repo, issue_number: codeReviewId, per_page: 100 },
    );
    return (labels as GhLabel[]).map(mapLabel);
  }

  async addLabel(codeReviewId: number, label: string): Promise<void> {
    await this.ensureLabel(label);
    await this.octokit.rest.issues.addLabels({
      owner: this.owner, repo: this.repo, issue_number: codeReviewId, labels: [label],
    });
  }

  async removeLabel(codeReviewId: number, label: string): Promise<void> {
    try {
      await this.octokit.rest.issues.removeLabel({
        owner: this.owner, repo: this.repo, issue_number: codeReviewId, name: label,
      });
    } catch (err: unknown) {
      if (isNotFound(err)) return;
      throw err;
    }
  }

  // ── Check runs (ports gh_get_failed_checks) ─────────────────────────

  async getCheckRuns(codeReviewId: number): Promise<CheckRun[]> {
    try {
      const { data: pr } = await this.octokit.rest.pulls.get({
        owner: this.owner, repo: this.repo, pull_number: codeReviewId,
      });
      const checkRuns = await this.octokit.paginate(
        this.octokit.rest.checks.listForRef,
        { owner: this.owner, repo: this.repo, ref: pr.head.sha, per_page: 100 },
        (response) => (response.data as unknown as { check_runs: GhCheckRunPayload[] }).check_runs,
      );
      // For failed checks we additionally fetch annotations so the agent
      // can see file:line:message pairs without scraping logs. Skip
      // annotation fetch on success to keep the API budget tight — most
      // CI configurations annotate failures only anyway.
      return await Promise.all(
        checkRuns.map((cr) => this.mapCheckRun(cr, pr.head.sha)),
      );
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      const cause = err instanceof Error && err.cause !== undefined
        ? (err.cause instanceof Error ? err.cause.message : String(err.cause))
        : undefined;
      this.logger?.warn(
        `getCheckRuns failed for PR #${codeReviewId}: ${message}${cause ? ` (cause: ${cause})` : ""}`,
        { codeReviewId, error: message, ...(cause !== undefined && { cause }) },
      );
      return [];
    }
  }

  private async mapCheckRun(
    cr: GhCheckRunPayload,
    headSha: string,
  ): Promise<CheckRun> {
    const conclusion = cr.conclusion ?? "pending";
    const annotations: CheckAnnotation[] = conclusion === "failure"
      ? await this.fetchAnnotations(cr.id)
      : [];
    return {
      name: cr.name,
      conclusion,
      completedAt: cr.completed_at ?? undefined,
      headSha,
      detailsUrl: cr.details_url ?? cr.html_url ?? undefined,
      workflowName: cr.app?.name ?? undefined,
      workflowRunId: extractWorkflowRunId(cr.details_url),
      jobId: extractJobId(cr.details_url),
      title: truncate(cr.output?.title, 200),
      summary: truncate(cr.output?.summary, SUMMARY_TRUNCATE),
      text: truncate(cr.output?.text, TEXT_TRUNCATE),
      annotations: annotations.length > 0 ? annotations : undefined,
    };
  }

  /**
   * Re-run the failed jobs of every workflow run backing this PR's failing
   * checks. Collects the distinct run ids of failed Actions checks on the
   * PR head and asks GitHub to re-run only the failed jobs of each. Returns
   * `true` when at least one run was re-triggered. The engine calls this for
   * a transient/infra CI failure so the pipeline is retried without burning
   * an agent fix-attempt on a non-code problem.
   */
  async reRunFailedChecks(codeReviewId: number): Promise<boolean> {
    const checks = await this.getCheckRuns(codeReviewId);
    const runIds = checks
      .filter((c) => FAILING_CONCLUSIONS.has(c.conclusion.toLowerCase()) && typeof c.workflowRunId === "number")
      .map((c) => c.workflowRunId as number);
    if (runIds.length === 0) return false;
    const ok = await reRunFailedJobs(this.octokit, this.owner, this.repo, runIds);
    if (ok) this.invalidateCodeReviewsCache();
    return ok;
  }

  /**
   * Fetch the tail of a single Actions job's log, cached per job id (logs
   * are immutable until a re-run mints new ids). Best-effort: returns
   * `undefined` when the platform refuses or the job has no log.
   */
  async getJobLogTail(jobId: number): Promise<string | undefined> {
    const now = Date.now();
    const cached = this.jobLogCache.get(jobId);
    if (cached && cached.expiresAt > now) return cached.value;
    const value = await fetchJobLogTail(this.octokit, this.owner, this.repo, jobId);
    this.jobLogCache.set(jobId, { expiresAt: now + JOB_LOG_TTL_MS, value });
    return value;
  }

  private async fetchAnnotations(checkRunId: number): Promise<CheckAnnotation[]> {
    try {
      const items = await this.octokit.paginate(
        this.octokit.rest.checks.listAnnotations,
        { owner: this.owner, repo: this.repo, check_run_id: checkRunId, per_page: 100 },
      );
      const out: CheckAnnotation[] = [];
      for (const a of items) {
        if (out.length >= ANNOTATIONS_PER_CHECK_LIMIT) break;
        if (!a.path || a.start_line == null) continue;
        out.push({
          path: a.path,
          startLine: a.start_line,
          endLine: a.end_line ?? undefined,
          message: a.message ?? "",
          severity: mapSeverity(a.annotation_level),
          title: a.title ?? undefined,
        });
      }
      return out;
    } catch {
      return [];
    }
  }

  // ── Branches ────────────────────────────────────────────────────────

  async createBranch(name: string, fromBranch: string): Promise<void> {
    const { data: ref } = await this.octokit.rest.git.getRef({
      owner: this.owner, repo: this.repo, ref: `heads/${fromBranch}`,
    });
    await this.octokit.rest.git.createRef({
      owner: this.owner, repo: this.repo, ref: `refs/heads/${name}`, sha: ref.object.sha,
    });
  }

  async deleteBranch(name: string): Promise<void> {
    try {
      await this.octokit.rest.git.deleteRef({
        owner: this.owner, repo: this.repo, ref: `heads/${name}`,
      });
    } catch (err: unknown) {
      if (isNotFound(err)) return;
      throw err;
    }
  }

  async listBranches(prefix?: string): Promise<string[]> {
    if (prefix) {
      const refs = await this.octokit.paginate(this.octokit.rest.git.listMatchingRefs, {
        owner: this.owner, repo: this.repo, ref: `heads/${prefix}`, per_page: 100,
      });
      return (refs as Array<{ ref: string }>).map((r) => r.ref.replace("refs/heads/", ""));
    }
    const branches = await this.octokit.paginate(this.octokit.rest.repos.listBranches, {
      owner: this.owner, repo: this.repo, per_page: 100,
    });
    return (branches as Array<{ name: string }>).map((b) => b.name);
  }

  /**
   * Resolve the tip commit author/committer date for a branch. Used by
   * `cleanupBranches` to age out PR-less orphan branches. Returns
   * `null` for unknown branches or commits without a date — caller
   * treats `null` as "skip".
   */
  async getBranchTipCommitTime(name: string): Promise<string | null> {
    try {
      const branch = await this.octokit.rest.repos.getBranch({
        owner: this.owner, repo: this.repo, branch: name,
      });
      const date = branch.data.commit.commit.committer?.date
        ?? branch.data.commit.commit.author?.date
        ?? null;
      return date ?? null;
    } catch (err: unknown) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  // ── Label auto-creation (ports gh-label.sh ensure_label) ────────────

  private async ensureLabel(label: string): Promise<void> {
    const desiredColor = defaultLabelColor(label);
    try {
      const existing = await this.octokit.rest.issues.getLabel({
        owner: this.owner, repo: this.repo, name: label,
      });
      // Reconcile colour if it drifted from the canonical palette. This keeps
      // existing repos self-healing when LABEL_COLORS is updated, with no
      // manual `gh label edit` sweep required. Only updates known `ai:*`
      // labels in the palette to avoid clobbering user-customised colours.
      const currentColor = (existing.data as { color?: string }).color;
      if (LABEL_COLORS[label] && currentColor && currentColor.toLowerCase() !== desiredColor) {
        await this.octokit.rest.issues.updateLabel({
          owner: this.owner, repo: this.repo, name: label, color: desiredColor,
        });
      }
    } catch (err: unknown) {
      if (isNotFound(err)) {
        await this.octokit.rest.issues.createLabel({
          owner: this.owner, repo: this.repo, name: label, color: desiredColor,
        });
        return;
      }
      throw err;
    }
  }
}

// ── Mappers ─────────────────────────────────────────────────────────────

function mapPRToCodeReview(pr: GhPR): CodeReview {
  return {
    id: pr.number,
    title: pr.title,
    url: pr.html_url,
    branch: pr.head.ref,
    baseBranch: pr.base.ref,
    draft: pr.draft ?? false,
    labels: (pr.labels ?? []).map(mapLabel),
    comments: [],
    merged: pr.merged ?? (pr.merged_at != null),
    closed: pr.state === "closed",
    updatedAt: pr.updated_at,
  };
}

function mapComment(c: GhComment): Comment {
  return {
    id: String(c.id),
    author: c.user?.login ?? "unknown",
    body: c.body ?? "",
    createdAt: c.created_at,
    updatedAt: c.updated_at,
    authorAssociation: c.author_association,
    authorType: mapAuthorType(c.user?.type),
  };
}

function mapReviewComment(c: GhReviewComment): Comment {
  return {
    id: String(c.id),
    author: c.user?.login ?? "unknown",
    body: c.body ?? "",
    createdAt: c.created_at,
    updatedAt: c.updated_at,
    path: c.path,
    authorAssociation: c.author_association,
    authorType: mapAuthorType(c.user?.type),
  };
}

function mapAuthorType(type?: string): "User" | "Bot" | undefined {
  if (type === "Bot") return "Bot";
  if (type === "User") return "User";
  return undefined;
}

function mapLabel(l: GhLabel): Label {
  return {
    name: l.name ?? "",
    color: l.color,
    description: l.description ?? undefined,
  };
}

function isNotFound(err: unknown): boolean {
  return typeof err === "object" && err !== null &&
    "status" in err && (err as { status: number }).status === 404;
}
