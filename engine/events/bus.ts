import type { EventBus, EventHandler, EventPayload } from "@operator/core";

/**
 * In-memory event bus.
 *
 * Handlers are called in registration order. Handler results control flow:
 * - "continue" — call next handler
 * - "skip"     — stop processing remaining handlers for this event
 * - "abort"    — throw error (caller should catch and handle)
 * - "transform" — replace payload for subsequent handlers
 */
export class InMemoryEventBus implements EventBus {
  private readonly handlers = new Map<string, EventHandler[]>();

  on(event: string, handler: EventHandler): void {
    const list = this.handlers.get(event) ?? [];
    list.push(handler);
    this.handlers.set(event, list);
  }

  async emit(event: string, payload: EventPayload): Promise<void> {
    const list = this.handlers.get(event);
    if (!list || list.length === 0) return;

    let current = payload;
    for (const handler of list) {
      const result = await handler(current);
      switch (result.action) {
        case "continue":
          break;
        case "skip":
          return;
        case "abort":
          throw new Error(`Event "${event}" aborted: ${result.reason}`);
        case "transform":
          current = result.payload;
          break;
      }
    }
  }
}
