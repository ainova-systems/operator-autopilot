import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import type { KVStore, OperationContext, WorkspaceInitEntry } from "@operator/core";
import { WorkspaceError } from "@operator/core";
import type { Logger } from "../logging/logger.js";

/**
 * Files whose content participates in the init-cache hash. Presence is
 * detected at runtime — a Node app sees `package-lock.json`, a Rails
 * app sees `Gemfile.lock`, a polyglot repo sees several. Lock files
 * are the canonical "what would `npm ci` actually install" input;
 * hashing them captures dep changes without us re-running on every
 * source-file edit.
 */
const LOCK_FILES = [
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "Cargo.lock",
  "Gemfile.lock",
  "poetry.lock",
  "go.sum",
];

/** Hard ceiling on `scripts.init` runtime — `npm ci` on a slow link
 *  is the realistic worst case; ten minutes is comfortable. */
const INIT_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Compute the hash of all relevant inputs that determine init's
 * outcome: the literal init command + every lock file present in the
 * workspace tree (recursive, capped at depth 4 so we don't sweep
 * `node_modules`). Stable order = deterministic hash.
 */
async function computeInitHash(
  workspacePath: string,
  initCommand: string,
): Promise<string> {
  const h = createHash("sha256");
  h.update(initCommand);
  // Walk a small set of well-known monorepo subdirs (Source/Frontend,
  // app, packages/*, frontend, web) plus the root. Going deeper risks
  // pulling node_modules; staying shallow misses real lock files.
  const candidates: string[] = [];
  for (const lock of LOCK_FILES) candidates.push(resolve(workspacePath, lock));
  for (const sub of ["Source/Frontend", "app", "frontend", "web"]) {
    for (const lock of LOCK_FILES) candidates.push(resolve(workspacePath, sub, lock));
  }
  // Scan packages/* one level deep (common monorepo layout).
  try {
    const { readdir } = await import("node:fs/promises");
    const pkgDir = resolve(workspacePath, "packages");
    const entries = await readdir(pkgDir, { withFileTypes: true });
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      for (const lock of LOCK_FILES) candidates.push(resolve(pkgDir, e.name, lock));
    }
  } catch {
    // No packages/ directory — non-monorepo repo.
  }
  candidates.sort();
  for (const path of candidates) {
    try {
      await stat(path);
      const buf = await readFile(path);
      h.update(`\n${path}\n`);
      h.update(buf);
    } catch {
      // Lock file absent at this path — skip.
    }
  }
  return h.digest("hex");
}

/** Run `scripts.init` in `cwd`, streaming stdout/stderr into `log`.
 *  Resolves on exit code 0; rejects on non-zero or timeout. */
