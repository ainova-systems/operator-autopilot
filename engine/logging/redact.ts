/**
 * Token and secret redaction for log output.
 *
 * Matches common token patterns and replaces them with a safe placeholder.
 * Used by the logger to sanitize structured log fields before writing.
 */

// Each prefix pattern uses a negative lookbehind on identifier
// characters so legitimate slugs that contain the prefix as a
// substring — e.g. `task-execute-run-1777282...` produces the
// substring `sk-execute-run-1777282...` — do not get falsely redacted.
const TOKEN_PATTERNS: readonly RegExp[] = [
  // GitHub tokens (PAT, app installation, fine-grained)
  /(?<![A-Za-z0-9_])ghp_[A-Za-z0-9_]{30,}/g,
  /(?<![A-Za-z0-9_])ghs_[A-Za-z0-9_]{30,}/g,
  /(?<![A-Za-z0-9_])github_pat_[A-Za-z0-9_]{30,}/g,
  // Anthropic API keys
  /(?<![A-Za-z0-9_])sk-ant-[A-Za-z0-9_-]{20,}/g,
  // Cloud-provider keys
  /(?<![A-Za-z0-9_])af_[A-Za-z0-9_-]{20,}/g,
  // OpenRouter / OpenAI keys
  /(?<![A-Za-z0-9_])sk-[A-Za-z0-9_-]{20,}/g,
  // Bearer tokens in headers
  /Bearer\s+[A-Za-z0-9_.\-/+=]{20,}/gi,
  // Generic long token-shaped values keyed by `token=`, `key:`, etc.
  /(?:token|key|secret|password|authorization)[=: ]["']?[A-Za-z0-9_.\-/+=]{20,}["']?/gi,
];

const REDACTED = "[REDACTED]";

/**
 * Redact known token/secret patterns from a string.
 */
export function redactString(input: string): string {
  let result = input;
  for (const pattern of TOKEN_PATTERNS) {
    // Reset lastIndex for global regexps
    pattern.lastIndex = 0;
    result = result.replace(pattern, REDACTED);
  }
  return result;
}

function redactError(error: Error): Record<string, unknown> {
  const result: Record<string, unknown> = {
    name: error.name,
    message: redactString(error.message),
  };
  if (error.stack) {
    result["stack"] = redactString(error.stack);
  }
  if (error.cause !== undefined) {
    result["cause"] = redactValue(error.cause);
  }
  for (const [k, v] of Object.entries(error)) {
    if (!(k in result)) {
      result[k] = redactValue(v);
    }
  }
  return result;
}

function redactSpecialObject(value: object): unknown | undefined {
  if (value instanceof Error) {
    return redactError(value);
  }
  if (value instanceof Date) {
    return redactString(value.toISOString());
  }
  if (value instanceof URL) {
    return redactString(value.toString());
  }
  if (value instanceof Map) {
    const result: Record<string, unknown> = {};
    for (const [k, v] of value) {
      result[String(redactValue(k))] = redactValue(v);
    }
    return result;
  }
  if (value instanceof Set) {
    return [...value].map(redactValue);
  }
  const toJSON = (value as { toJSON?: () => unknown }).toJSON;
  if (typeof toJSON === "function") {
    return redactValue(toJSON.call(value));
  }
  return undefined;
}

/**
 * Recursively redact secrets from an object/value for safe logging.
 *
 * - Strings: redact token patterns inline.
 * - Objects/arrays: recurse into values.
 * - Primitives: return as-is.
 * - Error/Date/URL/Map/Set/toJSON: preserve diagnostic shape before redacting fields.
 */
export function redactValue(value: unknown): unknown {
  if (typeof value === "string") {
    return redactString(value);
  }
  if (Array.isArray(value)) {
    return value.map(redactValue);
  }
  if (value !== null && typeof value === "object") {
    const special = redactSpecialObject(value);
    if (special !== undefined) {
      return special;
    }
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      result[k] = redactValue(v);
    }
    return result;
  }
  return value;
}
