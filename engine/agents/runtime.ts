import { writeFile, unlink } from "node:fs/promises";
import { execFile } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { AgentProvider } from "@operator/core";
import type { OperationContext } from "@operator/core";
import type { IdempotencyGuard, LockHandle } from "@operator/core";
import { AgentError, errorMessage } from "@operator/core";
import { buildSystemPrompt, buildUserPrompt } from "./prompt-builder.js";
import type { PromptContext } from "./prompt-builder.js";
import type { Logger } from "../logging/logger.js";

const MAX_REVIEW_DIFF_BYTES = 15_000;

/**
 * Ceiling on the agent lock TTL.
 *
 * The lock is held for the whole {@link AgentRuntime.run} call (across every
 * retry), so its natural budget is `timeoutMs × maxRetries` — up to 3h for
 * the creator (1h per-attempt timeout × 3 retries). That budget is correct
 * for worst-case concurrency safety, but it is ALSO the window a *leaked*
 * lock blocks the next run: `run()` releases the lock on every JS-level
 * outcome (success, agent error, abort), so the only way a lock survives a
 * finished run is a hard process kill (SIGKILL / OOM / power loss) that
 * bypasses the catch. After such a kill the holder is already dead, yet the
 * lock would refuse every new run of that agent on that repo for the full
 * multi-hour budget — exactly the stuck `agent:creator:sample` lock that
 * failed task-execute on 2026-06-04.
 *
 * Capping the TTL bounds that post-crash block to a safe period while still
 * covering the longest single legitimate attempt (the creator's 1h). This is
 * deliberately NOT an auto-sweep of active locks and the {@link AgentError}
 * `LOCK_FAILED` is NOT swallowed: a still-held lock must surface as a visible
 * "Failed to acquire lock" failure, never be silently cleared. Single-
 * instance only (the local SQLite guard); multi-instance deployments rely on
 * the distributed Shield guard instead.
 */
const MAX_AGENT_LOCK_TTL_MS = 60 * 60 * 1000; // 1 hour
// Max size of previous-attempt error context carried into the next retry's
// user prompt. Large .NET build logs or verbose verifier output would otherwise
// blow past ARG_MAX (~128 KB on Linux) when the CLI spawn passes the user
// prompt via `-p` argv, causing `spawn E2BIG`. 2 KB is enough for the tail
// where actual errors typically live.
const MAX_ERROR_CONTEXT_BYTES = 2_000;

// ── Types ───────────────────────────────────────────────────────────────

export interface AgentRunInput {
  readonly agentName: string;
  readonly providerId: string;
  readonly promptContext: PromptContext;
  readonly taskContent?: string;
  readonly model: string;
  readonly timeoutMs: number;
  readonly tools?: string[];
  readonly maxBudgetUsd?: number;
  readonly maxRetries: number;
  readonly verifyCommand?: string;
  readonly reviewEnabled: boolean;
  readonly verifierModel?: string;
  /** Stage-specific review criteria injected into verifier prompt. */
  readonly reviewCriteria?: string;
  /**
   * Working directory where the agent process runs and where `git diff`
   * for the review phase is collected. When the agent works inside a
   * subdirectory of a git repo (e.g. `.operator/` in the managed repo),
   * set {@link workspaceRoot} to the enclosing git repo so diff collection
   * sees the full change set rather than an empty sub-diff.
   */
  readonly cwd: string;
  /**
   * Git repository root for diff collection. Defaults to {@link cwd} when
   * not provided. Must point to the top of the managed repo checkout.
   */
  readonly workspaceRoot?: string;
  /**
   * Optional execution-history sink. When provided, the runtime emits a
   * structured event per attempt — `agent.attempt.spawned` (carries
   * full system + user prompts), `agent.attempt.cli` (carries full
   * stdout + exit code + duration), `agent.attempt.verify` (carries
   * full stderr when the verify step ran), and `agent.attempt.review`
   * (carries verifier feedback when not approved). This is the only
   * surface that exposes the agent's actual context to the App UI; it
   * lets failed runs show prompts and output inline so operators can
   * diagnose without rerunning.
   *
   * Typed inline (rather than imported from `pipeline/primitives`) to
   * keep the `agents/` layer free of an upward dependency.
   */
  readonly history?: AgentEventSink;
}

/**
 * Minimal sink the runtime needs to surface per-attempt detail. Mirrors
 * the relevant subset of `ExecutionHistory.event` so a stage that does
 * not care about events can pass `undefined` and the runtime stays a
 * no-op for them.
 */
