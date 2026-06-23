import type { OperationContext } from "./context.js";

export interface NotificationMessage {
  readonly event: string;
  readonly projectId: string;
  readonly title: string;
  readonly body: string;
  readonly severity: "info" | "warning" | "error";
  readonly metadata?: Record<string, unknown>;
}

export interface InboundCommand {
  readonly source: string;
  readonly sender: string;
  readonly command: string;
  readonly args: string[];
}

export interface NotificationChannel {
  readonly id: string;
  send(message: NotificationMessage, ctx: OperationContext): Promise<void>;
  receive?(): AsyncIterable<InboundCommand>;
}
