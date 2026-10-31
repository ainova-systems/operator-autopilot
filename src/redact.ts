/**
 * A copy of a stored value without its `token` fields, at any depth. Lock, lease and slot tokens let
 * their holder renew or end what they hold; they stay inside the runtime, so every command that
 * prints state, a job or a claim reads through this.
 */
export function redactTokens<T>(value: T): T {
  if (Array.isArray(value)) return value.map((item: unknown) => redactTokens(item)) as T;
  if (typeof value !== 'object' || value === null) return value;
  const copy: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(value)) {
    if (key !== 'token') copy[key] = redactTokens(field);
  }
  return copy as T;
}
