import type { VCSPlatform } from "@operator/core";
import type { CodeReview } from "@operator/core";
import type { ConventionsConfig } from "@operator/core";
import type { TemplateSource } from "../agents/kv-template-source.js";
import { formatFooter, type BotAttribution } from "./bot-footer.js";

/**
 * PR lifecycle operations shared across all pipeline stages.
 * Handles: create, label transitions, bot comments, close/ready.
 *
 * Ports: gh-label.sh + PR creation logic from all worker scripts.
 */
export class PRManager {
  constructor(
    private readonly vcs: VCSPlatform,
    private readonly conventions: ConventionsConfig,
    /**
     * KV-backed template source. Required for `loadTemplate` calls; the
     * `templatesDir` argument on that method is legacy positional padding and
     * is ignored in runtime paths after Step 15. `undefined` is accepted only
     * for test fixtures that mock `loadTemplate` directly.
     */
    private readonly templates?: TemplateSource,
  ) {}

  /** Create a draft PR with pending label. */
  async createDraft(input: {
    title: string;
    body: string;
    branch: string;
    baseBranch: string;
  }): Promise<CodeReview> {
    const cr = await this.vcs.createCodeReview({
      ...input,
      headBranch: input.branch,
      draft: true,
    });
    const label = this.resolveLabel("pending");
    await this.vcs.addLabel(cr.id, label).catch(() => {});
    return cr;
  }

  /**
   * Mark PR as processing — sweeps every non-processing lifecycle label
   * including `failed` so retry of a previously-failed PR starts clean.
   */
  async markProcessing(crId: number): Promise<void> {
    const current = await this.currentLabels(crId);
    await this.setLabels(crId, current, {
      remove: ["pending", "inReview", "readyToMerge", "failed"],
      add: ["processing"],
    });
  }

  /**
   * Mark PR as in-review — applied changes, review cycle open. The
   * pr-feedback selector will re-enter this PR on fresh feedback.
   * `failed` is removed when a previously-failed PR succeeds on retry.
   */
  async markInReview(crId: number): Promise<void> {
    const current = await this.currentLabels(crId);
    await this.setLabels(crId, current, {
      remove: ["processing", "readyToMerge", "failed"],
      add: ["inReview"],
    });
    await this.vcs.updateCodeReview(crId, { draft: false }).catch(() => {});
  }

  /**
   * Mark PR as ready-to-merge — AI verified without further changes.
   * Excluded from pr-feedback scan so the PR sits here until the human
   * merges. `failed` is removed if a previously-failed PR reached
   * verified state on retry.
   */
  async markReadyToMerge(crId: number): Promise<void> {
    const current = await this.currentLabels(crId);
    await this.setLabels(crId, current, {
      remove: ["processing", "inReview", "failed"],
      add: ["readyToMerge"],
    });
    await this.vcs.updateCodeReview(crId, { draft: false }).catch(() => {});
  }

  /**
   * Mark PR as failed — sweeps every transient lifecycle label
   * (`pending`/`processing`/`inReview`/`readyToMerge`) before adding
   * `failed`. `failed` is terminal, so any surviving transient label
   * would be a contradictory state.
   */
  async markFailed(crId: number): Promise<void> {
    const current = await this.currentLabels(crId);
    await this.setLabels(crId, current, {
      remove: ["processing", "pending", "inReview", "readyToMerge"],
      add: ["failed"],
    });
  }

  /**
   * Mark PR as cancelled (task no longer needed) and close it. Terminal
   * disposition — no retry, work item is dropped.
   */
  async markCancelled(crId: number): Promise<void> {
    const current = await this.currentLabels(crId);
    await this.setLabels(crId, current, {
      remove: ["processing", "pending", "inReview", "readyToMerge"],
      add: ["cancelled"],
    });
    await this.vcs.closeCodeReview(crId).catch(() => {});
  }

  /**
   * Mark PR as rejected (task scope wrong) and close it. Terminal
   * disposition — future retrospective will generate a replacement task.
   */
  async markRejected(crId: number): Promise<void> {
    const current = await this.currentLabels(crId);
    await this.setLabels(crId, current, {
      remove: ["processing", "pending", "inReview", "readyToMerge"],
      add: ["rejected"],
    });
    await this.vcs.closeCodeReview(crId).catch(() => {});
  }

  /** Close PR and remove active labels. */
  async closeAndClean(crId: number): Promise<void> {
    await this.vcs.closeCodeReview(crId).catch(() => {});
    const current = await this.currentLabels(crId);
    await this.setLabels(crId, current, { remove: ["processing", "pending"], add: [] });
  }

