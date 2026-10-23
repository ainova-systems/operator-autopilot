// Asks the owner a question and ends; the answer arrives later as a trigger.
import { describeIfAsked, readInput, writeResult } from './lib.mjs';

describeIfAsked();
const input = readInput();
console.log(`ask: question q1 for ${input.subject}`);
writeResult({ status: 'needs-input', message: 'asked q1', wait: { on: 'answer', key: 'q1', resume: 'answered', input: { question: 'q1' } } });
