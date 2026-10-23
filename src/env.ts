import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { OperatorError } from './errors.ts';

/**
 * Loads variables from an env file without overriding what the process already has. With `keys`,
 * only those variables are taken, so a shared project env file does not leak into every run.
 */
export function loadEnvFile(path: string, keys?: readonly string[]): string[] {
  let text: string;
  try { text = readFileSync(path, 'utf8'); } catch (error) { throw new OperatorError('ENV_FILE_UNREADABLE', `cannot read env file ${path}`, { cause: error }); }
  const loaded: string[] = [];
  for (const [name, value] of Object.entries(parseEnv(text))) {
    if (keys && !keys.includes(name)) continue;
    if (process.env[name] !== undefined || value === undefined) continue;
    process.env[name] = value;
    loaded.push(name);
  }
  return loaded;
}
