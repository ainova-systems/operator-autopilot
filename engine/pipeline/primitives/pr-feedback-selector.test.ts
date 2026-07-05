import { describe, it, expect, vi } from "vitest";
import type { OperationContext, CodeReview, Comment, ConventionsConfig, ReviewThread } from "@operator/core";
import {
  prFeedbackSelect,
  countBotAttempts,
  formatFeedback,
  formatFullThread,
  detectPrType,
  toReviewThreadRefs,
} from "./pr-feedback-selector.js";
import type { StageDef } from "../types.js";

// ── Fixtures ──────────────────────────────────────────────────────────

function makeCtx(): OperationContext {
  return {
    traceId: "t",
    repoId: "sample",
    action: "pr-review",
    budget: { limitUsd: undefined, spentUsd: 0, add: () => {}, isExceeded: () => false },
    signal: AbortSignal.timeout(10_000),
  };
}

const MARKER = "<!-- bot:operator -->";

const CONVENTIONS: ConventionsConfig = {
  labels: { pending: "ai:pending", processing: "ai:processing", inReview: "ai:in-review", readyToMerge: "ai:ready-to-merge", failed: "ai:failed" },
  branches: { aiPrefix: "ai", init: "ai/init", tasks: "ai/tasks", findings: "ai/findings", research: "ai/research", improver: "ai/improver" },
  prPrefixes: { task: "[AI:Task]", finding: "[AI:Finding]", research: "[AI:Research]", improver: "[AI:Improver]", init: "[AI:Init]" },
  patterns: { taskId: "T{DATE}-{SEQ}", findingPrefix: "F" },
  commentMarker: MARKER,
};

function makeStageDef(overrides?: Partial<StageDef>): StageDef {
  return {
    name: "pr-review",
    agent: "creator",
    selector: "pr-feedback",
    selectorConfig: {
      branchPrefixes: ["ai/tasks", "ai/findings", "ai/research", "ai/improver"],
      ignoreBots: ["github-actions[bot]"],
      commentMarker: MARKER,
      maxAttemptsPerPR: 5,
    },
    merge: "gated",
    branchScope: "pr",
    schedule: "*/5 * * * *",
    review: true,
    enabled: true,
    baseBranch: "develop",
    ...overrides,
  };
}

function makePR(overrides: Partial<CodeReview> = {}): CodeReview {
  return {
    id: 100,
    title: "PR",
    url: "",
    branch: "ai/tasks/T-1",
    baseBranch: "develop",
    draft: false,
    labels: [],
    comments: [],
    merged: false,
    closed: false,
    ...overrides,
  };
}

function makeDeps(overrides?: {
  prs?: CodeReview[];
  comments?: Record<number, Comment[]>;
  reviewComments?: Record<number, Comment[]>;
  reviewThreads?: Record<number, ReviewThread[]>;
  reviewThreadsThrows?: boolean;
  checkRuns?: Record<number, Array<{ name: string; conclusion: string; completedAt?: string; headSha?: string }>>;
  checkRunsThrows?: boolean;
}): { deps: Parameters<typeof prFeedbackSelect>[1]; mocks: { getComments: ReturnType<typeof vi.fn>; getReviewComments: ReturnType<typeof vi.fn>; getReviewThreads: ReturnType<typeof vi.fn>; log: { info: ReturnType<typeof vi.fn>; debug: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn>; child: ReturnType<typeof vi.fn> } } } {
  const prs = overrides?.prs ?? [];
  const comments = overrides?.comments ?? {};
  const reviewComments = overrides?.reviewComments ?? {};
  const reviewThreads = overrides?.reviewThreads ?? {};
  const checkRuns = overrides?.checkRuns ?? {};
  const getComments = vi.fn<(id: number) => Promise<Comment[]>>(async (id) => comments[id] ?? []);
  const getReviewComments = vi.fn<(id: number) => Promise<Comment[]>>(async (id) => reviewComments[id] ?? []);
  const getReviewThreads = vi.fn<(id: number) => Promise<ReviewThread[]>>(async (id) => {
    if (overrides?.reviewThreadsThrows) throw new Error("graphql-scope-failure");
    return reviewThreads[id] ?? [];
  });
  const getCheckRuns = vi.fn<(id: number) => Promise<Array<{ name: string; conclusion: string; completedAt?: string; headSha?: string }>>>(async (id) => {
    if (overrides?.checkRunsThrows) throw new Error("check-runs-api-failure");
    return checkRuns[id] ?? [];
  });
  const log = {
    info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(),
    child: vi.fn(() => log),
  };
  const deps: Parameters<typeof prFeedbackSelect>[1] = {
    vcs: {
      getCodeReviews: vi.fn<() => Promise<CodeReview[]>>().mockResolvedValue(prs),
      getComments, getReviewComments, getReviewThreads, getCheckRuns,
    } as unknown as Parameters<typeof prFeedbackSelect>[1]["vcs"],
    workspacePath: "/tmp/ws",
    conventions: CONVENTIONS,
    log: log as unknown as Parameters<typeof prFeedbackSelect>[1]["log"],
  };
  return { deps, mocks: { getComments, getReviewComments, getReviewThreads, log } };
}

