// Resumed after the answer: records it.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { dataDir, describeIfAsked, readInput, writeResult } from './lib.mjs';

describeIfAsked();
const input = readInput();
writeFileSync(join(dataDir(), 'done', `${input.subject}.answer`), JSON.stringify(input.input));
writeResult({ status: 'done', message: `answer ${input.input.answer} recorded` });
