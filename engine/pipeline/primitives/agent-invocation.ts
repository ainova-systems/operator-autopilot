import type { OperationContext } from "@operator/core";
import { AgentError, errorMessage } from "@operator/core";
import type { AgentRuntime, AgentRunInput } from "../../agents/runtime.js";
import type { Logger } from "../../logging/logger.js";
import type { Verdict, AgentResult, StageInput, StageDef } from "../types.js";

/**
 * Agent-invocation primitive — wraps `AgentRuntime.run` and translates its
 * return/throw shape into the pipeline's {@link AgentResult} (verdict +
 * summary + raw output).
 *
 * Retry boundary (`docs/architecture-v5.md §3.1.2`):
 *
 * - `AgentRuntime.run` owns the **entire retry loop** (CLI failure, verify
 *   failure, verifier `retry`). Budget = `AgentRunInput.maxRetries`.
 * - `AgentInvocation.invoke` does NOT add a retry layer on top. If the
 *   runtime exhausts its budget, it throws `AgentError`; this primitive
 *   translates that to `verdict: "failed"`.
 * - Terminal verifier verdicts (`failed`/`cancelled`/`rejected`) are thrown
 *   by the runtime as `AgentError` with `phase` in the cause — the
 *   primitive maps them to the matching {@link Verdict}.
 *
 * Step 8b scope: one method, one wrapper. No prompt building here (the
 * caller passes a ready {@link AgentRunInput}). Prompt construction stays
 * with the stage-specific call-site (entry.ts for now, moves into
 * `runStage` + a `prompt-resolver` primitive in later steps).
 */

/** Deps needed to run an agent and interpret the result. */
export interface AgentInvocationDeps {
  readonly agentRuntime: Pick<AgentRuntime, "run">;
  /**
   * Optional logger. When provided, invocation emits verdict extraction
   * outcomes at INFO/DEBUG levels (v5 observability mandate).
   */
  readonly log?: Logger;
}

/**
 * Contract for {@link FileAgentInvocation.invoke}. Takes a pre-built
 * `AgentRunInput` and returns a typed {@link AgentResult}.
 */
export interface AgentInvocation {
  invoke(
    stageDef: StageDef,
    input: StageInput,
    runInput: AgentRunInput,
    deps: AgentInvocationDeps,
    ctx: OperationContext,
  ): Promise<AgentResult>;
}

/** Single implementation of {@link AgentInvocation}. */
export class FileAgentInvocation implements AgentInvocation {
  async invoke(
    stageDef: StageDef,
    _input: StageInput,
    runInput: AgentRunInput,
    deps: AgentInvocationDeps,
    ctx: OperationContext,
  ): Promise<AgentResult> {
    if (ctx.signal.aborted) {
      throw new AgentError("ABORTED", "agent invocation aborted before start");
    }

    try {
      const result = await deps.agentRuntime.run(runInput, ctx);
      const summary = extractOrSynthesizeSummary(result.output, "approved", deps.log, stageDef.name);
      // v5 logging audit §14 — success path produces a verdict; log it with
      // the extracted summary snippet so operators can see what the verifier
      // approved without digging into the CLI stdout.
      deps.log?.info(`agent ${stageDef.agent} ✓ verdict=approved`, {
        stage: stageDef.name, agent: stageDef.agent,
        attempts: result.attempts, durationMs: result.durationMs,
        summaryChars: summary.length,
        summary: summary.slice(0, 200),
      });
      return {
        verdict: "approved",
        output: result.output,
        attempts: result.attempts,
        summary,
      };
    } catch (err) {
      const verdict = classifyError(err);
      if (!verdict) {
        // v5 logging audit §14 — infrastructure error (not a verdict). ERROR
        // with full cause chain; caller will rethrow up the cycle.
        deps.log?.error(`agent ${stageDef.agent} ✗ infrastructure failure (rethrowing)`, {
          stage: stageDef.name, agent: stageDef.agent,
          error: errorMessage(err),
          cause: err instanceof Error && err.cause ? String(err.cause) : undefined,
        });
        throw err;
      }
      // v5 logging audit §14 — verdict-terminal or retries-exhausted.
      // WARN (not ERROR) because the stage flow handles these as verdicts.
      deps.log?.warn(`agent ${stageDef.agent} ✗ verdict=${verdict}: ${errorMessage(err)}`, {
        stage: stageDef.name, agent: stageDef.agent,
        verdict, phase: err instanceof AgentError ? err.phase : undefined,
        reason: errorMessage(err),
      });
      return {
        verdict,
        output: "",
        attempts: runInput.maxRetries,
        summary: errorMessage(err),
      };
    }
  }
}