// ── Pure helpers ──────────────────────────────────────────────────────

describe("countBotAttempts", () => {
  it("counts only comments containing the bot marker", () => {
    const comments: Comment[] = [
      { id: "1", author: "b", body: `${MARKER}\none`, createdAt: "" },
      { id: "2", author: "u", body: "human", createdAt: "" },
      { id: "3", author: "b", body: `${MARKER}\ntwo`, createdAt: "" },
    ];
    expect(countBotAttempts(comments, MARKER)).toBe(2);
  });
});

describe("formatFeedback", () => {
  it("returns empty string when no inputs", () => {
    expect(formatFeedback([], [], [])).toBe("");
  });

  it("includes review comments with the id + path handle for disposition mapping", () => {
    const reviewComments: Comment[] = [
      { id: "1", author: "r", body: "tweak", createdAt: "", path: "src/x.ts" },
    ];
    expect(formatFeedback([], reviewComments, [])).toContain("[Review #1 on src/x.ts]");
  });

  it("appends CI failure block when ciFailures is non-empty", () => {
    expect(formatFeedback([], [], ["unit", "e2e"])).toContain("Failed checks: unit, e2e");
  });
});

describe("formatFullThread", () => {
  it("sorts comments chronologically and tags BOT vs USER", () => {
    const comments: Comment[] = [
      { id: "1", author: "u", body: "first", createdAt: "2026-04-16T10:00:00Z" },
      { id: "2", author: "b", body: `${MARKER}\napplied`, createdAt: "2026-04-16T11:00:00Z" },
    ];
    const reviewComments: Comment[] = [
      { id: "3", author: "u", body: "line", createdAt: "2026-04-16T10:30:00Z", path: "src/y.ts" },
    ];
    const thread = formatFullThread(comments, reviewComments, MARKER);
    const lines = thread.split("\n\n");
    expect(lines[0]).toContain("first");
    expect(lines[1]).toContain("[Review on src/y.ts]");
    expect(lines[2]).toContain("[BOT]");
  });
});

describe("detectPrType", () => {
  it("maps plural branch segments to v4-compatible singular type names", () => {
    expect(detectPrType("ai/tasks/T-1")).toBe("task");
    expect(detectPrType("ai/findings/F-1")).toBe("finding");
    expect(detectPrType("ai/improver/2026W16")).toBe("improver");
    expect(detectPrType("ai/retrospective/2026W26")).toBe("retrospective");
  });

  it("falls back to the raw second segment for unknown kinds", () => {
    expect(detectPrType("feature/x")).toBe("x");
  });
});