export interface AgentEventSink {
  event(
    type: string,
    message: string,
    options: {
      level?: "info" | "warn" | "error";
      detail?: string;
      payload?: unknown;
    },
  ): Promise<void>;
}

export interface AgentRunResult {
  readonly output: string;
  readonly attempts: number;
  readonly durationMs: number;
}

/**
 * Structured disposition returned by the verifier agent. Non-terminal
 * `retry` loops the action agent with feedback; the four terminal verdicts
 * surface as typed {@link AgentError} throws that callers map to work item
 * status transitions.
 */
export type ReviewVerdict =
  | { readonly kind: "approved" }
  | { readonly kind: "retry"; readonly feedback: string }
  | { readonly kind: "failed"; readonly reason: string }
  | { readonly kind: "cancelled"; readonly reason: string }
  | { readonly kind: "rejected"; readonly reason: string };

// ── Runtime ─────────────────────────────────────────────────────────────

/**
 * Agent runtime orchestrator.
 *
 * Orchestrates: prompt building → CLI spawn → verify → review → retry.
 * Ports run-agent.sh main loop + run_verify + run_review.
 */
export class AgentRuntime {
  constructor(
    private readonly providers: Map<string, AgentProvider>,
    private readonly guard?: IdempotencyGuard,
    private readonly log?: Logger,
  ) {}

  async run(input: AgentRunInput, ctx: OperationContext): Promise<AgentRunResult> {
    const provider = this.providers.get(input.providerId);
    if (!provider) {
      throw new AgentError("PROVIDER_NOT_FOUND", `Unknown provider: ${input.providerId}`);
    }

    const lockKey = `agent:${input.agentName}:${ctx.repoId}`;
    let lock: LockHandle | null = null;
    if (this.guard) {
      const lockTtlMs = Math.min(input.timeoutMs * input.maxRetries, MAX_AGENT_LOCK_TTL_MS);
      this.log?.debug(`Acquiring lock: ${lockKey} (ttl=${Math.round(lockTtlMs / 1000)}s)`);
      lock = await this.guard.acquire(lockKey, lockTtlMs, ctx);
      if (!lock) throw new AgentError("LOCK_FAILED", "Failed to acquire lock");
      this.log?.debug(`Lock acquired: ${lockKey}`);
    }

    try {
      this.log?.info(`Invoking agent ${input.agentName} (provider: ${input.providerId}, model: ${input.model}, retries: ${input.maxRetries})`);
      const result = await this.executeWithRetry(input, provider, ctx);
      this.log?.info(`Agent ${input.agentName} completed in ${result.durationMs}ms (${result.attempts} attempt(s))`);
      // Release on success — agent locks prevent concurrency only.
      // Pipeline stages handle dedup via their own guard keys.
      if (lock) await this.guard!.release(lock, ctx);
      this.log?.debug(`Lock released: ${lockKey}`);
      return result;
    } catch (err) {
      this.log?.error(`Agent ${input.agentName} failed: ${errorMessage(err)}`);
      if (lock) {
        await this.guard!.release(lock, ctx);
        this.log?.debug(`Lock released (on failure): ${lockKey}`);
      }
      throw err;
    }
  }

