/** A failure the runtime reports by name. `code` is stable; `message` is for people. */
export class OperatorError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'OperatorError';
    this.code = code;
  }
}
