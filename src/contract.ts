/**
 * The operation contract, version 1: the input file the runtime writes for every run and the result
 * file every operation writes back. The runtime treats subjects and input values as opaque.
 */
export const CONTRACT_VERSION = 1;

export type JsonObject = Record<string, unknown>;

export type ResultStatus = 'done' | 'noop' | 'waiting' | 'needs-input' | 'failed';

export const RESULT_STATUSES: readonly ResultStatus[] = ['done', 'noop', 'waiting', 'needs-input', 'failed'];

/** A follow-on operation requested by a result. */
export interface NextRequest {
  operation: string;
  subject: string;
  input: JsonObject;
  notBefore?: string;
  /** Requests with the same operation, subject and key are one job, whichever result sent them. */
  key?: string;
}

/** What a later trigger must look like to resume a waiting operation, and what it resumes. */
export interface WaitDescriptor {
  /** Trigger name, as passed to `operator trigger <workflow> <name>`. */
  on: string;
  subject: string;
  /** Optional discriminator, for example a question id; a trigger must carry the same key. */
  key?: string;
  /** Operation started when the wait is matched. */
  resume: string;
  /** Pointers handed to the resumed operation, merged under the trigger's own input. */
  input: JsonObject;
  expiresAt?: string;
}

export interface OperationResult {
  contract: typeof CONTRACT_VERSION;
  status: ResultStatus;
  message?: string;
  evidence: string[];
  next: NextRequest[];
  wait?: WaitDescriptor;
  failure?: { reason: string; retryable: boolean };
}

export interface OperationInput {
  contract: typeof CONTRACT_VERSION;
  run: { id: string; jobId: string; project: string; workflow: string; operation: string; attempt: number };
  subject: string;
  input: JsonObject;
  trigger: { id: string; name: string; kind: TriggerKind };
  resultPath: string;
  dryRun: boolean;
  agent?: { engine: string; skill?: string; agent?: string; outputPath?: string };
}

export type TriggerKind = 'timer' | 'cli' | 'next' | 'resume' | 'manual';

export type ParseOutcome<T> = { ok: true; value: T } | { ok: false; errors: string[] };

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isIsoDate(value: unknown): value is string {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}

/** Validates a parsed result file. Unknown fields are ignored; missing optional lists default to empty. */
export function parseResult(raw: unknown, defaultSubject: string): ParseOutcome<OperationResult> {
  const errors: string[] = [];
  if (!isObject(raw)) return { ok: false, errors: ['result: expected a JSON object'] };
  if (raw['contract'] !== CONTRACT_VERSION) errors.push(`contract: expected ${CONTRACT_VERSION}, got ${JSON.stringify(raw['contract'])}`);
  const status = raw['status'];
  if (typeof status !== 'string' || !RESULT_STATUSES.includes(status as ResultStatus)) {
    errors.push(`status: expected one of ${RESULT_STATUSES.join(', ')}, got ${JSON.stringify(status)}`);
  }
  const message = raw['message'];
  if (message !== undefined && typeof message !== 'string') errors.push('message: expected a string');

  const evidence: string[] = [];
  if (raw['evidence'] !== undefined) {
    if (!Array.isArray(raw['evidence']) || raw['evidence'].some((item) => typeof item !== 'string')) errors.push('evidence: expected an array of strings');
    else evidence.push(...(raw['evidence'] as string[]));
  }

  const next: NextRequest[] = [];
  if (raw['next'] !== undefined) {
    if (!Array.isArray(raw['next'])) errors.push('next: expected an array');
    else raw['next'].forEach((item: unknown, index: number) => {
      const path = `next[${index}]`;
      if (!isObject(item)) { errors.push(`${path}: expected an object`); return; }
      const operation = item['operation'];
      const subject = item['subject'] ?? defaultSubject;
      const input = item['input'] ?? {};
      const notBefore = item['notBefore'];
      const key = item['key'];
      if (typeof operation !== 'string' || operation === '') errors.push(`${path}.operation: expected a non-empty string`);
      if (typeof subject !== 'string') errors.push(`${path}.subject: expected a string`);
      if (!isObject(input)) errors.push(`${path}.input: expected an object`);
      if (notBefore !== undefined && !isIsoDate(notBefore)) errors.push(`${path}.notBefore: expected an ISO 8601 date`);
      if (key !== undefined && (typeof key !== 'string' || key === '' || key.length > 200)) errors.push(`${path}.key: expected a string of 1 to 200 characters`);
      if (typeof operation === 'string' && operation !== '' && typeof subject === 'string' && isObject(input)) {
        next.push({ operation, subject, input, ...(typeof notBefore === 'string' ? { notBefore } : {}), ...(typeof key === 'string' && key !== '' ? { key } : {}) });
      }
    });
  }

  let wait: WaitDescriptor | undefined;
  if (status === 'waiting' || status === 'needs-input') {
    const rawWait = raw['wait'];
    if (!isObject(rawWait)) errors.push(`wait: required when status is ${String(status)}`);
    else {
      const on = rawWait['on'];
      const subject = rawWait['subject'] ?? defaultSubject;
      const key = rawWait['key'];
      const resume = rawWait['resume'];
      const input = rawWait['input'] ?? {};
      const expiresAt = rawWait['expiresAt'];
      if (typeof on !== 'string' || on === '') errors.push('wait.on: expected a non-empty trigger name');
      if (typeof subject !== 'string') errors.push('wait.subject: expected a string');
      if (key !== undefined && (typeof key !== 'string' || key === '')) errors.push('wait.key: expected a non-empty string');
      if (typeof resume !== 'string' || resume === '') errors.push('wait.resume: expected a non-empty operation name');
      if (!isObject(input)) errors.push('wait.input: expected an object');
      if (expiresAt !== undefined && !isIsoDate(expiresAt)) errors.push('wait.expiresAt: expected an ISO 8601 date');
      if (typeof on === 'string' && typeof subject === 'string' && typeof resume === 'string' && isObject(input)) {
        wait = { on, subject, resume, input, ...(typeof key === 'string' ? { key } : {}), ...(typeof expiresAt === 'string' ? { expiresAt } : {}) };
      }
    }
  }

  let failure: OperationResult['failure'];
  if (status === 'failed') {
    const rawFailure = raw['failure'];
    if (!isObject(rawFailure) || typeof rawFailure['reason'] !== 'string' || rawFailure['reason'] === '') {
      errors.push('failure.reason: required when status is failed');
    } else {
      failure = { reason: rawFailure['reason'], retryable: rawFailure['retryable'] === true };
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      contract: CONTRACT_VERSION,
      status: status as ResultStatus,
      evidence,
      next,
      ...(typeof message === 'string' ? { message } : {}),
      ...(wait ? { wait } : {}),
      ...(failure ? { failure } : {}),
    },
  };
}
