import { readFile } from 'node:fs/promises';
import { CONTRACT_VERSION, parseResult, type OperationResult } from './contract.ts';
import { findCodexThread } from './engines.ts';
import type { JobRecord } from './jobs.ts';
import type { OperationSpec } from './manifest.ts';
import { readJsonFile, runPath, type ExitInfo } from './runfiles.ts';

export interface Collected {
  exit: ExitInfo;
  result: OperationResult;
  threadId?: string;
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

/**
 * Turns a finished run into a contract result. Exit status and a valid result file together prove
 * the run executed; an exit of 0 alone never counts as success. A Codex run cannot write the
 * result file, so its result is built from its output file and the operation's `then`.
 */
export async function collectRun(job: JobRecord, op: OperationSpec, runDir: string, exit: ExitInfo): Promise<Collected> {
  if (exit.timedOut) return { exit, result: failed(`timed out after ${Math.round(op.timeoutMs / 1000)}s`, true) };
  if (exit.error) return { exit, result: failed(`could not start: ${exit.error}`, false) };

  if (op.engine === 'codex') {
    const outputPath = `${runDir}/output.json`;
    const log = (await readText(runPath(runDir, 'output'))) ?? '';
    const threadId = findCodexThread(log);
    const withThread = (result: OperationResult): Collected => ({ exit, result, ...(threadId ? { threadId } : {}) });
    if (exit.exitCode !== 0) return withThread(failed(`codex exited ${exit.exitCode ?? exit.signal}`, true));
    const output = await readText(outputPath);
    if (output === undefined || output.trim() === '') return withThread(failed('codex wrote no output', true));
    if (op.schema) {
      try { JSON.parse(output); } catch { return withThread(failed('codex output is not the JSON its schema requires', true)); }
    }
    const next = op.then ? [{ operation: op.then, subject: job.subject, input: { ...job.input, output: outputPath } }] : [];
    return withThread({ contract: CONTRACT_VERSION, status: 'done', evidence: [outputPath], next });
  }

  const raw = await readText(runPath(runDir, 'result'));
  if (raw === undefined) {
    return { exit, result: failed(exit.exitCode === 0 ? 'exited 0 without writing a result file' : `exited ${exit.exitCode ?? exit.signal} without a result file`, false) };
  }
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return { exit, result: failed('result file is not valid JSON', false) }; }
  const outcome = parseResult(parsed, job.subject);
  if (!outcome.ok) return { exit, result: failed(`invalid result: ${outcome.errors.join('; ')}`, false) };
  // An attended session ended or released after its result ended as intended, whatever signal it took.
  if (exit.exitCode !== 0 && !exit.closedAfterResult && !exit.released && outcome.value.status !== 'failed') {
    return { exit, result: failed(`exited ${exit.exitCode ?? exit.signal} although the result says ${outcome.value.status}`, false, outcome.value.message) };
  }
  return { exit, result: outcome.value };
}

export async function readExit(runDir: string): Promise<ExitInfo | undefined> {
  return readJsonFile<ExitInfo>(runPath(runDir, 'exit'));
}
