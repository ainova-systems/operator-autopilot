import { existsSync, readdirSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

/** Longest project directory name claude writes before it shortens it and appends a hash. */
const PROJECT_DIR_LIMIT = 200;

function transcriptIn(projects: string, cwd: string, file: string): boolean {
  const name = cwd.replace(/[^a-zA-Z0-9]/g, '-');
  if (name.length <= PROJECT_DIR_LIMIT) return existsSync(join(projects, name, file));
  const prefix = `${name.slice(0, PROJECT_DIR_LIMIT)}-`;
  let dirs: string[];
  try { dirs = readdirSync(projects); } catch { return false; }
  return dirs.some((dir) => dir.startsWith(prefix) && existsSync(join(projects, dir, file)));
}

/**
 * Whether claude has a session to resume under this id, read where the session runs - the wrapper,
 * with the session's own environment and cwd. claude keeps a transcript at
 * `<config dir>/projects/<project dir>/<session id>.jsonl`: the config dir is `CLAUDE_CONFIG_DIR` or
 * `~/.claude`, and the project dir is the cwd's real path with every character other than a letter
 * or a digit written as `-`, cut at 200 characters and followed by `-<hash>` when longer (claude
 * 2.1.308). The name the cwd was given is checked too. Undefined when it cannot be told: a relative
 * `CLAUDE_CONFIG_DIR`, whose base claude does not document.
 */
export function claudeSessionExists(cwd: string, sessionId: string, env: Record<string, string | undefined>): boolean | undefined {
  const configured = env['CLAUDE_CONFIG_DIR'];
  if (configured && !isAbsolute(configured)) return undefined;
  const projects = join(configured || env['HOME'] || homedir(), ...(configured ? [] : ['.claude']), 'projects');
  const file = `${sessionId}.jsonl`;
  let real = cwd;
  try { real = realpathSync(cwd); } catch { /* a cwd that cannot be resolved is checked as given */ }
  return transcriptIn(projects, real, file) || (real !== cwd && transcriptIn(projects, cwd, file));
}