  private async executeWithRetry(
    input: AgentRunInput,
    provider: AgentProvider,
    ctx: OperationContext,
  ): Promise<AgentRunResult> {
    // Build system prompt ONCE — cached for all retries (V1 behavioral spec)
    const systemPrompt = await buildSystemPrompt(input.promptContext);
    const systemFile = join(tmpdir(), `operator-prompt-${Date.now()}-${Math.random().toString(36).slice(2)}.md`);
    await writeFile(systemFile, systemPrompt, "utf-8");

    let errorContext = "";
    /**
     * Track per-attempt error fingerprints so the runtime can abort the
     * retry loop early when the agent fails with the same root cause
     * twice in a row. Burning a third opus run on a NuGet policy
     * vulnerability the agent already failed to fix once is wasted
     * budget — better to surface failure faster.
     */
    let priorErrorFingerprint: string | null = null;
    const startTime = Date.now();

    this.log?.debug(`System prompt built`, {
      agent: input.agentName,
      systemPromptChars: systemPrompt.length,
      systemPromptFile: systemFile,
      model: input.model,
      timeoutMs: input.timeoutMs,
      maxBudgetUsd: input.maxBudgetUsd,
      tools: input.tools?.join(","),
      maxRetries: input.maxRetries,
      reviewEnabled: input.reviewEnabled,
      verifyCommand: input.verifyCommand ? "yes" : "no",
    });

    try {
      for (let attempt = 1; attempt <= input.maxRetries; attempt++) {
        if (ctx.signal.aborted) throw new AgentError("ABORTED", "Aborted");
        // The actual error text lives in the previous attempt's
        // `agent.attempt.verify` / `agent.attempt.review` execution
        // event (full detail) and in the WARN line that emitted it,
        // so this log line stays terse — duplicating the body across
        // three sinks is what blew the log up to 18+ KB per retry.
        this.log?.info(`Attempt ${attempt}/${input.maxRetries} for ${input.agentName}${errorContext ? ` (retrying after prior failure)` : ""}`);

        const userPrompt = buildUserPrompt({
          taskContent: input.taskContent,
          attempt,
          maxRetries: input.maxRetries,
          previousError: errorContext || undefined,
          vars: input.promptContext.vars,
        });

        this.log?.debug(`User prompt built`, {
          agent: input.agentName,
          attempt,
          userPromptChars: userPrompt.length,
          taskContentChars: input.taskContent?.length ?? 0,
        });

        // 1. Execute CLI
        const cliStart = Date.now();
        this.log?.info(`Agent ${input.agentName} attempt ${attempt}/${input.maxRetries}: CLI spawned (model=${input.model}, timeout=${Math.round(input.timeoutMs / 1000)}s)`);
        // Surface the FULL prompt context for this attempt to the
        // execution-history sink so the App UI / KV inspect path can
        // show the actual question we asked the agent. No tail-cut.
        await input.history?.event(
          "agent.attempt.spawned", `Spawned ${input.providerId}/${input.model} (attempt ${attempt}/${input.maxRetries})`,
          {
            level: "info",
            detail: [
              `=== System prompt (${systemPrompt.length} chars) ===`,
              systemPrompt,
              "",
              `=== User prompt (${userPrompt.length} chars) ===`,
              userPrompt,
            ].join("\n"),
            payload: {
              attempt, providerId: input.providerId, model: input.model,
              tools: input.tools, cwd: input.cwd,
              systemPromptChars: systemPrompt.length,
              userPromptChars: userPrompt.length,
            },
          },
        );
        const result = await provider.execute(userPrompt, {
          model: input.model,
          timeoutMs: input.timeoutMs,
          tools: input.tools,
          maxBudgetUsd: input.maxBudgetUsd,
          systemPromptFile: systemFile,
          cwd: input.cwd,
        });
        const cliDurationMs = Date.now() - cliStart;
        this.log?.info(`Agent ${input.agentName} attempt ${attempt}/${input.maxRetries}: CLI returned exit=${result.exitCode} in ${Math.round(cliDurationMs / 1000)}s (output ${result.stdout.length} bytes)`);
        await input.history?.event(
          "agent.attempt.cli",
          `CLI exit=${result.exitCode} in ${cliDurationMs}ms (${result.stdout.length} bytes)`,
          {
            level: result.exitCode === 0 ? "info" : "warn",
            detail: result.stdout || "(empty stdout)",
            payload: {
              attempt, exitCode: result.exitCode, durationMs: cliDurationMs,
              stdoutChars: result.stdout.length,
            },
          },
        );

        if (result.exitCode !== 0) {
          const stdoutSample = result.stdout.trim().slice(0, 500);
          errorContext = stdoutSample
            ? `CLI exited with code ${result.exitCode}: ${stdoutSample}`
            : `CLI exited with code ${result.exitCode}`;
          this.log?.warn(
            `Agent ${input.agentName} CLI exit code ${result.exitCode}${stdoutSample ? `: ${stdoutSample}` : ""}`,
          );
          continue;
        }

        // 2. Verify (if configured)
        if (input.verifyCommand) {
          const verifyStart = Date.now();
          this.log?.info(`Running verify command for ${input.agentName}`);
          const verifyError = await runVerify(input.verifyCommand, input.cwd);
          const verifyMs = Date.now() - verifyStart;
          await input.history?.event(
            "agent.attempt.verify",
            verifyError
              ? `Verify ✗ failed in ${verifyMs}ms`
              : `Verify ✓ passed in ${verifyMs}ms`,
            {
              level: verifyError ? "warn" : "info",
              detail: verifyError ?? undefined,
              payload: {
                attempt, command: input.verifyCommand,
                durationMs: verifyMs, passed: !verifyError,
              },
            },
          );
          if (verifyError) {
            this.log?.warn(`Verify ✗ failed for ${input.agentName} in ${verifyMs}ms (see attempt ${attempt} event for full output)`);
            errorContext = `Build/lint failed:\n${truncateErrorContext(verifyError)}`;
            // Same-root-cause abort: if the agent fails verify with the
            // same fingerprint twice in a row, the third attempt is
            // very unlikely to produce a different outcome (project-
            // wide NuGet/policy issue, missing dependency, etc.).
            // Bail out early instead of burning another opus run.
            const fp = errorFingerprint(verifyError);
            if (priorErrorFingerprint != null && fp === priorErrorFingerprint && attempt < input.maxRetries) {
              this.log?.warn(`Verify failure repeats fingerprint ${fp.slice(0, 60)} — aborting retry loop early`, {
                agent: input.agentName, attempt, maxRetries: input.maxRetries, fingerprint: fp,
              });
              throw new AgentError(
                "VERIFY_REPEATED",
                `Agent ${input.agentName} hit the same verify error on attempts ${attempt - 1} and ${attempt} — bailing without spending the remaining attempts`,
                { phase: "verify", reason: verifyError.slice(0, 200) },
              );
            }
            priorErrorFingerprint = fp;
            continue;
          }
          priorErrorFingerprint = null;
          this.log?.info(`Verify ✓ passed for ${input.agentName} in ${verifyMs}ms`);
        }

        // 3. Review (if enabled)
        if (input.reviewEnabled) {
          const verifier = this.providers.get("verifier");
          if (verifier) {
            this.log?.info(`Running review for ${input.agentName}`);
            const diffRoot = input.workspaceRoot ?? input.cwd;
            const changes = await collectChanges(diffRoot, result.stdout);
            const verdict = await runReview(
              verifier, changes, input.taskContent ?? "",
              input.verifierModel ?? input.model, diffRoot,
              input.reviewCriteria,
            );
            const reviewDetail = verdict.kind === "approved"
              ? "approved"
              : verdict.kind === "retry"
                ? `retry feedback:\n${verdict.feedback}`
                : `${verdict.kind}: ${verdict.reason}`;
            await input.history?.event(
              "agent.attempt.review",
              `Verifier verdict=${verdict.kind}`,
              {
                level: verdict.kind === "approved" ? "info" : "warn",
                detail: reviewDetail,
                payload: { attempt, verdict: verdict.kind, changesChars: changes.length },
              },
            );

            switch (verdict.kind) {
              case "approved":
                this.log?.info(`Review approved for ${input.agentName}`);
                break;
              case "retry": {
                this.log?.warn(`Review asked retry for ${input.agentName} (see attempt ${attempt} event for full feedback)`);
                errorContext = `Verifier feedback:\n${truncateErrorContext(verdict.feedback)}`;
                const fp = errorFingerprint(verdict.feedback);
                if (priorErrorFingerprint != null && fp === priorErrorFingerprint && attempt < input.maxRetries) {
                  this.log?.warn(`Verifier feedback repeats fingerprint ${fp.slice(0, 60)} — aborting retry loop early`, {
                    agent: input.agentName, attempt, maxRetries: input.maxRetries, fingerprint: fp,
                  });
                  throw new AgentError(
                    "REVIEW_REPEATED",
                    `Verifier flagged the same issue on attempts ${attempt - 1} and ${attempt} for ${input.agentName} — bailing`,
                    { phase: "review", reason: verdict.feedback.slice(0, 200) },
                  );
                }
                priorErrorFingerprint = fp;
                continue;
              }
              case "failed":
                this.log?.error(`Review terminal FAILED for ${input.agentName}: ${verdict.reason.slice(0, 200)}`);
                throw new AgentError(
                  "REVIEW_TERMINAL",
                  `Verifier marked ${input.agentName} work as failed: ${verdict.reason}`,
                  { phase: "terminal-failed", reason: verdict.reason },
                );
              case "cancelled":
                this.log?.warn(`Review terminal CANCELLED for ${input.agentName}: ${verdict.reason.slice(0, 200)}`);
                throw new AgentError(
                  "REVIEW_TERMINAL",
                  `Verifier cancelled ${input.agentName} work: ${verdict.reason}`,
                  { phase: "terminal-cancelled", reason: verdict.reason },
                );
              case "rejected":
                this.log?.warn(`Review terminal REJECTED for ${input.agentName}: ${verdict.reason.slice(0, 200)}`);
                throw new AgentError(
                  "REVIEW_TERMINAL",
                  `Verifier rejected ${input.agentName} work scope: ${verdict.reason}`,
                  { phase: "terminal-rejected", reason: verdict.reason },
                );
            }
          }
        }

        return { output: result.stdout, attempts: attempt, durationMs: Date.now() - startTime };
      }
    } finally {
      await unlink(systemFile).catch(() => {});
    }

    // Determine failure phase from last errorContext (retries exhausted path).
    // Include the captured errorContext tail in the thrown message so the
    // executions UI row shows the real root cause (verify stderr, verifier
    // feedback, LLM failure) instead of a generic "failed after N attempts".
    const phase = errorContext.startsWith("Verifier feedback")
      ? "review" as const
      : errorContext.startsWith("Build/lint failed")
        ? "verify" as const
        : "llm" as const;
    const reasonTail = errorContext ? errorContext.slice(0, 400).trim() : "";
    const message = reasonTail
      ? `Agent ${input.agentName} failed after ${input.maxRetries} attempts (${phase}): ${reasonTail}`
      : `Agent ${input.agentName} failed after ${input.maxRetries} attempts`;
    throw new AgentError("MAX_RETRIES_EXCEEDED", message, { phase });
  }
}

