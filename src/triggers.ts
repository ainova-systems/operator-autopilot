import { randomUUID } from 'node:crypto';
import type { JsonObject } from './contract.ts';
import { OperatorError } from './errors.ts';
import { enqueue, type JobStore } from './jobs.ts';
import type { Manifest, TriggerSpec } from './manifest.ts';
import type { WaitStore } from './waits.ts';

export interface TimerFiring {
  workflow: string;
  trigger: Extract<TriggerSpec, { kind: 'every' | 'cron' }>;
  triggerId: string;
}

/**
 * The timer slots due at `now`. An interval fires once per aligned slot; a cron fires once per
 * matching minute. Missed slots are not replayed, and the slot id makes a repeat a duplicate.
 */
export function dueFirings(manifest: Manifest, now: Date): TimerFiring[] {
  const firings: TimerFiring[] = [];
  for (const workflow of manifest.workflows.values()) {
    if (!workflow.enabled) continue;
    for (const trigger of workflow.triggers) {
      if (trigger.kind === 'every') {
        const slot = new Date(Math.floor(now.getTime() / trigger.intervalMs) * trigger.intervalMs);
        firings.push({ workflow: workflow.name, trigger, triggerId: `every:${trigger.index}:${slot.toISOString()}` });
      } else if (trigger.kind === 'cron') {
        const minute = new Date(Math.floor(now.getTime() / 60_000) * 60_000);
        if (trigger.schedule.matches(minute)) firings.push({ workflow: workflow.name, trigger, triggerId: `cron:${trigger.index}:${minute.toISOString()}` });
      }
    }
  }
  return firings;
}

export interface TriggerRequest {
  workflow: string;
  name: string;
  subject: string;
  input: JsonObject;
  key?: string;
  id?: string;
}

export interface TriggerResult {
  resumed: { waitId: string; jobId: string; created: boolean }[];
  started?: { jobId: string; created: boolean };
}

/**
 * Delivers a named trigger: first to the open waits it answers, otherwise to the workflow's `on`
 * trigger of that name. A wait is resumed at most once, because its resume job id derives from it.
 */
export async function fireTrigger(manifest: Manifest, jobs: JobStore, waits: WaitStore, request: TriggerRequest): Promise<TriggerResult> {
  const workflow = manifest.workflows.get(request.workflow);
  if (!workflow) throw new OperatorError('UNKNOWN_WORKFLOW', `no workflow ${JSON.stringify(request.workflow)} in ${manifest.path}`);
  if (!workflow.enabled) throw new OperatorError('WORKFLOW_DISABLED', `workflow ${workflow.name} is disabled`);
  const result: TriggerResult = { resumed: [] };
  const now = Date.now();
  const candidates = await waits.listOpen({ workflow: workflow.name, on: request.name, subject: request.subject });
  for (const wait of candidates) {
    if (wait.key !== undefined && wait.key !== request.key) continue;
    if (wait.expiresAt && Date.parse(wait.expiresAt) <= now) continue;
    if (!workflow.operations.has(wait.resume)) throw new OperatorError('UNKNOWN_OPERATION', `wait ${wait.id} resumes ${wait.resume}, which workflow ${workflow.name} does not define`);
    const job = await enqueue(jobs, {
      project: manifest.project,
      workflow: workflow.name,
      operation: wait.resume,
      subject: wait.subject,
      input: { ...wait.input, ...request.input },
      trigger: { id: `wait:${wait.id}`, name: request.name, kind: 'resume' },
    });
    await waits.close(wait.id, 'resolved', job.id);
    result.resumed.push({ waitId: wait.id, jobId: job.id, created: job.created });
  }
  if (result.resumed.length > 0) return result;
  const on = workflow.triggers.find((trigger) => trigger.kind === 'on' && trigger.name === request.name);
  if (!on) throw new OperatorError('NO_MATCH', `trigger ${request.name} for subject ${JSON.stringify(request.subject)} matched no open wait and no "on: ${request.name}" trigger in workflow ${workflow.name}`);
  const job = await enqueue(jobs, {
    project: manifest.project,
    workflow: workflow.name,
    operation: on.run,
    subject: request.subject,
    input: request.input,
    trigger: { id: request.id ?? randomUUID(), name: request.name, kind: 'cli' },
  });
  result.started = { jobId: job.id, created: job.created };
  return result;
}
