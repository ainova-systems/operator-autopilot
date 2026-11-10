import { open, readFile, writeFile } from 'node:fs/promises';
import { CONTRACT_VERSION, parseResult, type OperationResult } from './contract.ts';
import { findCodexThread } from './engines.ts';
import type { JobRecord } from './jobs.ts';
import type { OperationSpec } from './manifest.ts';
import { readJsonFile, runPath, type ExitInfo } from './runfiles.ts';

export interface Collected {
  exit: ExitInfo;
  result: OperationResult;
  threadId?: string;
  contractProvided?: boolean;
}

function failed(reason: string, retryable: boolean, message?: string): OperationResult {
  return { contract: CONTRACT_VERSION, status: 'failed', evidence: [], next: [], failure: { reason, retryable }, ...(message ? { message } : {}) };
}

async function readText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

/** Thread identity is announced at the beginning, independently of the bounded quota tail. */
async function readCodexThread(runDir: string): Promise<string | undefined> {
  let file;
  try { file = await open(runPath(runDir, 'output'), 'r'); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  try {
    const buffer = Buffer.alloc(256 * 1024);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    return findCodexThread(buffer.subarray(0, bytesRead).toString('utf8'));
  } finally { await file.close(); }
}

/** How much of a run's output the final Claude result is looked for in; it is the last event Claude prints. */
const RESULT_TAIL_BYTES = 8 * 1024 * 1024;

/**
 * The structured output of a Claude run's final result event (`--json-schema`), read from the end of
 * its output log; undefined unless the run ended in success with one.
 */
export async function readClaudeStructuredOutput(runDir: string): Promise<unknown> {
  let file;
  try { file = await open(runPath(runDir, 'output'), 'r'); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  let text: string;
  try {
    const size = (await file.stat()).size;
    const start = Math.max(0, size - RESULT_TAIL_BYTES);
    const buffer = Buffer.alloc(size - start);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, start);
    text = buffer.subarray(0, bytesRead).toString('utf8');
  } finally { await file.close(); }
  const lines = text.split('\n');
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]!.trim();
    if (!line.startsWith('{')) continue;
    let event: { type?: unknown; subtype?: unknown; is_error?: unknown; structured_output?: unknown };
    try { event = JSON.parse(line) as typeof event; } catch { continue; }
    if (event?.type !== 'result') continue;
    // Only the run's last result counts: a failed or schema-less ending is no answer.
    if (event.subtype !== 'success' || event.is_error === true || event.structured_output === undefined || event.structured_output === null) return undefined;
    return event.structured_output;
  }
  return undefined;
}

/**
 * Turns a finished run into a contract result. Exit status and a valid result file together prove
 * the run executed; an exit of 0 alone never counts as success. A Codex run cannot write the
 * result file, so its result is built from its output file and the operation's `then`; a Claude
 * stand-in for it gets the same output file, written from its structured output.
 */
export async function collectRun(job: JobRecord, op: OperationSpec, runDir: string, exit: ExitInfo): Promise<Collected> {
  const threadId = op.engine === 'codex' ? await readCodexThread(runDir) : undefined;
  const collected = (result: OperationResult, contractProvided = false): Collected => ({ exit, result, ...(threadId ? { threadId } : {}), ...(contractProvided ? { contractProvided: true } : {}) });
  if (exit.timedOut) return collected(failed(`timed out after ${Math.round(op.timeoutMs / 1000)}s`, true));
  if (exit.error) return collected(failed(`could not start: ${exit.error}`, false));

  if ((op.engine === 'codex' && !op.contractResult) || op.structuredOutput) {
    const outputPath = `${runDir}/output.json`;
    if (exit.exitCode !== 0) return collected(failed(`${op.engine} exited ${exit.exitCode ?? exit.signal}`, true));
    if (op.structuredOutput) {
      // A Claude stand-in for a codex schema operation: its structured output is the output Codex would have written.
      const structured = await readClaudeStructuredOutput(runDir);
      if (structured === undefined) return collected(failed('claude returned no structured output for the schema', true));
      await writeFile(outputPath, JSON.stringify(structured));
    }
    const output = await readText(outputPath);
    if (output === undefined || output.trim() === '') return collected(failed(`${op.engine} wrote no output`, true));
    if (op.schema) {
      try { JSON.parse(output); } catch { return collected(failed(`${op.engine} output is not the JSON its schema requires`, true)); }
    }
    const next = op.then ? [{ operation: op.then, subject: job.subject, input: { ...job.input, output: outputPath } }] : [];
    return collected({ contract: CONTRACT_VERSION, status: 'done', evidence: [outputPath], next });
  }

  const raw = await readText(runPath(runDir, 'result')) ?? (op.contractResult ? await readText(`${runDir}/output.json`) : undefined);
  if (raw === undefined) {
    return collected(failed(exit.exitCode === 0 ? 'exited 0 without writing a result file' : `exited ${exit.exitCode ?? exit.signal} without a result file`, false));
  }
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return collected(failed('result file is not valid JSON', false)); }
  const outcome = parseResult(parsed, job.subject);
  if (!outcome.ok) return collected(failed(`invalid result: ${outcome.errors.join('; ')}`, false));
  // An attended session ended or released after its result ended as intended, whatever signal it took.
  if (exit.exitCode !== 0 && !exit.closedAfterResult && !exit.released && outcome.value.status !== 'failed') {
    return collected(failed(`exited ${exit.exitCode ?? exit.signal} although the result says ${outcome.value.status}`, false, outcome.value.message));
  }
  return collected(outcome.value, true);
}

export async function readExit(runDir: string): Promise<ExitInfo | undefined> {
  return readJsonFile<ExitInfo>(runPath(runDir, 'exit'));
}