// ── Verify phase (ports run-agent.sh run_verify) ────────────────────────

async function runVerify(command: string, cwd: string): Promise<string | null> {
  return new Promise((resolve) => {
    // `OPERATOR_VERIFY_SHELL` overrides the platform default for custom
    // setups (PowerShell, WSL bash on Windows, /bin/sh on minimal
    // Alpine, /bin/zsh, etc.). Production Linux/macOS defaults to
    // `/bin/bash` so verify scripts can use bash-specific syntax;
    // Windows defaults to `shell: true` which Node routes through
    // `%ComSpec%` (cmd.exe on stock Windows) so native tool lookups
    // like `dotnet` resolve against the developer's interactive PATH.
    const overrideShell = process.env.OPERATOR_VERIFY_SHELL;
    const shell = overrideShell
      ? overrideShell
      : process.platform === "win32"
        ? (true as const)
        : "/bin/bash";
    execFile(command, {
      cwd, timeout: 120_000, shell, env: process.env,
      // Default 1MB buffer chops long dotnet/npm logs and surfaces ENOBUFS
      // as an opaque "verification failed" with no context. 16MB is more
      // than enough for any realistic verify output and still well below
      // platform memory limits.
      maxBuffer: 16 * 1024 * 1024,
    }, (error, stdout, stderr) => {
      if (error) {
        // Combine stdout + stderr — eslint and TypeScript compilers
        // emit errors via stderr while dotnet emits via stdout, so
        // returning only one channel routinely loses the actionable
        // line. Marker prefixes help truncation prioritise the
        // stream that holds the failure.
        const combined = [
          stdout ? `--- stdout ---\n${stdout}` : "",
          stderr ? `--- stderr ---\n${stderr}` : "",
        ].filter(Boolean).join("\n");
        resolve(combined || "Verification failed");
      } else {
        resolve(null);
      }
    });
  });
}

