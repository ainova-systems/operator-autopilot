import { OperatorError } from "@operator/core";

/**
 * Typed error for the stage-logic layer. Every stage hook that throws at the
 * orchestrator boundary raises `StageLogicError` with a stable `code` string
 * so callers can branch on the reason without string-matching the message.
 *
 * Replaces the `throw new Error(...)` pattern that existed across
 * finding-plan / task-execute / pr-review / research / retrospective before
 * Step 17. All codes are enumerated in {@link StageLogicErrorCode} so a
 * typo does not silently introduce a new untyped string.
 */
export class StageLogicError extends OperatorError {
  constructor(
    code: StageLogicErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(code, message, options);
    this.name = "StageLogicError";
  }
}

/**
 * Known stage-logic error codes. Each code names a specific failure mode that
 * downstream observers (logs, UI, tests) can match on. Never add a code
 * without a concrete consumer.
 */
export type StageLogicErrorCode =
  /** A hook read the scratch store but found no entry — typically because
   *  `beforeAgent` never ran (stage wiring bug) or the scratch was cleared
   *  prematurely by an earlier hook. */
  | "STAGE_SCRATCH_MISSING"
  /** A hook received a `StageInput` whose `data` payload did not match the
   *  expected selector payload shape (e.g. pr-review got a non-pr-feedback
   *  payload, research got a missing `analyzers` array). */
  | "INVALID_STAGE_INPUT"
  /** The workspace git HEAD moved between a pre-agent snapshot and the
   *  post-agent check — only raised by read-only agent contracts
   *  (finding-plan planner). */
  | "HEAD_CHANGED";
