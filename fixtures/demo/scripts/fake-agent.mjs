// A stand-in agent: works for a few seconds, records each launch, then asks for the finish step.
import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { dataDir, describeIfAsked, readInput, writeResult } from './lib.mjs';

describeIfAsked();
const input = readInput();
const dir = dataDir();
appendFileSync(join(dir, 'launches.log'), `${input.subject} ${input.run.id}\n`);
let seconds = Number(input.input.seconds ?? 0);
if (!seconds) {
  try { seconds = Number(readFileSync(join(dir, 'taken', `${input.subject}.work`), 'utf8').trim()) || 2; } catch { seconds = 2; }
}
for (let i = 1; i <= seconds; i += 1) {
  console.log(`fake agent: working on ${input.subject} (${i}/${seconds})`);
  await sleep(1000);
}
if (input.input.fail === 'retryable') {
  writeResult({ status: 'failed', failure: { reason: 'demo failure', retryable: true } });
  process.exit(0);
}
writeResult({ status: 'done', message: `worked ${seconds}s`, evidence: [`launch ${input.run.id}`], next: [{ operation: 'finish', input: { worked: seconds } }] });
