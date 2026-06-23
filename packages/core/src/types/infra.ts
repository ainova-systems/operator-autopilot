export interface JobQueue {
  enqueue<TPayload>(name: string, payload: TPayload): Promise<string>;
  dequeue<TPayload>(name: string): Promise<{ id: string; payload: TPayload } | null>;
}

export interface Telemetry {
  info(message: string, metadata?: Record<string, unknown>): void;
  warn(message: string, metadata?: Record<string, unknown>): void;
  error(message: string, metadata?: Record<string, unknown>): void;
}