/**
 * Map an `AgentError`'s `phase` field to a pipeline verdict. Returns `null`
 * for errors that are not verdicts (e.g. `PROVIDER_NOT_FOUND`, infrastructure
 * crashes) — the caller re-throws those so the cycle reports them as real
 * failures, not agent verdicts.
 */
function classifyError(err: unknown): Verdict | null {
  if (!(err instanceof AgentError)) return null;
  switch (err.phase) {
    case "terminal-failed":
      return "failed";
    case "terminal-cancelled":
      return "cancelled";
    case "terminal-rejected":
      return "rejected";
    case "review":
    case "verify":
    case "llm":
      // Retries exhausted without a terminal verifier verdict — count as failed.
      return "failed";
    default:
      return null;
  }
}

/**
 * Extract the verifier's `## Execution Summary` block from agent stdout. Used
 * by Step 14 (status observation layer) to write KV execution entries. Keeps
 * a short snippet of the agent's own narrative as the human-readable summary.
 *
 * Returns the first non-empty section matching `## Execution Summary`, or an
 * empty string if the agent did not emit one.
 */
export function extractSummary(output: string): string {
  const startMatch = output.match(/^##\s+Execution Summary\s*$/m);
  if (!startMatch || startMatch.index === undefined) return "";
  const rest = output.slice(startMatch.index + startMatch[0].length);
  const endMatch = rest.match(/\n##\s+/);
  const body = endMatch && endMatch.index !== undefined ? rest.slice(0, endMatch.index) : rest;
  return body.trim();
}

/**
 * Extract the `## Verdict: X` value from agent stdout. Returns `null` when
 * no block is found. Used for fallback summary synthesis and future diagnostic
 * logging.
 */
export function extractVerdictMarker(output: string): string | null {
  const match = output.match(/^##\s+Verdict\s*:\s*([A-Za-z-]+)/m);
  return match ? match[1].toLowerCase() : null;
}

/**
 * Return the agent's explicit `## Execution Summary` when present, or — when
 * missing — synthesize a deterministic one-liner from the known verdict and a
 * trimmed first 500 chars of stdout. The block is optional: AOP-transport agents
 * (e.g. supervisor) carry their summary in `EMIT verdict summary:` instead.
 * Synthesis is a designed safety net so KV execution history always has a
 * narrative; the `[synthesized]` marker on the returned string is the visible
 * diagnostic. Emits DEBUG (not WARN) when synthesis runs.
 */
export function extractOrSynthesizeSummary(
  output: string,
  verdict: string,
  log: Logger | undefined,
  stageName?: string,
): string {
  const extracted = extractSummary(output);
  if (extracted) return extracted;
  const verdictMarker = extractVerdictMarker(output);
  const snippet = output.trim().slice(0, 500);
  const synth = verdictMarker
    ? `[synthesized] verdict=${verdictMarker}. ${snippet}`
    : `[synthesized] verdict=${verdict}. ${snippet}`;
  // v5 logging audit §14 — designed fallback path. DEBUG only: omitting the
  // block is legitimate for AOP agents whose summary lives in EMIT verdict.
  log?.debug(
    `agent output missing ## Execution Summary block — using synthesized fallback`,
    { stage: stageName, verdict, synthesizedLen: synth.length },
  );
  return synth.slice(0, 1000);
}
