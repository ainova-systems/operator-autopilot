/**
 * Base error for all Operator errors.
 * Every error carries a machine-readable `code` string for programmatic handling.
 */
export class OperatorError extends Error {
  constructor(
    readonly code: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "OperatorError";
  }
}

/**
 * Failure phase for categorized agent errors.
 *
 * - `llm` / `verify` / `review` — non-terminal phases that ran out of retries.
 *   Caller should mark the work item as `failed` and keep the PR open.
 * - `terminal-failed` — verifier decided the agent cannot complete the task
 *   (technical blocker, missing info). Mark failed, keep PR open for manual
 *   intervention.
 * - `terminal-cancelled` — verifier decided the task is no longer needed
 *   (already done, invalid premise). Mark cancelled, close PR, no retry.
 * - `terminal-rejected` — verifier decided the task scope is wrong and should
 *   be re-created differently. Mark rejected, close PR, future retrospective
 *   will generate a replacement task.
 */
export type AgentFailurePhase =
  | "llm"
  | "verify"
  | "review"
  | "terminal-failed"
  | "terminal-cancelled"
  | "terminal-rejected";

/** Errors during agent CLI execution (spawn failures, timeouts, bad output). */
export class AgentError extends OperatorError {
  /** Which phase caused the final failure. */
  readonly phase?: AgentFailurePhase;
  /** Optional human-readable reason, shown in PR comments and logs. */
  readonly reason?: string;

  constructor(
    code: string,
    message: string,
    options?: ErrorOptions & { phase?: AgentFailurePhase; reason?: string },
  ) {
    super(code, message, options);
    this.name = "AgentError";
    this.phase = options?.phase;
    this.reason = options?.reason;
  }
}

/** Errors loading or validating configuration (YAML parse, Zod validation, missing files). */
export class ConfigError extends OperatorError {
  constructor(
    code: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(code, message, options);
    this.name = "ConfigError";
  }
}

/** Errors from VCS/tracker platform API calls (auth, rate limits, network). */
export class PlatformError extends OperatorError {
  constructor(
    code: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(code, message, options);
    this.name = "PlatformError";
  }
}

/**
 * Extract a human-readable message from an unknown caught value.
 * Used in diagnostic logging to safely stringify errors.
 */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Errors from git workspace operations (clone, fetch, checkout failures). */
export class WorkspaceError extends OperatorError {
  constructor(
    code: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(code, message, options);
    this.name = "WorkspaceError";
  }
}

/**
 * Errors raised by `WorkItemSource` implementations.
 *
 * Standard codes:
 *   - `WI_NOT_FOUND`           — read/updateStatus/updateBody on a
 *                                ref that does not resolve.
 *   - `WI_INVALID_FRONTMATTER` — file-backed source could not parse
 *                                an existing item's YAML frontmatter.
 *   - `WI_DUPLICATE`           — create() found an existing record
 *                                with a different content hash for the
 *                                same id.
 *   - `WI_KIND_UNKNOWN`        — kind not registered in the registry.
 */
export class WorkItemSourceError extends OperatorError {
  constructor(
    code: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(code, message, options);
    this.name = "WorkItemSourceError";
  }
}