// ── Review phase (ports run-agent.sh run_review) ────────────────────────

async function collectChanges(workspaceRoot: string, agentOutput: string): Promise<string> {
  const gitDiff = await gitDiffAll(workspaceRoot);
  if (gitDiff) return truncateForReview(gitDiff);
  if (agentOutput) return truncateForReview(agentOutput);
  return "";
}

async function gitDiffAll(cwd: string): Promise<string> {
  return new Promise((resolve) => {
    execFile("git", ["diff", "--no-color"], { cwd, timeout: 10_000 }, (err1, diff1) => {
      execFile("git", ["diff", "--cached", "--no-color"], { cwd, timeout: 10_000 }, (err2, diff2) => {
        resolve(((diff1 ?? "") + (diff2 ?? "")).trim());
      });
    });
  });
}

async function runReview(
  verifier: AgentProvider,
  changes: string,
  taskContent: string,
  model: string,
  cwd: string,
  reviewCriteria?: string,
): Promise<ReviewVerdict> {
  // Empty change set treated as approved (no-op agent run is fine).
  if (!changes) return { kind: "approved" };

  const reviewPrompt = buildReviewPrompt(changes, taskContent, reviewCriteria);
  const result = await verifier.execute(reviewPrompt, {
    model,
    timeoutMs: 600_000,
    cwd,
  });

  return parseReviewVerdict(result.stdout);
}