  /**
   * Post a bot comment with the legacy `commentMarker` header and an
   * optional structured-attribution footer.
   *
   * Why two markers:
   *   - The legacy `commentMarker` (e.g. `<!-- bot:operator -->`) is the
   *     historical "this is a bot reply" sentinel — kept as-is so all
   *     existing bot/user-classification logic in selectors keeps
   *     working without conditionals.
   *   - The footer (when `attribution` is supplied) is the structured
   *     decision snapshot — comment ids responded to, head SHA seen,
   *     CI retry counter. {@link parseLatestBotFooter} reads it back so
   *     the next cycle's selector knows exactly what's already been
   *     handled. PRs with bot replies pre-dating the footer migrate by
   *     simply re-running once — first new reply writes a real footer.
   */
  async postBotComment(
    crId: number,
    body: string,
    attribution?: BotAttribution,
  ): Promise<void> {
    const footer = attribution ? formatFooter(attribution) : "";
    const trailer = footer ? `\n\n${footer}` : "";
    await this.vcs.postComment(
      crId,
      `${this.conventions.commentMarker}\n\n${body}${trailer}`,
    );
  }

  /**
   * Reply inside a review thread, carrying the legacy `commentMarker` so the
   * bot's own reply is never re-classified as fresh feedback by the selector
   * (which excludes any comment containing the marker). The visible note is
   * the per-comment disposition (fixed / not-applicable). No-op when the
   * platform exposes no review-thread reply support.
   */
  async postThreadReply(threadId: string, body: string): Promise<void> {
    if (!this.vcs.replyToReviewThread) return;
    await this.vcs.replyToReviewThread({
      threadId,
      body: `${this.conventions.commentMarker}\n\n${body}`,
    });
  }

  /**
   * Mark a review thread resolved. Applied only to bot-authored threads by
   * the caller once the disposition note is posted. No-op when the platform
   * exposes no thread-resolution support.
   */
  async resolveThread(threadId: string): Promise<void> {
    if (!this.vcs.resolveReviewThread) return;
    await this.vcs.resolveReviewThread(threadId);
  }

  /** Find open PR for a branch. Returns null if not found. */
  async findOpenPR(branch: string): Promise<CodeReview | null> {
    const prs = await this.vcs.getCodeReviews();
    return prs.find((pr) => pr.branch === branch && !pr.closed) || null;
  }

  /** Find all open AI PRs. */
  async findOpenAIPRs(): Promise<CodeReview[]> {
    const prs = await this.vcs.getCodeReviews();
    return prs.filter((pr) =>
      pr.branch.startsWith(`${this.conventions.branches.aiPrefix}/`) && !pr.closed,
    );
  }

  /**
   * Load and substitute a PR body template. Templates live in `kv:templates/*`
   * after the Step 15 seed refactor; `templatesDir` is retained for backwards
   * compatibility with stage-logic call sites that still pass it positionally,
   * but it is no longer read from disk. When the KV row is missing, this call
   * throws — stages that want an inline fallback (`research`, `retrospective`)
   * already chain `.catch()` on this method.
   */
  async loadTemplate(
    _templatesDir: string,
    templateName: string,
    vars: Record<string, string>,
  ): Promise<string> {
    if (!this.templates) {
      throw new Error(`PRManager: TemplateSource not configured; cannot load ${templateName}`);
    }
    return this.templates.load(templateName, vars);
  }

  // ── Internal ─────────────────────────────────────────────────────

  /** Fetch current label names on a PR (single API call). */
  private async currentLabels(crId: number): Promise<Set<string>> {
    const labels = await this.vcs.getLabels(crId);
    return new Set(labels.map((l) => l.name));
  }

  /** Apply label changes, skipping no-op adds/removes. */
  private async setLabels(
    crId: number,
    current: Set<string>,
    ops: { remove: string[]; add: string[] },
  ): Promise<void> {
    for (const key of ops.remove) {
      const label = this.resolveLabel(key);
      if (current.has(label)) {
        await this.vcs.removeLabel(crId, label).catch(() => {});
      }
    }
    for (const key of ops.add) {
      const label = this.resolveLabel(key);
      if (!current.has(label)) {
        await this.vcs.addLabel(crId, label).catch(() => {});
      }
    }
  }

  private resolveLabel(key: string): string {
    switch (key) {
      case "pending": return this.conventions.labels.pending;
      case "processing": return this.conventions.labels.processing;
      case "inReview": return this.conventions.labels.inReview;
      case "readyToMerge": return this.conventions.labels.readyToMerge;
      case "failed": return this.conventions.labels.failed;
      case "manual": return this.conventions.labels.manual || "ai:manual";
      case "cancelled": return this.conventions.labels.cancelled || "ai:cancelled";
      case "rejected": return this.conventions.labels.rejected || "ai:rejected";
      default: return key;
    }
  }
}
