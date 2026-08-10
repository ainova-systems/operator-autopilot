import { accessSync, constants, statSync } from "node:fs";
import { delimiter, join } from "node:path";

/**
 * Cross-platform `which` — resolve an executable name against `PATH`.
 *
 * The setup preflight needs to answer "is the agent CLI installed?" before
 * the engine has ever run. Executing the binary (`claude --version`) would
 * be a stronger signal but costs a process spawn, a timeout policy, and a
 * non-deterministic unit test; a PATH lookup answers the question that
 * actually blocks onboarding — the CLI is missing entirely — with no side
 * effects at all.
 *
 * Windows specifics: bare names are only executable when combined with an
 * extension from `PATHEXT`, and the variable itself is spelled `Path` as
 * often as `PATH`, so both lookups are case-insensitive.
 */
/**
 * Environment as a plain record. `NodeJS.ProcessEnv` is augmented by Next.js
 * with a required `NODE_ENV`, which makes it unusable as the type of an
 * injected literal in tests — this alias accepts both `process.env` and a
 * hand-built fixture.
 */
export type EnvRecord = Readonly<Record<string, string | undefined>>;

export interface FindOnPathOptions {
  readonly env?: EnvRecord;
  readonly platform?: NodeJS.Platform;
}

const WINDOWS_DEFAULT_PATHEXT = ".COM;.EXE;.BAT;.CMD";

export function findOnPath(command: string, opts: FindOnPathOptions = {}): string | null {
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;

  if (command.includes("/") || command.includes("\\")) {
    return isExecutableFile(command, platform) ? command : null;
  }

  const rawPath = readEnvVar(env, "PATH") ?? "";
  if (!rawPath) return null;

  for (const dir of rawPath.split(delimiter)) {
    if (!dir) continue;
    for (const ext of executableExtensions(env, platform)) {
      const candidate = join(dir, `${command}${ext}`);
      if (isExecutableFile(candidate, platform)) return candidate;
    }
  }
  return null;
}

/**
 * Case-insensitive environment lookup. `process.env` is already
 * case-insensitive on Windows, but an injected record (tests, a request
 * scope) is a plain object and would miss `Path` when asked for `PATH`.
 */
export function readEnvVar(env: EnvRecord, name: string): string | undefined {
  const direct = env[name];
  if (direct !== undefined) return direct;
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(env)) {
    if (key.toLowerCase() === wanted) return value;
  }
  return undefined;
}

function executableExtensions(env: EnvRecord, platform: NodeJS.Platform): string[] {
  if (platform !== "win32") return [""];
  const pathext = readEnvVar(env, "PATHEXT") ?? WINDOWS_DEFAULT_PATHEXT;
  const exts = pathext
    .split(";")
    .map((e) => e.trim())
    .filter((e) => e.length > 0);
  // `""` last so an extension-carrying match wins, but a bare file (a shell
  // shim dropped in by a package manager) is still found.
  return [...exts, ""];
}

function isExecutableFile(path: string, platform: NodeJS.Platform): boolean {
  try {
    if (!statSync(path).isFile()) return false;
  } catch {
    return false;
  }
  if (platform === "win32") return true;
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
