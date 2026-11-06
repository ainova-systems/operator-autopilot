import { open } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { OperatorError } from './errors.ts';
import type { DocStore } from './state/types.ts';

export type Provider = 'claude' | 'codex';
export const DEFAULT_QUOTA_WAIT_MS = 4 * 60 * 60_000;
export const PROVIDER_COOLDOWNS = 'provider-cooldowns';
const TAIL_BYTES = 256 * 1024;

export interface QuotaWait {
  id: string;
  provider: Provider;
  detectedAt: string;
  until: string;
  reason: string;
  /** Provider-supplied reset time, rather than the four-hour default. */
  explicitReset: boolean;
}

export interface QuotaResume {
  id: string;
  state: 'pending' | 'sent';
  attempts: number;
  nextAttemptAt: string;
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function timestamp(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value < 100_000_000_000 ? value * 1000 : value;
  if (typeof value !== 'string') return undefined;
  if (/^\d{10,13}$/.test(value)) return timestamp(Number(value));
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** Resolves a wall-clock time with an explicit IANA timezone, as Claude prints its daily reset. */
function clockReset(text: string, now: number): number | undefined {
  const match = /resets?\s+(?:([A-Za-z]{3,9})\s+(\d{1,2})(?:,?\s+(\d{4}))?,\s*)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s*\(([^)]+)\)/i.exec(text);
  if (!match) return undefined;
  const hour = Number(match[4]);
  const minute = Number(match[5] ?? '0');
  if (hour < 1 || hour > 12 || minute > 59) return undefined;
  let formatter: Intl.DateTimeFormat;
  try { formatter = new Intl.DateTimeFormat('en-CA', { timeZone: match[7], year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }); } catch { return undefined; }
  const parts = (time: number): Record<string, number> => Object.fromEntries(formatter.formatToParts(new Date(time)).filter((part) => part.type !== 'literal').map((part) => [part.type, Number(part.value)]));
  const today = parts(now);
  const targetHour = hour % 12 + (match[6]?.toLowerCase() === 'pm' ? 12 : 0);
  const month = match[1] ? new Date(`${match[1]} 1, 2000 UTC`).getUTCMonth() : undefined;
  if (month !== undefined && !Number.isFinite(month)) return undefined;
  for (let day = 0; day < 2; day += 1) {
    const wall = month === undefined
      ? Date.UTC(today['year']!, today['month']! - 1, today['day']! + day, targetHour, minute)
      : Date.UTC(Number(match[3] ?? today['year']) + (match[3] ? 0 : day), month, Number(match[2]), targetHour, minute);
    let candidate = wall;
    for (let pass = 0; pass < 3; pass += 1) {
      const local = parts(candidate);
      const displayed = Date.UTC(local['year']!, local['month']! - 1, local['day']!, local['hour']!, local['minute']!, local['second']!);
      candidate += wall - displayed;
    }
    if (candidate > now || match[3]) return candidate;
  }
  return undefined;
}

function resetTime(event: Record<string, unknown>, text: string, now: number, timeZone: string): number | undefined {
  for (const key of ['resetsAt', 'resets_at', 'reset_at']) {
    const value = timestamp(event[key]);
    if (value !== undefined) return value;
  }
  const iso = /(?:resets?(?: at)?|try again at)\s+(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2}))/i.exec(text);
  const parsed = timestamp(iso?.[1]);
  if (parsed !== undefined) return parsed;
  const codex = /try again at ([A-Za-z]{3,9} \d{1,2}(?:st|nd|rd|th)?, \d{4} \d{1,2}:\d{2} [AP]M)/i.exec(text);
  const rendered = codex?.[1]?.replace(/(\d)(?:st|nd|rd|th)/, '$1').replace(/(\d{4}) /, '$1, ');
  const local = rendered ? clockReset(`resets ${rendered} (${timeZone})`, now) : undefined;
  if (local !== undefined) return local;
  return clockReset(text, now);
}

