import type { Telemetry } from "@operator/core";

/**
 * NoOp telemetry for testing — silently discards all metrics.
 */
export class NoOpTelemetry implements Telemetry {
  readonly messages: { level: string; message: string; metadata?: Record<string, unknown> }[] = [];

  info(message: string, metadata?: Record<string, unknown>): void {
    this.messages.push({ level: "info", message, metadata });
  }

  warn(message: string, metadata?: Record<string, unknown>): void {
    this.messages.push({ level: "warn", message, metadata });
  }

  error(message: string, metadata?: Record<string, unknown>): void {
    this.messages.push({ level: "error", message, metadata });
  }
}