describe("toReviewThreadRefs", () => {
  it("projects threads and drops empty comment ids", () => {
    const threads: ReviewThread[] = [
      {
        id: "THREAD_A",
        isResolved: false,
        authorType: "Bot",
        comments: [
          { id: "100", author: "copilot", body: "x", createdAt: "" },
          { id: "", author: "copilot", body: "reply w/o id", createdAt: "" },
        ],
      },
    ];
    const refs = toReviewThreadRefs(threads);
    expect(refs).toEqual([
      { threadId: "THREAD_A", isResolved: false, authorType: "Bot", commentIds: ["100"] },
    ]);
  });
});

// ── prFeedbackSelect integration ──────────────────────────────────────

describe("prFeedbackSelect", () => {
  it("covers every ai/* PR uniformly without a per-kind branchPrefixes list", async () => {
    // The retrospective kind used to fall through a stale branchPrefixes
    // list (PR #1132 deadlock). Coverage is now the single ai/ prefix, so a
    // retrospective PR is selected exactly like a task/finding PR.
    const { deps } = makeDeps({
      prs: [makePR({ id: 1132, branch: "ai/retrospective/2026W26" })],
      reviewComments: {
        1132: [{ id: "rc", author: "Copilot", body: "nit", createdAt: "2026-06-22T23:56:25Z", authorType: "Bot", authorAssociation: "NONE", path: "x.md" }],
      },
    });
    const result = await prFeedbackSelect(
      makeStageDef({ selectorConfig: { ignoreBots: ["github-actions[bot]"] } }),
      deps,
      makeCtx(),
    );
    expect(result?.scopeKey).toBe("1132");
    expect((result!.data as { prType: string }).prType).toBe("retrospective");
  });

  it("throws when vcs.getComments is absent", async () => {
    const { deps } = makeDeps();
    const noCommentsDeps = {
      ...deps,
      vcs: { getCodeReviews: vi.fn().mockResolvedValue([]) } as unknown as typeof deps.vcs,
    };
    await expect(
      prFeedbackSelect(makeStageDef(), noCommentsDeps, makeCtx()),
    ).rejects.toThrow(/getComments/);
  });

  it("returns null when no AI PRs are open", async () => {
    const { deps } = makeDeps({ prs: [] });
    const result = await prFeedbackSelect(makeStageDef(), deps, makeCtx());
    expect(result).toBeNull();
  });

  it("skips PRs labeled ai:failed", async () => {
    const { deps } = makeDeps({
      prs: [makePR({ id: 200, labels: [{ name: "ai:failed" }] })],
      comments: { 200: [{ id: "1", author: "u", body: "feedback", createdAt: "2026-04-16T11:00:00Z", authorType: "User", authorAssociation: "OWNER" }] },
    });
    const result = await prFeedbackSelect(makeStageDef(), deps, makeCtx());
    expect(result).toBeNull();
  });

  it("skips PRs labeled ai:processing (concurrent work)", async () => {
    const { deps } = makeDeps({
      prs: [makePR({ id: 201, labels: [{ name: "ai:processing" }] })],
      comments: { 201: [{ id: "1", author: "u", body: "feedback", createdAt: "2026-04-16T11:00:00Z", authorType: "User", authorAssociation: "OWNER" }] },
    });
    const result = await prFeedbackSelect(makeStageDef(), deps, makeCtx());
    expect(result).toBeNull();
  });

  it("skips PRs whose branch prefix is not in selectorConfig", async () => {
    const { deps } = makeDeps({
      prs: [makePR({ id: 202, branch: "feature/unrelated" })],
    });
    const result = await prFeedbackSelect(makeStageDef(), deps, makeCtx());
    expect(result).toBeNull();
  });

  it("does not apply a selector-level bot-reply cap (single source of truth is commit-count in pr-review.beforeAgent)", async () => {
    // Regression: selector no longer skips PRs based on bot-attempt
    // count. Five bot replies + one fresh human comment must still
    // select the PR; the lifetime cap lives in pr-review afterAgent
    // via git.commitCount vs defaults.limits.maxReviewAttempts.
    const { deps } = makeDeps({
      prs: [makePR({ id: 203 })],
      comments: {
        203: [
          { id: "a", author: "b", body: `${MARKER}\n1`, createdAt: "2026-04-16T10:00:00Z" },
          { id: "b", author: "b", body: `${MARKER}\n2`, createdAt: "2026-04-16T10:01:00Z" },
          { id: "c", author: "b", body: `${MARKER}\n3`, createdAt: "2026-04-16T10:02:00Z" },
          { id: "d", author: "b", body: `${MARKER}\n4`, createdAt: "2026-04-16T10:03:00Z" },
          { id: "e", author: "b", body: `${MARKER}\n5`, createdAt: "2026-04-16T10:04:00Z" },
          { id: "f", author: "u", body: "still asking", createdAt: "2026-04-16T11:00:00Z", authorType: "User", authorAssociation: "OWNER" },
        ],
      },
    });
    const result = await prFeedbackSelect(makeStageDef(), deps, makeCtx());
    expect(result?.scopeKey).toBe("203");
    const payload = result!.data as { botAttempts: number };
    expect(payload.botAttempts).toBe(5);
  });

  it("skips PR when bot footer already lists every existing comment as responded", async () => {
    const footer = "<!-- bot:operator/attribution\nresponded: 1\n-->";
    const { deps } = makeDeps({
      prs: [makePR({ id: 204 })],
      comments: {
        204: [
          { id: "1", author: "u", body: "old", createdAt: "2026-04-16T09:00:00Z", authorType: "User", authorAssociation: "OWNER" },
          { id: "2", author: "b", body: `${MARKER}\napplied\n\n${footer}`, createdAt: "2026-04-16T10:00:00Z" },
        ],
      },
    });
    const result = await prFeedbackSelect(makeStageDef(), deps, makeCtx());
    expect(result).toBeNull();
  });

  it("treats legacy bot replies (no footer) as zero-state and triggers on existing comments", async () => {
    // Migration boundary: PRs created before bot-footer existed have
    // bot replies with no structured attribution. Their first cycle
    // post-deploy must re-pick the PR so the next reply writes a real
    // footer; from there the loop stays coherent.
    const { deps } = makeDeps({
      prs: [makePR({ id: 204 })],
      comments: {
        204: [
          { id: "1", author: "u", body: "fix this", createdAt: "2026-04-16T09:00:00Z", authorType: "User", authorAssociation: "OWNER" },
          { id: "2", author: "b", body: `${MARKER}\napplied`, createdAt: "2026-04-16T10:00:00Z" },
        ],
      },
    });
    const result = await prFeedbackSelect(makeStageDef(), deps, makeCtx());
    expect(result?.scopeKey).toBe("204");
  });

  it("PR #816 regression: re-engages a ready-to-merge PR when human comment is fresh", async () => {
    // Before B-410, `ai:ready-to-merge` was in the upfront exclusion
    // set — selectors silently skipped these PRs even when humans
    // commented to override the AI's verdict. Now the label only
    // skips when there is no fresh feedback; a comment re-opens the
    // review loop and pr-review's markInReview drops the label.
    const { deps } = makeDeps({
      prs: [makePR({
        id: 816,
        branch: "ai/findings/F20260416-0001",
        labels: [{ name: "ai:ready-to-merge" }, { name: "invalid" }],
      })],
      comments: {
        816: [
          { id: "b1", author: "bot", body: `${MARKER}\nApplied review feedback.`, createdAt: "2026-05-01T17:10:00Z" },
          { id: "u1", author: "owner", body: "check status", createdAt: "2026-05-02T19:12:00Z", authorType: "User", authorAssociation: "OWNER" },
          { id: "u2", author: "owner", body: "should be investigated", createdAt: "2026-05-02T21:22:00Z", authorType: "User", authorAssociation: "OWNER" },
        ],
      },
    });
    const result = await prFeedbackSelect(makeStageDef(), deps, makeCtx());
    expect(result?.scopeKey).toBe("816");
    const payload = result!.data as { newFeedback: string };
    expect(payload.newFeedback).toContain("check status");
    expect(payload.newFeedback).toContain("should be investigated");
  });

  it("selects PR when fresh human comment exists after last bot response", async () => {
    const { deps } = makeDeps({
      prs: [makePR({ id: 205, branch: "ai/tasks/T-ABC" })],
      comments: {
        205: [
          { id: "1", author: "b", body: `${MARKER}\nprev`, createdAt: "2026-04-16T10:00:00Z" },
          { id: "2", author: "u", body: "please fix", createdAt: "2026-04-16T11:00:00Z", authorType: "User", authorAssociation: "OWNER" },
        ],
      },
    });
    const result = await prFeedbackSelect(makeStageDef(), deps, makeCtx());
    expect(result).not.toBeNull();
    expect(result?.scopeKey).toBe("205");
    const payload = result!.data as { prId: number; branch: string; newFeedback: string; prType: string };
    expect(payload.prId).toBe(205);
    expect(payload.branch).toBe("ai/tasks/T-ABC");
    expect(payload.prType).toBe("task");
    expect(payload.newFeedback).toContain("please fix");
  });

  it("carries review-thread refs and fresh review comment ids for the picked PR", async () => {
    const { deps, mocks } = makeDeps({
      prs: [makePR({ id: 210, branch: "ai/tasks/T-THREADS" })],
      reviewComments: {
        210: [
          { id: "77", author: "copilot", body: "add a null check", createdAt: "2026-07-01T10:00:00Z", authorType: "Bot", path: "src/a.ts" },
        ],
      },
      reviewThreads: {
        210: [
          {
            id: "THREAD_77",
            isResolved: false,
            authorType: "Bot",
            comments: [{ id: "77", author: "copilot", body: "add a null check", createdAt: "2026-07-01T10:00:00Z", authorType: "Bot", path: "src/a.ts" }],
          },
        ],
      },
    });
    const result = await prFeedbackSelect(makeStageDef(), deps, makeCtx());
    expect(result).not.toBeNull();
    const payload = result!.data as {
      reviewThreads: Array<{ threadId: string; commentIds: string[] }>;
      freshReviewCommentIds: string[];
      newFeedback: string;
    };
    expect(payload.freshReviewCommentIds).toEqual(["77"]);
    expect(payload.reviewThreads).toEqual([
      { threadId: "THREAD_77", isResolved: false, authorType: "Bot", commentIds: ["77"] },
    ]);
    expect(payload.newFeedback).toContain("[Review #77 on src/a.ts]");
    // Threads are fetched only for the winner, not every candidate.
    expect(mocks.getReviewThreads).toHaveBeenCalledTimes(1);
    expect(mocks.getReviewThreads).toHaveBeenCalledWith(210);
  });

  it("degrades to no review-thread refs when the threads fetch fails", async () => {
    const { deps, mocks } = makeDeps({
      prs: [makePR({ id: 211, branch: "ai/tasks/T-DEGRADE" })],
      reviewComments: {
        211: [
          { id: "88", author: "copilot", body: "tweak", createdAt: "2026-07-01T10:00:00Z", authorType: "Bot", path: "src/b.ts" },
        ],
      },
      reviewThreadsThrows: true,
    });
    const result = await prFeedbackSelect(makeStageDef(), deps, makeCtx());
    expect(result).not.toBeNull();
    const payload = result!.data as { reviewThreads: unknown[] };
    expect(payload.reviewThreads).toEqual([]);
    expect(mocks.log.warn).toHaveBeenCalledWith(
      expect.stringContaining("getReviewThreads failed"),
      expect.any(Object),
    );
  });

  it("carries empty review-thread refs when the platform has no thread support", async () => {
    const { deps } = makeDeps({
      prs: [makePR({ id: 212, branch: "ai/tasks/T-NOTHREADS" })],
      reviewComments: {
        212: [
          { id: "5", author: "copilot", body: "x", createdAt: "2026-07-01T10:00:00Z", authorType: "Bot", path: "src/c.ts" },
        ],
      },
    });
    // Platform adapter without review-thread support.
    delete (deps.vcs as { getReviewThreads?: unknown }).getReviewThreads;
    const result = await prFeedbackSelect(makeStageDef(), deps, makeCtx());
    expect(result).not.toBeNull();
    const payload = result!.data as { reviewThreads: unknown[] };
    expect(payload.reviewThreads).toEqual([]);
  });

  it("picks oldest-fresh-comment PR when multiple qualify (FIFO)", async () => {
    const { deps } = makeDeps({
      prs: [
        makePR({ id: 300, branch: "ai/tasks/T-NEWER" }),
        makePR({ id: 301, branch: "ai/tasks/T-OLDER" }),
      ],
      comments: {
        300: [{ id: "1", author: "u", body: "later", createdAt: "2026-04-16T13:00:00Z", authorType: "User", authorAssociation: "OWNER" }],
        301: [{ id: "2", author: "u", body: "earlier", createdAt: "2026-04-16T10:00:00Z", authorType: "User", authorAssociation: "OWNER" }],
      },
    });
    const result = await prFeedbackSelect(makeStageDef(), deps, makeCtx());
    expect(result?.scopeKey).toBe("301");
  });

  it("includes every failing check in the CI feedback block (no completedAt filter)", async () => {
    const { deps } = makeDeps({
      prs: [makePR({ id: 400 })],
      comments: {
        400: [{ id: "b", author: "b", body: `${MARKER}\napplied`, createdAt: "2026-04-16T10:00:00Z" }],
      },
      checkRuns: {
        400: [
          { name: "unit", conclusion: "failure", completedAt: "2026-04-16T12:00:00Z" },
          { name: "lint", conclusion: "success", completedAt: "2026-04-16T12:05:00Z" },
          { name: "old", conclusion: "failure", completedAt: "2026-04-16T09:00:00Z" },
        ],
      },
    });
    const result = await prFeedbackSelect(makeStageDef(), deps, makeCtx());
    expect(result).not.toBeNull();
    const payload = result!.data as { newFeedback: string; ciAttempts: number };
    expect(payload.newFeedback).toContain("unit");
    expect(payload.newFeedback).toContain("old");      // no longer dropped by timestamp
    expect(payload.newFeedback).not.toContain("lint"); // success still excluded
    expect(payload.ciAttempts).toBe(0);                // legacy bot reply → reset
  });

  it("defers PR with pending CI even when fresh user comments exist", async () => {
    const { deps, mocks } = makeDeps({
      prs: [makePR({ id: 410 })],
      comments: {
        410: [
          { id: "u1", author: "u", body: "please look", createdAt: "2026-04-16T11:00:00Z", authorType: "User", authorAssociation: "OWNER" },
        ],
      },
      checkRuns: {
        410: [{ name: "build", conclusion: "in_progress" }],
      },
    });
    const result = await prFeedbackSelect(makeStageDef(), deps, makeCtx());
    expect(result).toBeNull();
    expect(mocks.log.debug).toHaveBeenCalledWith(
      expect.stringContaining("ci-pending"),
      expect.objectContaining({ reason: "ci-pending" }),
    );
  });

  it("retries failing CI on the same head SHA up to maxCiRetryAttempts and then skips", async () => {
    const HEAD = "abc12345";
    const exhaustedFooter =
      "<!-- bot:operator/attribution\nci-head: " + HEAD + "\nci-attempt: 3/3\n-->";
    const { deps } = makeDeps({
      prs: [makePR({ id: 420 })],
      comments: {
        420: [
          { id: "b1", author: "b", body: `${MARKER}\nattempt 3 reply\n\n${exhaustedFooter}`, createdAt: "2026-04-16T12:00:00Z" },
        ],
      },
      checkRuns: {
        420: [{ name: "e2e", conclusion: "failure", headSha: HEAD, completedAt: "2026-04-16T13:00:00Z" }],
      },
    });
    // pr-lifecycle owns the markFailed transition; selector just stops
    // burning agent budget.
    const result = await prFeedbackSelect(makeStageDef(), deps, makeCtx());
    expect(result).toBeNull();
  });

  it("resets CI attempt counter when head SHA changes (new commit)", async () => {
    const OLD_HEAD = "old11111";
    const NEW_HEAD = "new22222";
    const exhaustedFooter =
      "<!-- bot:operator/attribution\nci-head: " + OLD_HEAD + "\nci-attempt: 3/3\n-->";
    const { deps } = makeDeps({
      prs: [makePR({ id: 421 })],
      comments: {
        421: [
          { id: "b1", author: "b", body: `${MARKER}\non old head\n\n${exhaustedFooter}`, createdAt: "2026-04-16T12:00:00Z" },
        ],
      },
      checkRuns: {
        // CI re-ran on a new commit → fresh budget regardless of prior history.
        421: [{ name: "e2e", conclusion: "failure", headSha: NEW_HEAD, completedAt: "2026-04-16T13:00:00Z" }],
      },
    });
    const result = await prFeedbackSelect(makeStageDef(), deps, makeCtx());
    expect(result?.scopeKey).toBe("421");
    const payload = result!.data as { ciAttempts: number; maxCiRetryAttempts: number };
    expect(payload.ciAttempts).toBe(0);
    expect(payload.maxCiRetryAttempts).toBe(3);
  });

  it("treats getCheckRuns rejection as non-fatal (observation falls back to none, comment-only feedback still selects)", async () => {
    const { deps } = makeDeps({
      prs: [makePR({ id: 401 })],
      comments: {
        401: [{ id: "1", author: "u", body: "fix", createdAt: "2026-04-16T11:00:00Z", authorType: "User", authorAssociation: "OWNER" }],
      },
      checkRunsThrows: true,
    });
    const result = await prFeedbackSelect(makeStageDef(), deps, makeCtx());
    expect(result?.scopeKey).toBe("401");
    // observeChecks swallows the rejection and returns `value: "none"`
    // so the selection still proceeds on the comment-only feedback. The
    // `checks` payload field carries the empty observation downstream.
    const payload = result!.data as { checks: { value: string; checks: unknown[] } };
    expect(payload.checks.value).toBe("none");
    expect(payload.checks.checks).toEqual([]);
  });

  it("drops ignoredBotLogins from fresh-comment filter", async () => {
    const { deps } = makeDeps({
      prs: [makePR({ id: 402 })],
      comments: {
        402: [
          { id: "1", author: "github-actions[bot]", body: "deploy failed", createdAt: "2026-04-16T11:00:00Z", authorType: "Bot" },
        ],
      },
    });
    // Only ignored-bot comment exists → no fresh feedback → skip.
    const result = await prFeedbackSelect(makeStageDef(), deps, makeCtx());
    expect(result).toBeNull();
  });

  it("accepts trusted bot feedback (non-ignored)", async () => {
    const { deps } = makeDeps({
      prs: [makePR({ id: 403 })],
      comments: {
        403: [
          { id: "1", author: "cursor[bot]", body: "use const", createdAt: "2026-04-16T11:00:00Z", authorType: "Bot" },
        ],
      },
    });
    const result = await prFeedbackSelect(makeStageDef(), deps, makeCtx());
    expect(result?.scopeKey).toBe("403");
    const payload = result!.data as { newFeedback: string };
    expect(payload.newFeedback).toContain("use const");
  });

  it("logs no-candidates at INFO when only ineligible PRs exist", async () => {
    const { deps, mocks } = makeDeps({
      prs: [makePR({ id: 500, branch: "feature/other" })],
    });
    await prFeedbackSelect(makeStageDef(), deps, makeCtx());
    expect(mocks.log.info).toHaveBeenCalledWith(expect.stringContaining("no eligible open"), expect.any(Object));
  });

  it("returns null with candidate-count log when all candidates lack fresh feedback", async () => {
    const { deps, mocks } = makeDeps({
      prs: [makePR({ id: 600 })],
      comments: {
        600: [{ id: "1", author: "b", body: `${MARKER}\nok`, createdAt: "2026-04-16T11:00:00Z" }],
      },
    });
    const result = await prFeedbackSelect(makeStageDef(), deps, makeCtx());
    expect(result).toBeNull();
    expect(mocks.log.info).toHaveBeenCalledWith(
      expect.stringContaining("candidate PR(s) scanned"),
      expect.any(Object),
    );
  });

  it("falls back to commentMarker from selectorConfig when conventions absent", async () => {
    const { deps } = makeDeps({
      prs: [makePR({ id: 800 })],
      comments: {
        800: [{ id: "1", author: "u", body: "hi", createdAt: "2026-04-16T11:00:00Z", authorType: "User", authorAssociation: "OWNER" }],
      },
    });
    const noConv = { ...deps, conventions: undefined };
    const result = await prFeedbackSelect(makeStageDef(), noConv, makeCtx());
    expect(result?.scopeKey).toBe("800");
  });

  it("honors maxCiRetryAttempts override from selectorConfig", async () => {
    const HEAD = "deadbeef";
    const exhaustedFooter =
      "<!-- bot:operator/attribution\nci-head: " + HEAD + "\nci-attempt: 1/1\n-->";
    const { deps } = makeDeps({
      prs: [makePR({ id: 840 })],
      comments: {
        840: [
          { id: "b1", author: "b", body: `${MARKER}\nfirst try\n\n${exhaustedFooter}`, createdAt: "2026-04-16T12:00:00Z" },
        ],
      },
      checkRuns: {
        840: [{ name: "lint", conclusion: "failure", headSha: HEAD, completedAt: "2026-04-16T13:00:00Z" }],
      },
    });
    // override via selectorConfig: cap=1 means after one bot reply on the
    // same head SHA the budget is exhausted and selector skips.
    const tightDef = makeStageDef({
      selectorConfig: {
        branchPrefixes: ["ai/tasks", "ai/findings"],
        ignoreBots: [],
        commentMarker: MARKER,
        maxCiRetryAttempts: 1,
      },
    });
    const result = await prFeedbackSelect(tightDef, deps, makeCtx());
    expect(result).toBeNull();
  });

  it("includes review-comment timestamps when seeding oldestFreshAt", async () => {
    // Review comments (file-line comments from Cursor / Copilot review
    // bots) participate in fresh-feedback ordering alongside issue
    // comments. Earlier review comment must drive oldestFreshAt.
    const { deps } = makeDeps({
      prs: [makePR({ id: 850 })],
      comments: {
        850: [
          { id: "c1", author: "u", body: "later issue comment", createdAt: "2026-04-16T12:00:00Z", authorType: "User", authorAssociation: "OWNER" },
        ],
      },
      reviewComments: {
        850: [
          { id: "rc1", author: "u", body: "earlier review thread", createdAt: "2026-04-16T11:00:00Z", authorType: "User", authorAssociation: "OWNER" },
        ],
      },
    });
    const result = await prFeedbackSelect(makeStageDef(), deps, makeCtx());
    expect(result?.scopeKey).toBe("850");
    const payload = result!.data as { oldestFreshAt: string; newFeedback: string };
    // earlier review-comment timestamp wins over later issue comment
    expect(payload.oldestFreshAt).toBe("2026-04-16T11:00:00Z");
    // both comment streams flow into the formatted feedback
    expect(payload.newFeedback).toContain("earlier review thread");
    expect(payload.newFeedback).toContain("later issue comment");
  });
});
