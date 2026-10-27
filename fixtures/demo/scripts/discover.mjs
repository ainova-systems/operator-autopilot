// Discovery: every file in data/inbox becomes a follow-on request; nothing found is noop.
import { readdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { dataDir, describeIfAsked, readInput, writeResult } from './lib.mjs';

describeIfAsked();
readInput();
const dir = dataDir();
const next = [];
for (const name of readdirSync(join(dir, 'inbox')).sort()) {
  const match = /^(.+)\.(work|ask|plan)$/.exec(name);
  if (!match) continue;
  next.push({ operation: match[2], subject: match[1], input: { item: name } });
  if (process.env.OPERATOR_DRY_RUN !== '1') renameSync(join(dir, 'inbox', name), join(dir, 'taken', name));
}
console.log(`discover: ${next.length} item(s)`);
writeResult(next.length > 0 ? { status: 'done', next, message: `found ${next.length}` } : { status: 'noop', message: 'inbox empty' });