export function buildReviewPrompt(changes: string, taskContent: string, reviewCriteria?: string): string {
  const parts = ["## Review Request"];

  parts.push(`\n### Task Input\n\n\`\`\`\n${taskContent || "No task provided"}\n\`\`\``);

  if (reviewCriteria) {
    parts.push(`\n### Stage-Specific Review Criteria\n\n${reviewCriteria}`);
  }

  parts.push(`\n### Changes\n\n\`\`\`\n${changes}\n\`\`\``);

  parts.push(
    "\n### Instructions",
    "",
    "Review the changes against BOTH the task input AND the stage-specific criteria above.",
    "Check from multiple perspectives: correctness, completeness, consistency, quality.",
    "",
    "Respond with APPROVED if all criteria met, or REJECTED: <specific issues>.",
  );

  return parts.join("\n");
}

/**
 * Parse the verifier agent's structured verdict output. Tolerates either
 * the `## Verdict: <KIND>` marker or a bare uppercase first-line verdict.
 *
 * Precedence is strict: if an explicit marker appears, it wins. When the
 * verifier output is ambiguous or malformed, defaults to a safe `retry`
 * so the pipeline will loop — never silently approves bad output.
 *
 * Verdict kinds and their follow-up:
 * - `APPROVED` → caller commits and returns normally
 * - `RETRY: <feedback>` → caller feeds `feedback` back into next attempt
 * - `FAILED: <reason>` → caller marks work item failed, keeps PR open
 * - `CANCELLED: <reason>` → caller closes PR, drops work item (no retry)
 * - `REJECTED: <reason>` → caller closes PR, retrospective will regenerate
 */