const USAGE_MESSAGE = /^(?:Error:\s*)?(?:You(?:'|’)?ve hit your (?:(?:usage|weekly|monthly) )?limit|You have hit your (?:(?:usage|weekly|monthly) )?limit|Your (?:usage|weekly|monthly) limit (?:has been |was )?reached|Usage limit (?:reached|exceeded))/i;

/** Only provider protocol error records count; user/assistant prose and tool output never do. */
export function quotaFromEvent(value: unknown, provider: Provider, now = Date.now(), timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone): QuotaWait | undefined {
  const event = object(value);
  if (!event) return undefined;
  let detail: Record<string, unknown> = event;
  let message = '';
  if (provider === 'claude') {
    if (event['type'] === 'rate_limit_event') {
      const info = object(event['rate_limit_info']);
      if (!info || info['status'] !== 'rejected') return undefined;
      detail = info;
      message = 'Claude usage limit rejected';
    } else if (event['type'] === 'assistant' && event['isApiErrorMessage'] === true && event['error'] === 'rate_limit') {
      const content = object(event['message'])?.['content'];
      if (!Array.isArray(content)) return undefined;
      message = content.map((item: unknown) => { const part = object(item); return part?.['type'] === 'text' && typeof part['text'] === 'string' ? part['text'] : ''; }).join('');
      if (!USAGE_MESSAGE.test(message)) return undefined;
    } else return undefined;
  } else {
    const error = event['type'] === 'turn.failed' ? object(event['error']) : event['type'] === 'error' ? event : undefined;
    if (!error) return undefined;
    const nested = object(error['error']);
    detail = nested ?? error;
    message = typeof error['message'] === 'string' ? error['message'] : typeof detail['message'] === 'string' ? detail['message'] : '';
    const code = detail['code'] ?? detail['type'];
    if (code !== 'usage_limit_reached' && !USAGE_MESSAGE.test(message)) return undefined;
    if (!message) message = 'Codex usage limit reached';
  }
  const supplied = ['resetsAt', 'resets_at', 'reset_at'].map((key) => timestamp(detail[key])).find((value) => value !== undefined);
  if (supplied !== undefined && supplied <= now) return undefined;
  const reset = resetTime(detail, message, now, timeZone);
  if (reset !== undefined && reset <= now) return undefined;
  const until = new Date(reset ?? now + DEFAULT_QUOTA_WAIT_MS).toISOString();
  // Repeated rejected notifications for one window have the same identity even without a reset.
  const id = createHash('sha256').update(`${provider}:${reset === undefined ? `unspecified:${now}` : until}`).digest('hex').slice(0, 24);
  return { id, provider, detectedAt: new Date(now).toISOString(), until, reason: `${provider} usage limit`, explicitReset: reset !== undefined };
}

/** Reads a bounded tail, dropping a partial first line when truncated. */
export async function readEventTail(path: string, since = 0): Promise<{ text: string; size: number; completeText: string; completeSize: number }> {
  let file;
  try { file = await open(path, 'r'); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { text: '', size: 0, completeText: '', completeSize: since }; throw error; }
  try {
    const size = (await file.stat()).size;
    const start = Math.max(since <= size ? since : 0, size - TAIL_BYTES);
    const bytes = Buffer.alloc(Math.max(0, size - start));
    const { bytesRead } = await file.read(bytes, 0, bytes.length, start);
    const read = bytes.subarray(0, bytesRead);
    const first = start > since ? read.indexOf(10) + 1 : 0;
    const end = read.lastIndexOf(10) + 1;
    const text = read.subarray(first).toString('utf8');
    return { text, size, completeText: read.subarray(first, Math.max(first, end)).toString('utf8'), completeSize: end > 0 ? start + end : start };

  } finally { await file.close(); }
}

export function quotaFromLines(text: string, provider: Provider, now = Date.now(), timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone): QuotaWait | undefined {
  let quota: QuotaWait | undefined;
  for (const line of text.split('\n')) {
    let event: unknown;
    try { event = JSON.parse(line); } catch { continue; }
    const found = quotaFromEvent(event, provider, now, timeZone);
    if (found && (!quota || found.explicitReset || !quota.explicitReset)) quota = found;
  }
  return quota;
}

/** A provider's cooldown record: one per host when the manifest names hosts, whose accounts and limits differ. */
export function cooldownKey(provider: Provider, host?: string): string {
  return host === undefined ? provider : `${provider}.${host}`;
}

export async function rememberQuota(docs: DocStore, quota: QuotaWait, host?: string): Promise<QuotaWait> {
  const key = cooldownKey(quota.provider, host);
  const ttlMs = Math.max(DEFAULT_QUOTA_WAIT_MS, Date.parse(quota.until) - Date.now()) + DEFAULT_QUOTA_WAIT_MS;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const existing = await docs.get<QuotaWait>(PROVIDER_COOLDOWNS, key);
    if (!existing) {
      if (await docs.create(PROVIDER_COOLDOWNS, key, quota, ttlMs) === 'created') return quota;
      continue;
    }
    const prior = existing.value;
    const observed = Date.parse(quota.detectedAt);
    const previous = Date.parse(prior.detectedAt);
    // Live runs replay their saved evidence. Arrival order is not observation order.
    if (observed < previous) return prior;
    if (observed === previous) {
      if (prior.explicitReset && !quota.explicitReset) return prior;
      if (prior.explicitReset === quota.explicitReset && Date.parse(quota.until) <= Date.parse(prior.until)) return prior;
    }
    // Repeated watchdog messages cannot slide the default window or discard a known reset.
    if (!quota.explicitReset && Date.parse(prior.until) > observed) return prior;
    if (await docs.replace(PROVIDER_COOLDOWNS, key, quota, { etag: existing.etag, missingIsConflict: true, ttlMs }) === 'written') return quota;
  }
  throw new OperatorError('STATE_CONTENTION', `provider ${quota.provider} cooldown kept changing under eight consecutive updates`);
}

export async function coolingProvider(docs: DocStore, provider: Provider, now: number, host?: string): Promise<QuotaWait | undefined> {
  const value = (await docs.get<QuotaWait>(PROVIDER_COOLDOWNS, cooldownKey(provider, host)))?.value;
  return value && Date.parse(value.until) > now ? value : undefined;
}
