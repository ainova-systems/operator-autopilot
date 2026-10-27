// A stand-in interactive session: it writes its result and, given a terminal, stays open the way a
// session does until someone ends it; the wrapper closes it once the result is written. Without a
// terminal it runs as an agent and exits by itself.
import { describeIfAsked, readInput, writeResult } from './lib.mjs';

describeIfAsked();
const input = readInput();
console.log(`session: planning ${input.subject}`);
writeResult({ status: 'done', message: `planned ${input.subject}` });
if (process.env.OPERATOR_ATTENDED === '1') setInterval(() => {}, 1000);
