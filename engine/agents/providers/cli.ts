import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import type { ChildProcess } from "node:child_process";
import type { AgentProvider } from "@operator/core";
import type { Logger } from "../../logging/logger.js";
import { effectiveLauncher } from "./win-launcher.js";

const MAX_BUFFER = 50 * 1024 * 1024;

/**
 * Provider configuration from agents.yaml `providers:` section.
 */
export interface CLIProviderConfig {
  readonly command: string;
  readonly defaultArgs: readonly string[];
  readonly promptArg: string;
  readonly modelArg?: string;
  readonly toolsArg?: string;
  readonly maxBudgetArg?: string;
  readonly systemPromptFileArg?: string;
  /**
   * When true, the prompt body is fed via stdin and `promptArg` is emitted
   * as a bare flag (no value). Bypasses the OS argv limit (~32 KB on
   * Windows) so prompts over a hundred KB no longer fail with
   * `spawn ENAMETOOLONG`.
   */
  readonly promptFromStdin?: boolean;
}

/**
 * GitHub credential vars stripped from every agent child process.
 *
 * The orchestrator owns the pull request and talks to GitHub over Octokit in
 * the parent process. An agent that inherits these can authenticate `gh` and
 * mutate the PR — the path that overwrote a PR description with collapsed
 * newlines and double-encoded text on a Windows host (2026-06-19). Stripping
 * them makes `gh pr edit` fail auth so the agent cannot rewrite the
 * orchestrator-authored PR body. Defense in depth alongside the boundary rule
 * in `engine/content/prompts/agents/context/base.md`.
 */
const AGENT_FORBIDDEN_ENV: readonly string[] = [
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GH_ENTERPRISE_TOKEN",
  "GITHUB_ENTERPRISE_TOKEN",
];

/**
 * Build child process env, dropping empty-string variables.
 *
 * CI secrets that are declared in the workflow but not set in the repo get
 * exported as empty strings. An empty `ANTHROPIC_API_KEY=""` shadows the
 * OAuth fallback in the claude CLI, so every invocation fails auth in a few
 * seconds. Filtering empty strings lets the CLI fall back to other creds
 * (e.g. `CLAUDE_CODE_OAUTH_TOKEN`).
 *
 * GitHub credential vars ({@link AGENT_FORBIDDEN_ENV}) are stripped so the
 * agent cannot authenticate `gh` against the orchestrator-owned pull request.
 */
export function buildChildEnv(
  parentEnv: NodeJS.ProcessEnv,
  overrides?: Record<string, string>,
): Record<string, string> {
  const merged: Record<string, string> = {};
  for (const [key, value] of Object.entries(parentEnv)) {
    if (value === undefined || value === "") continue;
    merged[key] = value;
  }
  for (const key of AGENT_FORBIDDEN_ENV) delete merged[key];
  if (overrides) {
    for (const [key, value] of Object.entries(overrides)) {
      if (value === undefined || value === "") {
        delete merged[key];
        continue;
      }
      merged[key] = value;
    }
  }
  return merged;
}

/**
 * Kill entire process group (SIGKILL) — matches Linux `timeout` behavior.
 * Falls back to child.kill if process group kill fails or on Windows.
 */
function killTree(child: ChildProcess): void {
  if (process.platform !== "win32" && child.pid) {
    try {
      process.kill(-child.pid, "SIGKILL");
      return;
    } catch { /* process group kill failed — fall through */ }
  }
  child.kill("SIGKILL");
}

/**
 * Universal CLI agent provider.
 *
 * One implementation handles all agent CLIs (Claude, OpenCode, Kiro, etc.).
 * CLI-specific flags are defined in config, not code.
 *
 * Uses spawn + detached process group so timeout kills the entire tree
 * (claude CLI + any child processes). Ports run-agent.sh run_llm().
 */
export class CLIAgentProvider implements AgentProvider {
  constructor(
    readonly id: string,
    private readonly config: CLIProviderConfig,
    private readonly log?: Logger,
  ) {}

