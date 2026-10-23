// Shared helpers for the demo operations: read the contract input, write the contract result.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

export function describeIfAsked() {
  if (process.argv.includes('--describe')) {
    process.stdout.write(JSON.stringify({ contract: 1 }));
    process.exit(0);
  }
}

export function readInput() {
  return JSON.parse(readFileSync(process.env.OPERATOR_INPUT, 'utf8'));
}

export function dataDir() {
  const dir = process.env.DEMO_DATA ?? join(dirname(process.env.OPERATOR_MANIFEST), 'data');
  for (const sub of ['inbox', 'taken', 'done']) mkdirSync(join(dir, sub), { recursive: true });
  return dir;
}

export function writeResult(result) {
  writeFileSync(process.env.OPERATOR_RESULT, JSON.stringify({ contract: 1, ...result }));
}