export function parseReviewVerdict(output: string): ReviewVerdict {
  if (!output || !output.trim()) {
    return { kind: "retry", feedback: "Verifier returned empty output" };
  }

  // Prefer explicit "## Verdict: <KIND>" marker — this is the structured
  // format the new verifier prompt asks for and disambiguates the five
  // terminal / non-terminal outcomes.
  const verdictMatch = output.match(/##\s*Verdict:\s*(APPROVED|RETRY|FAILED|CANCELLED|REJECTED)\b/i);
  if (verdictMatch) {
    const kind = verdictMatch[1].toUpperCase();
    if (kind === "APPROVED") return { kind: "approved" };
    const detail = extractVerdictDetail(output, kind);
    if (kind === "RETRY") return { kind: "retry", feedback: detail };
    if (kind === "FAILED") return { kind: "failed", reason: detail };
    if (kind === "CANCELLED") return { kind: "cancelled", reason: detail };
    if (kind === "REJECTED") return { kind: "rejected", reason: detail };
  }

  // Legacy free-form detection for older verifier prompts that emit plain
  // "APPROVED" or "REJECTED: ..." anywhere in the text. Must handle these
  // because managed repos may still have old verifier prompts cached.
  const upper = output.toUpperCase();

  // "NOT APPROVED" overrides any APPROVED match — treat as retry.
  if (upper.includes("NOT APPROVED")) {
    return { kind: "retry", feedback: output };
  }

  // Bare APPROVED anywhere in text (no REJECTED / NOT APPROVED conflict)
  if (upper.includes("APPROVED") && !upper.includes("REJECTED")) {
    return { kind: "approved" };
  }

  // Legacy "REJECTED: <feedback>" — map to retry (not terminal rejected)
  // for backward compat with older verifier prompts.
  if (upper.includes("REJECTED")) {
    return { kind: "retry", feedback: output };
  }

  // Unknown format — do not approve; force a retry with the raw output.
  return { kind: "retry", feedback: output };
}

/**
 * Extract the detail payload for a non-approved verdict. Looks for an
 * optional subsection named `## Feedback` / `## Reason` / `## Details`,
 * else falls back to everything after the verdict line.
 */
function extractVerdictDetail(output: string, verdictKind: string): string {
  const sectionRegex = /##\s*(Feedback|Reason|Details)\s*\n([\s\S]*?)(?=\n##\s|$)/i;
  const section = output.match(sectionRegex);
  if (section) return section[2].trim();

  // Fallback: everything after the verdict marker line
  const marker = new RegExp(`##\\s*Verdict:\\s*${verdictKind}\\b.*?\\n`, "i");
  const afterMarker = output.replace(marker, "").trim();
  return afterMarker || `Verifier returned ${verdictKind} without detail`;
}

function truncateForReview(content: string): string {
  if (content.length <= MAX_REVIEW_DIFF_BYTES) return content;
  return content.slice(0, MAX_REVIEW_DIFF_BYTES) + "\n...\n[truncated]";
}

/**
 * Truncate a previous-attempt error message before it is inlined into the
 * next retry's user prompt. Keeps both the HEAD (where root-cause
 * keywords surface — vulnerable package name, missing symbol, primary
 * diagnostic) and the TAIL (final exit summary), dropping the middle
 * when content exceeds {@link MAX_ERROR_CONTEXT_BYTES}. Both ends are
 * useful for diagnosis, and a head-only or tail-only cut routinely
 * loses the actionable detail.
 *
 * Critical for preventing `spawn E2BIG` when verify output (e.g. `dotnet
 * build`) is hundreds of KB — without truncation, argv to the CLI would
 * overflow Linux ARG_MAX.
 */
/**
 * Reduce a verify / review failure message to a stable fingerprint
 * suitable for "same-cause" comparison across retries. Strips line
 * numbers, paths, timestamps, attempt counters, and other volatile
 * tokens so two attempts that fail on the same NuGet vulnerability
 * (different .csproj surfaced first time vs. second) collapse to the
 * same key.
 */
export function errorFingerprint(message: string): string {
  return message
    .replace(/\r/g, "")
    .replace(/[A-Za-z]:\\[^\s:]+/g, "<path>")
    .replace(/\/[A-Za-z0-9_./-]+\.\w+/g, "<path>")
    .replace(/:\d+:\d+/g, ":<ln>:<col>")
    .replace(/\b\d{4}-\d{2}-\d{2}T[0-9:.Z]+/g, "<ts>")
    .replace(/\b[0-9a-f]{7,40}\b/g, "<sha>")
    .replace(/\bAttempt \d+\/\d+\b/gi, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
}

/**
 * Lines that flag the actual failure when truncating verify / review
 * stderr. Order matters — we extract these first so the agent prompt
 * always carries the diagnostic line, not just the surrounding noise.
 */
const ERROR_LINE_PATTERN = /(\berror[ :]|Error\b|^FAIL\b|ERR!|fatal:|✗|exit code [^0]|TS\d{3,5}:|treated as an error)/i;

export function truncateErrorContext(content: string): string {
  if (content.length <= MAX_ERROR_CONTEXT_BYTES) return content;

  // Strategy: extract every line carrying an error marker first —
  // those are the actual diagnostics. Surround them with a small head
  // (often the command echo / preamble) and tail (final exit summary)
  // so context is preserved without burying the failure under
  // repetitive warning spew (NU1903 repeats once per .csproj, can
  // easily fill 1KB before the eslint failure that actually broke
  // the chain).
  const lines = content.split("\n");
  const errorLines = lines
    .filter((l) => ERROR_LINE_PATTERN.test(l))
    .map((l) => l.trim())
    .filter(Boolean);
  const dedupedErrors: string[] = [];
  for (const l of errorLines) {
    if (dedupedErrors[dedupedErrors.length - 1] !== l) dedupedErrors.push(l);
  }
  const errorBlock = dedupedErrors.length > 0
    ? `--- error lines (${dedupedErrors.length} after dedup) ---\n${dedupedErrors.join("\n")}\n`
    : "";

  const errorBudget = Math.min(errorBlock.length, Math.floor(MAX_ERROR_CONTEXT_BYTES * 0.5));
  const ctxBudget = Math.max(200, Math.floor((MAX_ERROR_CONTEXT_BYTES - errorBudget - 120) / 2));
  const errorPart = errorBlock.length > errorBudget
    ? `${errorBlock.slice(0, errorBudget)}\n[... ${errorBlock.length - errorBudget} bytes of error lines truncated ...]\n`
    : errorBlock;
  const head = content.slice(0, ctxBudget);
  const tail = content.slice(-ctxBudget);
  const dropped = content.length - head.length - tail.length;
  return `${errorPart}--- head ---\n${head}\n[... ${dropped} bytes truncated ...]\n--- tail ---\n${tail}`;
}