  async execute(
    prompt: string,
    options: {
      model: string;
      timeoutMs: number;
      tools?: string[];
      maxBudgetUsd?: number;
      systemPromptFile?: string;
      cwd: string;
      env?: Record<string, string>;
    },
  ): Promise<{ stdout: string; exitCode: number; durationMs: number }> {
    const effectivePrompt = await this.resolvePrompt(prompt, options.systemPromptFile);
    // Host-local launch adaptation: on Windows, cursor-agent is a .cmd/.ps1
    // shim spawn cannot run by bare name, so resolve it to its bundled
    // node.exe + index.js. Identity on Linux/macOS and for .exe CLIs.
    const launcher = effectiveLauncher(this.config.command, process.platform, process.env);
    const command = launcher.command;
    const args = [...launcher.prependArgs, ...this.buildArgs(effectivePrompt, options)];
    const start = Date.now();

    this.log?.debug(`CLI spawn`, {
      provider: this.id,
      command,
      configCommand: this.config.command,
      model: options.model,
      timeoutMs: options.timeoutMs,
      maxBudgetUsd: options.maxBudgetUsd,
      tools: options.tools?.join(","),
      cwd: options.cwd,
      promptLength: effectivePrompt.length,
      folded: effectivePrompt.length !== prompt.length,
      argCount: args.length,
    });

    return new Promise((resolve, reject) => {
      const child = spawn(command, args, {
        cwd: options.cwd,
        env: buildChildEnv(process.env, options.env),
        detached: process.platform !== "win32",
        stdio: [this.config.promptFromStdin ? "pipe" : "ignore", "pipe", "pipe"],
      });

      if (this.config.promptFromStdin) {
        child.stdin!.on("error", (err) => {
          this.log?.warn(`CLI stdin write failed`, {
            provider: this.id,
            error: (err as Error).message,
          });
        });
        child.stdin!.end(effectivePrompt);
      }

      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let bufferExceeded = false;

      child.stdout!.on("data", (chunk: Buffer) => {
        stdout += chunk;
        if (stdout.length > MAX_BUFFER) {
          bufferExceeded = true;
          killTree(child);
        }
      });

      child.stderr!.on("data", (chunk: Buffer) => {
        stderr += chunk;
      });

      const timer = setTimeout(() => {
        timedOut = true;
        this.log?.error(`CLI timeout after ${options.timeoutMs}ms`, { provider: this.id, timeoutMs: options.timeoutMs, durationMs: Date.now() - start });
        killTree(child);
      }, options.timeoutMs);

      child.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });

      child.on("close", (code) => {
        clearTimeout(timer);
        const durationMs = Date.now() - start;

        if (timedOut) {
          reject(new Error(`CLI timeout after ${options.timeoutMs}ms`));
          return;
        }
        if (bufferExceeded) {
          reject(new Error("CLI output exceeded max buffer"));
          return;
        }

        const exitCode = code ?? 1;
        if (exitCode !== 0) {
          this.log?.warn(`CLI exit`, {
            provider: this.id,
            exitCode,
            durationMs,
            stderr: stderr.slice(0, 1000),
            stdout: stdout.slice(0, 1000),
          });
        }
        this.log?.debug(`CLI completed`, {
          provider: this.id,
          exitCode,
          durationMs,
          outputLength: stdout.length,
        });
        resolve({ stdout, exitCode, durationMs });
      });
    });
  }

  /**
   * Fold the runtime-built system prompt into the prompt body when the
   * provider exposes no system-prompt flag.
   *
   * The runtime always writes the assembled role + context layers to a
   * `systemPromptFile` and hands the path to {@link execute}. Providers that
   * declare `systemPromptFileArg` (claude → `--append-system-prompt-file`)
   * pass it by reference and skip folding. Providers without one — notably
   * `cursor-agent`, which has no system-prompt option and only reads
   * `AGENTS.md` / `.cursor/rules` — would otherwise drop the entire system
   * prompt, running every agent with the bare user prompt. Folding prepends
   * the system prompt so the agent's role and context still reach it.
   *
   * A missing or unreadable file degrades to the original prompt with a
   * WARN rather than failing the run — the file is operator-internal and a
   * read miss must surface, not crash the cycle.
   */
  private async resolvePrompt(prompt: string, systemPromptFile?: string): Promise<string> {
    if (!systemPromptFile || this.config.systemPromptFileArg) return prompt;
    try {
      const system = await readFile(systemPromptFile, "utf-8");
      if (!system.trim()) return prompt;
      return `${system}\n\n---\n\n${prompt}`;
    } catch (err) {
      this.log?.warn(`Failed to fold system prompt into prompt body`, {
        provider: this.id,
        systemPromptFile,
        error: (err as Error).message,
      });
      return prompt;
    }
  }

  private buildArgs(
    prompt: string,
    options: {
      model: string;
      tools?: string[];
      maxBudgetUsd?: number;
      systemPromptFile?: string;
    },
  ): string[] {
    const args = [...this.config.defaultArgs];

    if (options.model && this.config.modelArg) {
      args.push(this.config.modelArg, options.model);
    }
    if (options.systemPromptFile && this.config.systemPromptFileArg) {
      args.push(this.config.systemPromptFileArg, options.systemPromptFile);
    }
    if (options.tools?.length && this.config.toolsArg) {
      args.push(this.config.toolsArg, options.tools.join(","));
    }
    if (options.maxBudgetUsd && this.config.maxBudgetArg) {
      args.push(this.config.maxBudgetArg, String(options.maxBudgetUsd));
    }

    if (this.config.promptFromStdin) {
      args.push(this.config.promptArg);
    } else {
      args.push(this.config.promptArg, prompt);
    }
    return args;
  }
}
