/**
 * Abstraction over where agent prompts come from.
 *
 * Rationale: prompt text lives in the operator repo today (files under
 * `agents/`), in per-repo extension files tomorrow (`.operator/`), and in
 * a DB or external service eventually (multi-tenant scenarios where
 * customer-managed prompts stay hidden from developers). Callers should
 * never read prompt files directly — they should depend on this interface
 * and receive concrete implementations via the composition root.
 *
 * The key concept is **layering**: a topic typically has a shipped base
 * layer (authoritative, defined by the operator) and optional user
 * extensions (appended, not replacing). Implementations return the
 * concatenation of all layers for a topic, separator included.
 *
 * Layers are **always appended**, never replaced. A user extension file
 * cannot silently override the shipped base — it can only add context to
 * it. This matches real user behavior: customizations are usually weaker
 * than the built-in prompt, and letting them fully replace the base leads
 * to accidental regressions.
 */
export interface PromptSource {
  /**
   * Load the full layered prompt for a topic.
   *
   * Topic keys use a `category/name` convention:
   * - `verifier/finding` → verifier criteria for finding stage
   * - `verifier/pr-review` → verifier criteria for comment review stage
   *
   * @param topic — category/name key identifying the prompt
   * @returns concatenated chain (system base + user extensions), or empty
   *          string when neither layer exists. Empty result is valid —
   *          callers should have their own generic fallback if needed.
   */
  loadChain(topic: string): Promise<string>;
}
