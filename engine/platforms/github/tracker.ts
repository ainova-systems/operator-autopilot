import type { Octokit } from "@octokit/rest";
import type { Comment, WorkItem, Priority } from "@operator/core";
import type { PlatformCapabilities, TrackerPlatform } from "@operator/core";

// ── Minimal types for GitHub Issue responses ────────────────────────────

interface GhIssue {
  number: number;
  title: string;
  body?: string | null;
  state: string;
  labels: Array<{ name?: string }>;
  pull_request?: unknown;
  created_at: string;
  updated_at: string;
}

interface GhIssueComment {
  id: number;
  user?: { login?: string } | null;
  body?: string | null;
  created_at: string;
  updated_at?: string;
}

/**
 * GitHub tracker platform via Octokit REST API (Issues).
 *
 * Maps GitHub Issues to platform-neutral WorkItems.
 */
export class GitHubTracker implements TrackerPlatform {
  readonly id = "github";
  readonly capabilities: PlatformCapabilities = {
    codeReviews: false,
    labels: true,
    branches: false,
    comments: true,
    workItems: true,
    issueHierarchy: false,
  };

  constructor(
    private readonly octokit: Octokit,
    private readonly owner: string,
    private readonly repo: string,
  ) {}

  async getWorkItems(filters?: {
    status?: string[];
    labels?: string[];
    limit?: number;
  }): Promise<WorkItem[]> {
    const state = resolveState(filters?.status);
    const issues = await this.octokit.paginate(this.octokit.rest.issues.listForRepo, {
      owner: this.owner,
      repo: this.repo,
      state,
      per_page: filters?.limit ?? 100,
      ...(filters?.labels && { labels: filters.labels.join(",") }),
    });
    return (issues as GhIssue[])
      .filter((i) => !i.pull_request)
      .map(mapIssueToWorkItem);
  }

  async getWorkItem(id: string): Promise<WorkItem | null> {
    try {
      const { data } = await this.octokit.rest.issues.get({
        owner: this.owner, repo: this.repo, issue_number: Number(id),
      });
      const issue = data as unknown as GhIssue;
      if (issue.pull_request) return null;
      return mapIssueToWorkItem(issue);
    } catch (err: unknown) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  async updateWorkItem(id: string, patch: Partial<WorkItem>): Promise<void> {
    const update: Record<string, unknown> = {};
    if (patch.title !== undefined) update.title = patch.title;
    if (patch.body !== undefined) update.body = patch.body;
    if (patch.status === "completed" || patch.status === "rejected" || patch.status === "duplicate") {
      update.state = "closed";
    }
    await this.octokit.rest.issues.update({
      owner: this.owner, repo: this.repo, issue_number: Number(id), ...update,
    });
  }

  async createWorkItem(input: { title: string; body: string; labels?: string[] }): Promise<WorkItem> {
    const { data } = await this.octokit.rest.issues.create({
      owner: this.owner, repo: this.repo,
      title: input.title, body: input.body,
      labels: input.labels,
    });
    const issue = data as unknown as GhIssue;
    return mapIssueToWorkItem(issue);
  }

  async postWorkItemComment(id: string, body: string): Promise<Comment> {
    const { data } = await this.octokit.rest.issues.createComment({
      owner: this.owner, repo: this.repo, issue_number: Number(id), body,
    });
    const c = data as unknown as GhIssueComment;
    return {
      id: String(c.id),
      author: c.user?.login ?? "unknown",
      body: c.body ?? "",
      createdAt: c.created_at,
      updatedAt: c.updated_at,
    };
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────

function resolveState(statuses?: string[]): "open" | "closed" | "all" {
  if (!statuses || statuses.length === 0) return "open";
  const openStatuses = ["pending", "in-progress", "reopened"];
  const closedStatuses = ["completed", "rejected", "duplicate", "failed"];
  const hasOpen = statuses.some((s) => openStatuses.includes(s));
  const hasClosed = statuses.some((s) => closedStatuses.includes(s));
  if (hasOpen && hasClosed) return "all";
  if (hasClosed) return "closed";
  return "open";
}

function mapIssueToWorkItem(issue: GhIssue): WorkItem {
  return {
    id: String(issue.number),
    kind: "request",
    title: issue.title,
    body: issue.body ?? "",
    status: issue.state === "closed" ? "completed" : "pending",
    priority: 2 as Priority,
    source: `issue#${issue.number}`,
    createdAt: issue.created_at,
    updatedAt: issue.updated_at,
  };
}

function isNotFound(err: unknown): boolean {
  return typeof err === "object" && err !== null &&
    "status" in err && (err as { status: number }).status === 404;
}
