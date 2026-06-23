import type { OperationContext } from "@operator/core";
import type { NotificationChannel, NotificationMessage, InboundCommand } from "@operator/core";
import { parseCommand } from "../command-parser.js";

/**
 * Telegram Bot API channel configuration.
 */
export interface TelegramConfig {
  /** Bot token from @BotFather */
  readonly botToken: string;
  /**
   * Allowed chat IDs — REQUIRED, cannot be empty.
   * Only messages from these chats are processed (security).
   * Supports user IDs, group IDs, and channel IDs.
   */
  readonly allowedChatIds: readonly number[];
  /**
   * Webhook URL — optional. When set, Telegram pushes updates to this URL.
   * When absent, uses getUpdates long-polling (default).
   */
  readonly webhookUrl?: string;
  /** Base API URL — override for testing (default: https://api.telegram.org) */
  readonly apiBaseUrl?: string;
}

interface TelegramUpdate {
  readonly update_id: number;
  readonly message?: {
    readonly chat: { readonly id: number };
    readonly from?: { readonly id: number; readonly username?: string };
    readonly text?: string;
  };
}

/**
 * Telegram notification channel.
 *
 * Security: rejects ALL messages from chat IDs not in allowedChatIds.
 * This is enforced at construction (must be non-empty) and at receive time.
 *
 * Outbound: sendMessage via Bot API (no server needed).
 * Inbound: getUpdates long-polling (default) OR webhook (optional config).
 */
export class TelegramChannel implements NotificationChannel {
  readonly id = "telegram";
  private lastUpdateId = 0;
  private readonly apiBase: string;
  private readonly allowedSet: ReadonlySet<number>;

  constructor(
    private readonly config: TelegramConfig,
    private readonly fetchFn: typeof fetch = globalThis.fetch,
  ) {
    if (config.allowedChatIds.length === 0) {
      throw new Error("TelegramChannel: allowedChatIds must not be empty (security requirement)");
    }
    this.apiBase = config.apiBaseUrl ?? "https://api.telegram.org";
    this.allowedSet = new Set(config.allowedChatIds);
  }

  /**
   * Send notification to all allowed chats.
   */
  async send(message: NotificationMessage, _ctx?: OperationContext): Promise<void> {
    const text = formatTelegramMessage(message);
    for (const chatId of this.config.allowedChatIds) {
      await this.callApi("sendMessage", { chat_id: chatId, text, parse_mode: "Markdown" });
    }
  }

  /**
   * Poll for inbound commands via getUpdates (long-polling).
   * Only processes messages from allowed chat IDs.
   * Returns commands parsed from new messages.
   */
  async poll(): Promise<InboundCommand[]> {
    const updates = await this.getUpdates();
    const commands: InboundCommand[] = [];

    for (const update of updates) {
      if (!update.message?.text) continue;

      const chatId = update.message.chat.id;
      if (!this.allowedSet.has(chatId)) continue; // Security: reject unknown chats

      const parsed = parseCommand(update.message.text);
      if (parsed) {
        commands.push({
          source: "telegram",
          sender: update.message.from?.username || String(update.message.from?.id || "unknown"),
          command: parsed.command,
          args: parsed.args,
        });
      }
    }

    return commands;
  }

  /**
   * Process webhook payload (called by external HTTP handler when webhookUrl is configured).
   * Validates chat ID before processing.
   */
  processWebhookUpdate(update: TelegramUpdate): InboundCommand | null {
    if (!update.message?.text) return null;

    const chatId = update.message.chat.id;
    if (!this.allowedSet.has(chatId)) return null; // Security: reject unknown chats

    const parsed = parseCommand(update.message.text);
    if (!parsed) return null;

    return {
      source: "telegram",
      sender: update.message.from?.username || String(update.message.from?.id || "unknown"),
      command: parsed.command,
      args: parsed.args,
    };
  }

  /**
   * Register webhook with Telegram API (call once during setup).
   */
  async setupWebhook(url: string): Promise<void> {
    await this.callApi("setWebhook", { url });
  }

  /**
   * Remove webhook (switch back to polling mode).
   */
  async removeWebhook(): Promise<void> {
    await this.callApi("deleteWebhook", {});
  }

  // ── Private ────────────────────────────────────────────────────────

  private async getUpdates(): Promise<TelegramUpdate[]> {
    const params: Record<string, unknown> = { timeout: 30 };
    if (this.lastUpdateId > 0) {
      params.offset = this.lastUpdateId + 1;
    }

    const response = await this.callApi("getUpdates", params);
    const updates = (response as { result?: TelegramUpdate[] })?.result ?? [];

    if (updates.length > 0) {
      this.lastUpdateId = updates[updates.length - 1].update_id;
    }

    return updates;
  }

  private async callApi(method: string, body: Record<string, unknown>): Promise<unknown> {
    const url = `${this.apiBase}/bot${this.config.botToken}/${method}`;
    const response = await this.fetchFn(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      throw new Error(`Telegram API ${method} failed: ${response.status}`);
    }

    return response.json();
  }
}

function formatTelegramMessage(message: NotificationMessage): string {
  const icon = message.severity === "error" ? "🔴"
    : message.severity === "warning" ? "🟡"
    : "🟢";

  return `${icon} *${message.title}*\n\n${message.body}\n\n_Project: ${message.projectId}_`;
}
