import { OperatorError } from '../errors.ts';
import type { Manifest } from '../manifest.ts';
import { createAinoflowBackend } from './ainoflow.ts';
import { createFileBackend } from './file.ts';
import type { Capabilities, StateBackend } from './types.ts';

export interface OpenOptions {
  /** The file driver is for tests and dry runs; a live daemon refuses it unless this is set. */
  allowFileState?: boolean;
  /** Overrides the manifest provider, e.g. a dry run that must not write live state. */
  fileStateDir?: string;
}

export function openState(manifest: Manifest, options: OpenOptions = {}): StateBackend {
  if (options.fileStateDir) return createFileBackend(options.fileStateDir, manifest.state.namespace);
  if (manifest.state.provider === 'file') {
    if (!options.allowFileState) {
      throw new OperatorError('FILE_STATE_REFUSED', 'state.provider is file, which is for tests only; pass --allow-file-state (or OPERATOR_ALLOW_FILE_STATE=1) to run on it');
    }
    return createFileBackend(manifest.state.dir ?? `${manifest.runtime.stateDir}/file-state`, manifest.state.namespace);
  }
  const apiKey = process.env['AINOFLOW_API_KEY'];
  if (!apiKey) throw new OperatorError('AINOFLOW_KEY_MISSING', 'AINOFLOW_API_KEY is not set (environment, or the manifest envFile)');
  return createAinoflowBackend({ apiKey, namespace: manifest.state.namespace, baseUrl: manifest.state.baseUrl });
}

/** What the runtime needs from the state backend for this manifest, and what it found missing. */
export function capabilityProblems(manifest: Manifest, capabilities: Capabilities): string[] {
  const problems: string[] = [];
  const needsGuard = [...manifest.pools.values()].some((pool) => pool.kind === 'limit');
  const features = ['storageIfMatch', 'storageWhereFilter', ...(needsGuard ? ['guardConcurrency'] : [])];
  for (const feature of features) if (capabilities.features[feature] !== true) problems.push(`feature ${feature} is not available`);
  const minimums: Record<string, number> = { shieldLocksMonthly: 5000, ...(needsGuard ? { guardChecksMonthly: 5000 } : {}), ...manifest.state.require };
  for (const [limit, minimum] of Object.entries(minimums)) {
    const actual = capabilities.limits[limit];
    if (actual === 0 || minimum === 0) continue;
    if (actual === null || actual === undefined) problems.push(`limit ${limit} is unknown (needs at least ${minimum})`);
    else if (actual < minimum) problems.push(`limit ${limit} is ${actual}, below the required ${minimum}`);
  }
  return problems;
}

export async function checkCapabilities(manifest: Manifest, backend: StateBackend): Promise<Capabilities> {
  const capabilities = await backend.capabilities();
  const problems = capabilityProblems(manifest, capabilities);
  if (problems.length > 0) throw new OperatorError('CAPABILITIES_MISSING', `state backend ${backend.kind} cannot serve this manifest: ${problems.join('; ')}`);
  return capabilities;
}
