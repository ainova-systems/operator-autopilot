import type { FormatType, ParsedOutput } from "./output-parser.js";
import { stripCodeFences, stripPreamble, parseAgentOutput } from "./output-parser.js";
import type { Logger } from "../logging/logger.js";
import type { TemplateSource } from "./kv-template-source.js";

// ── Types ────────────────────────────────────────────────────────────

export interface FormatterConfig {
  /**
   * KV-backed template loader for format snippets keyed `formats/{type}.txt`.
   * Required when `apiKey` is set; ignored otherwise (structural cleanup only).
   */
  readonly templates?: TemplateSource;
  /** OpenRouter (or compatible) API key. When absent, LLM reformat is skipped. */
  readonly apiKey?: string;
  /** API base URL (default: https://openrouter.ai/api/v1). */
  readonly apiBaseUrl?: string;
  /** Model for formatting (default: openai/gpt-4o-mini). */
  readonly model?: string;
  /** Content language substituted into templates (default: English). */
  readonly language?: string;
  /** Request timeout in ms (default: 30000). */
  readonly timeoutMs?: number;
}

export interface FormatResult {
  readonly content: string;
  readonly parsed: ParsedOutput;
  /** Whether the LLM reformat API was used. */
  readonly llmReformatted: boolean;
}

// ── Constants ────────────────────────────────────────────────────────

const DEFAULT_API_BASE = "https://openrouter.ai/api/v1";
const DEFAULT_MODEL = "openai/gpt-4o-mini";
const DEFAULT_LANGUAGE = "English";
const DEFAULT_TIMEOUT_MS = 30_000;

// ── Public API ───────────────────────────────────────────────────────

/**
 * Format and validate raw agent output.
 *
 * Two-level defense:
 *  1. Always: stripCodeFences → stripPreamble → parseAgentOutput (validate).
 *  2. If apiKey is configured: send through cheap LLM for reformatting, then validate.
 *
 * If LLM reformat fails, falls back to level 1.
 * Throws if the output cannot pass validation at either level.
 */
export async function formatAgentOutput(
  raw: string,
  format: FormatType,
  config: FormatterConfig,
  vars?: Record<string, string>,
  log?: Logger,
): Promise<FormatResult> {
  // Level 1: structural cleanup + validation
  const cleaned = stripPreamble(stripCodeFences(raw.trim()));

  if (!config.apiKey) {
    log?.debug("No API key for formatter — using structural cleanup only");
    const parsed = parseAgentOutput(cleaned, format);
    return { content: parsed.raw, parsed, llmReformatted: false };
  }

  // Level 2: LLM reformat
  try {
    if (!config.templates) {
      throw new Error("LLM reformat requires a TemplateSource");
    }
    const template = await config.templates.load(`formats/${format}.txt`);
    const systemPrompt = substituteVars(template, config.language, vars);
    const reformatted = await callReformatAPI(raw, systemPrompt, config);
    const stripped = stripPreamble(stripCodeFences(reformatted.trim()));
    const parsed = parseAgentOutput(stripped, format);
    log?.info(`Formatted ${format} output via LLM reformat`);
    return { content: parsed.raw, parsed, llmReformatted: true };
  } catch (err) {
    log?.warn(`LLM reformat failed for ${format}, falling back to structural cleanup: ${err instanceof Error ? err.message : String(err)}`);
    const parsed = parseAgentOutput(cleaned, format);
    return { content: parsed.raw, parsed, llmReformatted: false };
  }
}

// ── Variable substitution ────────────────────────────────────────────

/**
 * Substitute {LANGUAGE} and custom {KEY} placeholders in template.
 * Ports format-content.sh variable substitution.
 */
export function substituteVars(
  template: string,
  language?: string,
  vars?: Record<string, string>,
): string {
  let result = template.replaceAll("{LANGUAGE}", language ?? DEFAULT_LANGUAGE);
  if (vars) {
    for (const [key, value] of Object.entries(vars)) {
      result = result.replaceAll(`{${key}}`, value);
    }
  }
  return result;
}

// ── API call ─────────────────────────────────────────────────────────

interface ChatCompletionResponse {
  readonly choices?: ReadonlyArray<{
    readonly message?: { readonly content?: string };
  }>;
  readonly error?: { readonly message?: string };
}

/**
 * Call OpenRouter-compatible chat completions API for reformatting.
 * Ports format-content.sh curl call.
 */
export async function callReformatAPI(
  rawContent: string,
  systemPrompt: string,
  config: FormatterConfig,
): Promise<string> {
  const baseUrl = config.apiBaseUrl ?? DEFAULT_API_BASE;
  const model = config.model ?? DEFAULT_MODEL;
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const payload = {
    model,
    temperature: 0.1,
    max_tokens: 4096,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: rawContent },
    ],
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`API returned ${response.status}: ${response.statusText}`);
    }

    const data = (await response.json()) as ChatCompletionResponse;

    if (data.error?.message) {
      throw new Error(`API error: ${data.error.message}`);
    }

    const content = data.choices?.[0]?.message?.content;
    if (!content) {
      throw new Error("Empty response from formatter API");
    }

    return content;
  } finally {
    clearTimeout(timer);
  }
}
