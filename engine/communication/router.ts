import type { OperationContext } from "@operator/core";
import type { EventBus, EventPayload } from "@operator/core";
import type { NotificationChannel, NotificationMessage } from "@operator/core";

/**
 * Notification router — dispatches events to registered channels.
 *
 * Subscribes to EventBus events and routes notifications to appropriate channels
 * based on event type filters.
 */
export class NotificationRouter {
  private readonly routes: Array<{
    channel: NotificationChannel;
    events: Set<string> | null; // null = all events
  }> = [];

  constructor(private readonly bus: EventBus) {}

  /**
   * Register a channel to receive notifications for specific events.
   * Pass null for events to receive all events.
   */
  register(channel: NotificationChannel, events?: string[]): void {
    this.routes.push({
      channel,
      events: events ? new Set(events) : null,
    });
  }

  /**
   * Start listening on the event bus.
   * Subscribes to all events and dispatches to matching channels.
   */
  subscribe(eventTypes: string[]): void {
    for (const eventType of eventTypes) {
      this.bus.on(eventType, async (payload) => {
        await this.dispatch(eventType, payload);
        return { action: "continue" };
      });
    }
  }

  /**
   * Dispatch a notification to all matching channels.
   */
  async dispatch(event: string, payload: EventPayload, ctx?: OperationContext): Promise<number> {
    const message: NotificationMessage = {
      event,
      projectId: payload.projectId,
      title: formatTitle(event),
      body: formatBody(event, payload),
      severity: inferSeverity(event),
      metadata: payload.data,
    };

    let sent = 0;
    for (const route of this.routes) {
      if (route.events && !route.events.has(event)) continue;
      try {
        await route.channel.send(message, ctx!);

        sent++;
      } catch {
        // Channel failure is non-fatal — don't break other channels
      }
    }
    return sent;
  }
}

function formatTitle(event: string): string {
  return event.replace(/\./g, " ").replace(/^\w/, (c) => c.toUpperCase());
}

function formatBody(event: string, payload: EventPayload): string {
  const parts = [`**Event**: ${event}`, `**Project**: ${payload.projectId}`];
  if (payload.data) {
    for (const [key, value] of Object.entries(payload.data)) {
      parts.push(`**${key}**: ${String(value)}`);
    }
  }
  return parts.join("\n");
}

function inferSeverity(event: string): "info" | "warning" | "error" {
  if (event.includes("failed") || event.includes("broken")) return "error";
  if (event.includes("degraded") || event.includes("warning")) return "warning";
  return "info";
}
