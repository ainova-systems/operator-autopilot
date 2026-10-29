import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { OperatorError } from './errors.ts';

/**
 * Loads variables from an env file without overriding what the process already has. With `keys`,
 * only those variables are taken, so a shared project env file does not leak into every run, and a
 * missing file is fine once the environment already holds every one of them (CI, a container).
 */
export function loadEnvFile(path: string, keys?: readonly string[]): string[] {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if (keys && keys.length > 0 && keys.every((name) => process.env[name] !== undefined)) return [];
    throw new OperatorError('ENV_FILE_UNREADABLE', `cannot read env file ${path}`, { cause: error });
  }
  const loaded: string[] = [];
  for (const [name, value] of Object.entries(parseEnv(text))) {
    if (keys && !keys.includes(name)) continue;
    if (process.env[name] !== undefined || value === undefined) continue;
    process.env[name] = value;
    loaded.push(name);
  }
  return loaded;
}
