import { readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

/**
 * Windows launcher resolution for agent CLIs that ship as a script shim
 * rather than a native `.exe`.
 *
 * `child_process.spawn` on Windows cannot launch a `.cmd` / `.ps1` by bare
 * name (it resolves only `.exe`, so `spawn("cursor-agent")` fails ENOENT),
 * and `shell: true` does NOT escape arguments (Node DEP0190) — a prompt with
 * spaces / quotes / `&` / `%` would be mangled or split. The robust fix is to
 * resolve the shim to the real interpreter + script and spawn THAT directly
 * with a clean argv, so `CreateProcess` passes each argument verbatim.
 *
 * `cursor-agent` installs as `<home>/cursor-agent.cmd` → `powershell -File
 * <home>/cursor-agent.ps1` → `<home>/versions/<latest>/node.exe index.js
 * $args`. We replicate the `.ps1`'s own resolution (its node + index.js) so
 * the engine spawns `node.exe index.js …` directly — identical to how the
 * shim would, minus the cmd/powershell hops that break argument fidelity.
 *
 * No-op on non-Windows (the Linux/macOS `cursor-agent` is a real executable
 * that spawns fine) and for any command without a known launcher mapping.
 */

export interface LauncherResolution {
  readonly command: string;
  readonly prependArgs: readonly string[];
}

/**
 * cursor-agent version-directory naming. Two shipped shapes:
 *   - older:  `YYYY.MM.DD-<hash>`             e.g. `2026.01.28-fd13201`
 *   - newer:  `YYYY.MM.DD-HH-MM-SS-<hash>`    e.g. `2026.06.19-20-24-33-653a7fb`
 *
 * The `-HH-MM-SS` build-time segment is optional so both resolve. Missing it
 * matched only the old shape, which silently pinned the launcher to a stale
 * five-month-old build even when newer installs were present.
 */
const VERSION_DIR = /^\d{4}\.\d{1,2}\.\d{1,2}(?:-\d{2}-\d{2}-\d{2})?-[a-f0-9]+$/;

/**
 * Resolve the cursor-agent install at {@link home} to its bundled
 * `node.exe` + `index.js`. Mirrors `cursor-agent.ps1`:
 *   1. `<home>/node.exe` + `<home>/index.js` (already inside a version dir), else
 *   2. the newest `<home>/versions/<version-dir>/{node.exe,index.js}` (see
 *      {@link VERSION_DIR} for the two accepted naming shapes).
 * Returns `null` when the layout is absent so the caller falls back to
 * spawning the bare command (which then fails loudly, never silently).
 */
export function resolveCursorWinLauncher(home: string): LauncherResolution | null {
  const direct = tryPair(home);
  if (direct) return direct;

  const versionsDir = join(home, "versions");
  let entries: string[];
  try {
    entries = readdirSync(versionsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && VERSION_DIR.test(e.name))
      .map((e) => e.name);
  } catch {
    return null;
  }
  const latest = entries.sort((a, b) => versionKey(b) - versionKey(a))[0];
  if (!latest) return null;
  return tryPair(join(versionsDir, latest));
}

function tryPair(dir: string): LauncherResolution | null {
  const nodeExe = join(dir, "node.exe");
  const indexJs = join(dir, "index.js");
  if (existsSync(nodeExe) && existsSync(indexJs)) {
    return { command: nodeExe, prependArgs: [indexJs] };
  }
  return null;
}

/**
 * Numeric sort key for newest-first selection. Folds the optional build-time
 * segment in so two builds on the same calendar day order by `HH-MM-SS`:
 *   `2026.01.28-abc`             → 20260128000000
 *   `2026.06.19-20-24-33-653a7f` → 20260619202433
 * (matches the ps1's "pick the newest version" intent). 14 digits stays well
 * under `Number.MAX_SAFE_INTEGER`.
 */
function versionKey(name: string): number {
  const segs = name.split("-"); // [date, HH?, MM?, SS?, hash]
  const [y, m, d] = segs[0].split(".");
  const pad = (v: string) => v.padStart(2, "0");
  const timeSeg = (i: number): string =>
    /^\d{1,2}$/.test(segs[i] ?? "") ? pad(segs[i]) : "00";
  return Number(`${y}${pad(m)}${pad(d)}${timeSeg(1)}${timeSeg(2)}${timeSeg(3)}`);
}

/**
 * Compute the spawnable command + prepended args for a CLI command on the
 * current host. This is host-local runtime adaptation, NOT configuration:
 * the decision depends only on the OS ({@link platform}) and the command
 * itself, both known at spawn time. Nothing about it belongs in the seeded
 * config / DB — that holds only the platform-neutral `command` (e.g.
 * `cursor-agent`), and the engine decides how to launch it per host.
 *
 * On Windows, `cursor-agent` ships as a `.cmd`/`.ps1` shim that `spawn`
 * cannot run by bare name; we resolve it to its bundled `node.exe index.js`
 * (mirroring the shim's own logic). Everywhere else — Linux/macOS, and
 * `.exe`-based CLIs like claude — this is the identity, so they spawn
 * directly. Extend {@link isCursorAgentCommand} / add sibling matchers when
 * another CLI needs the same Windows handling.
 *
 * Pure over its inputs so it is testable on any OS without spawning anything.
 */
export function effectiveLauncher(
  command: string,
  platform: string,
  env: NodeJS.ProcessEnv,
): LauncherResolution {
  if (platform !== "win32" || !isCursorAgentCommand(command)) {
    return { command, prependArgs: [] };
  }
  const home = env.CURSOR_AGENT_HOME
    ?? (env.LOCALAPPDATA ? join(env.LOCALAPPDATA, "cursor-agent") : undefined);
  const resolved = home ? resolveCursorWinLauncher(home) : null;
  return resolved ?? { command, prependArgs: [] };
}

/** Does this command refer to the cursor-agent CLI (with or without a shim extension)? */
function isCursorAgentCommand(command: string): boolean {
  const base = command.replace(/\\/g, "/").split("/").pop() ?? command;
  return /^cursor-agent(\.(cmd|ps1|exe))?$/i.test(base);
}
