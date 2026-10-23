// The follow-on step: records that the subject is finished.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { dataDir, describeIfAsked, readInput, writeResult } from './lib.mjs';

describeIfAsked();
const input = readInput();
writeFileSync(join(dataDir(), 'done', `${input.subject}.done`), JSON.stringify(input.input));
writeResult({ status: 'done', message: `finished ${input.subject}` });
