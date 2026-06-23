import type { OperationContext } from "@operator/core";
import type { VCSPlatform } from "@operator/core";
import type { NotificationChannel, NotificationMessage, InboundCommand } from "@operator/core";
import { parseCommand } from "../command-parser.js";

/**
 * GitHub notification channel.
 * Outbound: posts comments on PRs/issues via VCSPlatform.
 * Inbound: polls PR comments for commands (already handled by review pipeline,
 *          this provides explicit command extraction for engine dispatch).
 */
export class GitHubChannel implements NotificationChannel {
  readonly id = "github";

  constructor(
    private readonly vcs: VCSPlatform,
    private readonly commentMarker: string,
  ) {}

  async send(message: NotificationMessage, _ctx?: OperationContext): Promise<void> {
    // GitHub channel needs a codeReviewId to post to
    const crId = message.metadata?.codeReviewId as number | undefined;
    if (!crId) return;

    const body = `${this.commentMarker}\n\n**${message.title}**\n\n${message.body}`;
    await this.vcs.postComment(crId, body);
  }

  /**
   * Extract commands from PR comments.
   * Used by engine to detect /pause, /resume, /cancel etc.
   */
  async extractCommandsFromPR(
    codeReviewId: number,
    afterTs?: string,
  ): Promise<InboundCommand[]> {
    const comments = await this.vcs.getComments(codeReviewId);
    const commands: InboundCommand[] = [];

    for (const comment of comments) {
      // Skip bot comments
      if (comment.body.includes(this.commentMarker)) continue;
      // Skip old comments
      if (afterTs && comment.createdAt <= afterTs) continue;

      const parsed = parseCommand(comment.body);
      if (parsed) {
        commands.push({
          source: "github",
          sender: comment.author,
          command: parsed.command,
          args: parsed.args,
        });
      }
    }

    return commands;
  }
}
