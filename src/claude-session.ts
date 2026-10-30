import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Longest project directory name claude writes before it shortens it and appends a hash. */
const PROJECT_DIR_LIMIT = 200;

/**
 * Whether claude has a session to resume under this id: its transcript exists. claude keeps it at
 * `<config dir>/projects/<project dir>/<session id>.jsonl`, the config dir being `CLAUDE_CONFIG_DIR`
 * or `~/.claude`, and the project dir the cwd with every character other than a letter or a digit
 * written as `-` - cut at 200 characters and followed by `-<hash>` when longer (claude 2.1.308).
 * The hash is claude's own, so a long name is found by its prefix.
 */
export function claudeSessionExists(cwd: string, sessionId: string, env: Record<string, string | undefined>): boolean {
  const projects = join(env['CLAUDE_CONFIG_DIR'] || join(homedir(), '.claude'), 'projects');
  const name = cwd.replace(/[^a-zA-Z0-9]/g, '-');
  const file = `${sessionId}.jsonl`;
  if (name.length <= PROJECT_DIR_LIMIT) return existsSync(join(projects, name, file));
  const prefix = `${name.slice(0, PROJECT_DIR_LIMIT)}-`;
  let dirs: string[];
  try { dirs = readdirSync(projects); } catch { return false; }
  return dirs.some((dir) => dir.startsWith(prefix) && existsSync(join(projects, dir, file)));
}
