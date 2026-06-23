import type { CodeReview, Comment, Label } from "@operator/core";
import type { PlatformCapabilities, VCSPlatform } from "@operator/core";

/**
 * In-memory VCS platform for testing.
 *
 * All operations work against local arrays — no API calls.
 * Pre-populate via public fields before running tests.
 */
export class TestVCSPlatform implements VCSPlatform {
  readonly id = "test-vcs";
  readonly capabilities: PlatformCapabilities = {
    codeReviews: true,
    labels: true,
    branches: true,
    comments: true,
    workItems: false,
    issueHierarchy: false,
  };

  codeReviews: CodeReview[] = [];
  comments: Map<number, Comment[]> = new Map();
  reviewComments: Map<number, Comment[]> = new Map();
  labels: Map<number, Label[]> = new Map();
  branches: string[] = [];

  private nextId = 1;

  async getCodeReviews(options?: { state?: "open" | "closed" | "all" }): Promise<CodeReview[]> {
    const state = options?.state ?? "open";
    if (state === "open") return this.codeReviews.filter((cr) => !cr.closed);
    if (state === "closed") return this.codeReviews.filter((cr) => cr.closed);
    return [...this.codeReviews];
  }

  async getCodeReview(id: number): Promise<CodeReview | null> {
    return this.codeReviews.find((cr) => cr.id === id) ?? null;
  }

  async createCodeReview(input: {
    title: string;
    body: string;
    baseBranch: string;
    headBranch: string;
    draft?: boolean;
  }): Promise<CodeReview> {
    const cr: CodeReview = {
      id: this.nextId++,
      title: input.title,
      url: `https://test.example.com/pr/${this.nextId - 1}`,
      branch: input.headBranch,
      baseBranch: input.baseBranch,
      draft: input.draft ?? false,
      labels: [],
      comments: [],
      merged: false,
      closed: false,
    };
    this.codeReviews.push(cr);
    return cr;
  }

  async updateCodeReview(id: number, input: { title?: string; body?: string; draft?: boolean }): Promise<void> {
    const idx = this.codeReviews.findIndex((cr) => cr.id === id);
    if (idx === -1) return;
    const cr = this.codeReviews[idx];
    this.codeReviews[idx] = {
      ...cr,
      title: input.title ?? cr.title,
      draft: input.draft ?? cr.draft,
    };
  }

  async closeCodeReview(id: number): Promise<void> {
    const idx = this.codeReviews.findIndex((cr) => cr.id === id);
    if (idx === -1) return;
    this.codeReviews[idx] = { ...this.codeReviews[idx], closed: true };
  }

  async getComments(codeReviewId: number): Promise<Comment[]> {
    return [...(this.comments.get(codeReviewId) ?? [])];
  }

  async getReviewComments(codeReviewId: number): Promise<Comment[]> {
    return [...(this.reviewComments.get(codeReviewId) ?? [])];
  }

  async postComment(codeReviewId: number, body: string): Promise<Comment> {
    const comment: Comment = {
      id: String(this.nextId++),
      author: "test-bot",
      body,
      createdAt: new Date().toISOString(),
    };
    const existing = this.comments.get(codeReviewId) ?? [];
    existing.push(comment);
    this.comments.set(codeReviewId, existing);
    return comment;
  }

  async getLabels(codeReviewId: number): Promise<Label[]> {
    return [...(this.labels.get(codeReviewId) ?? [])];
  }

  async addLabel(codeReviewId: number, label: string): Promise<void> {
    const existing = this.labels.get(codeReviewId) ?? [];
    if (!existing.some((l) => l.name === label)) {
      existing.push({ name: label });
    }
    this.labels.set(codeReviewId, existing);
  }

  async removeLabel(codeReviewId: number, label: string): Promise<void> {
    const existing = this.labels.get(codeReviewId) ?? [];
    this.labels.set(
      codeReviewId,
      existing.filter((l) => l.name !== label),
    );
  }

  async createBranch(name: string, _fromBranch: string): Promise<void> {
    if (!this.branches.includes(name)) {
      this.branches.push(name);
    }
  }

  async deleteBranch(name: string): Promise<void> {
    this.branches = this.branches.filter((b) => b !== name);
  }

  async listBranches(prefix?: string): Promise<string[]> {
    if (!prefix) return [...this.branches];
    return this.branches.filter((b) => b.startsWith(prefix));
  }
}
