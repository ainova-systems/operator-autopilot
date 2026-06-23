export interface EventPayload {
  readonly traceId: string;
  readonly projectId: string;
  readonly data?: Record<string, unknown>;
}

export type EventHandlerResult =
  | { readonly action: "continue" }
  | { readonly action: "skip"; readonly reason?: string }
  | { readonly action: "abort"; readonly reason: string }
  | { readonly action: "transform"; readonly payload: EventPayload };

export type EventHandler = (payload: EventPayload) => Promise<EventHandlerResult> | EventHandlerResult;

export interface EventBus {
  emit(event: string, payload: EventPayload): Promise<void>;
  on(event: string, handler: EventHandler): void;
}