function runInit(
  command: string,
  cwd: string,
  ctx: OperationContext,
  log: Logger,
): Promise<{ durationMs: number }> {
  return new Promise((resolveP, rejectP) => {
    const startedAt = Date.now();
    const child = spawn(command, {
      cwd,
      shell: true,
      env: { ...process.env },
    });
    const onAbort = (): void => {
      child.kill("SIGTERM");
      rejectP(new WorkspaceError("WS_INIT_ABORTED", `scripts.init aborted by signal`));
    };
    if (ctx.signal.aborted) return onAbort();
    ctx.signal.addEventListener("abort", onAbort, { once: true });
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      rejectP(new WorkspaceError("WS_INIT_TIMEOUT", `scripts.init exceeded ${INIT_TIMEOUT_MS}ms`));
    }, INIT_TIMEOUT_MS);
    let stderrTail = "";
    // Stream stdout/stderr line-by-line so pino-pretty does not interleave
    // multi-line chunks with structured binding fields (the staircase
    // effect when an agent emits progressive output with embedded \n's
    // and ANSI escapes inside one chunk). Each scrubbed line becomes its
    // own DEBUG entry with clean field alignment.
    let stdoutBuf = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutBuf += chunk.toString();
      const lines = stdoutBuf.split("\n");
      stdoutBuf = lines.pop() ?? "";
      for (const line of lines) {
        const scrubbed = scrubStreamLine(line);
        if (scrubbed) log.debug(`init stdout: ${scrubbed}`);
      }
    });
    let stderrBuf = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      const s = chunk.toString();
      stderrTail = (stderrTail + s).slice(-2000);
      stderrBuf += s;
      const lines = stderrBuf.split("\n");
      stderrBuf = lines.pop() ?? "";
      for (const line of lines) {
        const scrubbed = scrubStreamLine(line);
        if (scrubbed) log.debug(`init stderr: ${scrubbed}`);
      }
    });
    child.on("error", (err) => {
      clearTimeout(timeout);
      ctx.signal.removeEventListener("abort", onAbort);
      rejectP(new WorkspaceError("WS_INIT_SPAWN_ERROR", `scripts.init failed to spawn: ${err.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      ctx.signal.removeEventListener("abort", onAbort);
      // Flush any tail of a final line that lacked a trailing \n so the
      // last skill/progress entry still shows up in the log.
      for (const [prefix, tail] of [["stdout", stdoutBuf], ["stderr", stderrBuf]] as const) {
        const scrubbed = scrubStreamLine(tail);
        if (scrubbed) log.debug(`init ${prefix}: ${scrubbed}`);
      }
      if (code === 0) {
        resolveP({ durationMs: Date.now() - startedAt });
      } else {
        rejectP(new WorkspaceError(
          "WS_INIT_FAILED",
          `scripts.init exited ${code}\n--- stderr tail ---\n${stderrTail}`,
        ));
      }
    });
  });
}

/**
 * Normalise a single line of agent stdout/stderr before it reaches the
 * pino logger:
 *   - strip ANSI escape sequences (colors, cursor moves, line-clear)
 *   - drop carriage returns (progress spinners / TUI redraws)
 *   - trim trailing whitespace
 * Returns the cleaned line, or empty string when nothing meaningful
 * remains so the caller can skip the debug entry entirely.
 */
function scrubStreamLine(line: string): string {
  // eslint-disable-next-line no-control-regex
  return line.replace(/\x1B\[[0-9;?]*[A-Za-z]/g, "").replace(/\r/g, "").trimEnd();
}

/**
 * Ensure the workspace's `scripts.init` has run for the current set of
 * lock-file inputs. No-op when the command + lock hash matches the
 * last successful run cached in `kv:workspace-init/{repoId}`.
 *
 * Failure modes (all throw `WorkspaceError`):
 *   - `WS_INIT_TIMEOUT`     init ran past the 10-minute ceiling.
 *   - `WS_INIT_FAILED`      init exited non-zero (build/install error).
 *   - `WS_INIT_ABORTED`     ctx.signal fired mid-run (cycle cancelled).
 *   - `WS_INIT_SPAWN_ERROR` shell could not start the command at all.
 *
 * On any failure the cache is NOT updated, so the next cycle retries
 * automatically once the underlying issue is fixed (network blip, lock
 * file conflict, missing native build tool, etc.). Returns silently
 * when `initCommand` is empty/undefined — repos without an init script
 * pay zero cost.
 */
export async function ensureWorkspaceInit(deps: {
  readonly repoId: string;
  readonly workspacePath: string;
  readonly initCommand: string | undefined;
  readonly kv: KVStore;
  readonly ctx: OperationContext;
  readonly log: Logger;
}): Promise<{ ran: boolean; cached: boolean; reason: string }> {
  const { repoId, workspacePath, initCommand, kv, ctx, log } = deps;
  if (!initCommand || !initCommand.trim()) {
    return { ran: false, cached: false, reason: "no-init-script" };
  }
  const hash = await computeInitHash(workspacePath, initCommand);
  const prior = await kv.get("workspace-init", repoId);
  if (prior) {
    const entry = prior.value as WorkspaceInitEntry;
    if (entry.hash === hash) {
      log.debug(`workspace-init: cache hit for ${repoId} (hash ${hash.slice(0, 12)})`);
      return { ran: false, cached: true, reason: "hash-match" };
    }
  }
  log.info(
    `workspace-init: ${prior ? "lock files changed" : "first run"} for ${repoId}, executing scripts.init`,
    { repoId, command: initCommand },
  );
  const { durationMs } = await runInit(initCommand, workspacePath, ctx, log);
  const entry: WorkspaceInitEntry = {
    repoId,
    hash,
    runAt: new Date().toISOString(),
    durationMs,
  };
  await kv.put("workspace-init", repoId, entry);
  log.info(
    `workspace-init: scripts.init succeeded for ${repoId} in ${durationMs}ms`,
    { repoId, durationMs, hash: hash.slice(0, 12) },
  );
  return { ran: true, cached: false, reason: prior ? "hash-changed" : "first-run" };
}
