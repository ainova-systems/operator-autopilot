import { OperatorError } from './errors.ts';
import type { DocStore } from './state/types.ts';

/** Subject claims: the runtime's own collection, so `operator state` cannot write past the CAS. */
export const CLAIMS_COLLECTION = 'subject-claims';
// A released or expired claim stays readable this long, so `show` can still say who held it.
const CLAIM_RETENTION_MS = 3_600_000;
const CAS_ATTEMPTS = 5;
/** The longest lease a claim may ask for; a claim is renewed, never taken for ever. */
export const MAX_CLAIM_TTL_MS = 30 * 86_400_000;

/**
 * Who holds a subject, until when. A claim is a lease: it counts only while `expiresAt` is in the
 * future, and a released one is an expired one. The subject is opaque to the runtime. Expiry is
 * judged by the clock of whoever reads it, so the hosts sharing a namespace keep their clocks in sync.
 */
export interface ClaimRecord {
  subject: string;
  run: string;
  takenAt: string;
  renewedAt: string;
  expiresAt: string;
  releasedAt?: string;
}

export type ClaimResult =
  | { ok: true; claim: ClaimRecord }
  | { ok: false; reason: 'held' | 'not-holder'; holder: ClaimRecord }
  | { ok: false; reason: 'absent' };

/** Subjects and run ids become state keys, so they keep to the characters every provider accepts. */
export function isStateKey(value: string): boolean {
  return /^[A-Za-z0-9._:-]{1,120}$/.test(value) && !/^\.+$/.test(value);
}

function checkKey(value: string, what: string, code: string): string {
  if (!isStateKey(value)) throw new OperatorError(code, `${what} ${JSON.stringify(value)} may only use letters, digits, '.', '_', ':' and '-' (at most 120)`);
  return value;
}

export function checkTtl(ttlMs: number): number {
  if (!(ttlMs > 0) || ttlMs > MAX_CLAIM_TTL_MS) throw new OperatorError('INVALID_TTL', `a claim lasts at most 30d, got ${ttlMs}ms`);
  return ttlMs;
}

export function claimIsLive(claim: ClaimRecord, now: Date = new Date()): boolean {
  return claim.releasedAt === undefined && Date.parse(claim.expiresAt) > now.getTime();
}

const storeTtl = (ttlMs: number): number => ttlMs + CLAIM_RETENTION_MS;
const contended = (subject: string): OperatorError => new OperatorError('CLAIM_CONTENDED', `subject ${subject}: the claim kept changing under ${CAS_ATTEMPTS} attempts`);

/**
 * Takes the subject for `run`: succeeds when nobody holds it, the holder's lease ran out, or `run`
 * already holds it (which renews it). Every write is compare-and-set, so two takers never both win,
 * and a write the store reports lost but made is found on the next read as this run's own.
 */
export async function takeClaim(docs: DocStore, subject: string, run: string, ttlMs: number, now: Date = new Date()): Promise<ClaimResult> {
  checkKey(subject, 'subject', 'INVALID_SUBJECT');
  checkKey(run, 'run id', 'INVALID_RUN_ID');
  checkTtl(ttlMs);
  const at = now.toISOString();
  const expiresAt = new Date(now.getTime() + ttlMs).toISOString();
  let recovered = false;
  for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt += 1) {
    const current = await docs.get<ClaimRecord>(CLAIMS_COLLECTION, subject);
    if (current && claimIsLive(current.value, now) && current.value.run !== run) return { ok: false, reason: 'held', holder: current.value };
    const sameRun = current !== undefined && claimIsLive(current.value, now) && current.value.run === run;
    const claim: ClaimRecord = { subject, run, takenAt: sameRun ? current.value.takenAt : at, renewedAt: at, expiresAt };
    let outcome: 'written' | 'conflict';
    if (current) {
      outcome = await docs.replace(CLAIMS_COLLECTION, subject, claim, { etag: current.etag, ttlMs: storeTtl(ttlMs) });
    } else {
      try {
        outcome = (await docs.create(CLAIMS_COLLECTION, subject, claim, storeTtl(ttlMs))) === 'created' ? 'written' : 'conflict';
      } catch (error) {
        // A store may answer the loser of two simultaneous creates with an error instead of a
        // conflict. Once, a record that is there now is read like any other; none there is a failure.
        if (recovered || !(await docs.get<ClaimRecord>(CLAIMS_COLLECTION, subject))) throw error;
        recovered = true;
        outcome = 'conflict';
      }
    }
    if (outcome === 'written') return { ok: true, claim };
  }
  throw contended(subject);
}

/**
 * Extends the lease `run` holds; refused when another run holds the subject or nobody does. The
 * holder's own lease that ran out while nobody else took the subject is renewed too.
 */
export async function renewClaim(docs: DocStore, subject: string, run: string, ttlMs: number, now: Date = new Date()): Promise<ClaimResult> {
  checkKey(subject, 'subject', 'INVALID_SUBJECT');
  checkKey(run, 'run id', 'INVALID_RUN_ID');
  checkTtl(ttlMs);
  for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt += 1) {
    const current = await docs.get<ClaimRecord>(CLAIMS_COLLECTION, subject);
    if (!current || current.value.releasedAt !== undefined) return { ok: false, reason: 'absent' };
    if (current.value.run !== run) return { ok: false, reason: claimIsLive(current.value, now) ? 'held' : 'not-holder', holder: current.value };
    const claim: ClaimRecord = { ...current.value, renewedAt: now.toISOString(), expiresAt: new Date(now.getTime() + ttlMs).toISOString() };
    if ((await docs.replace(CLAIMS_COLLECTION, subject, claim, { etag: current.etag, ttlMs: storeTtl(ttlMs) })) === 'written') return { ok: true, claim };
  }
  throw contended(subject);
}

/**
 * Gives the subject up. Releasing is a compare-and-set write of an ended lease, not a delete, so a
 * run whose lease already passed to another run cannot remove the new holder's claim.
 */
export async function releaseClaim(docs: DocStore, subject: string, run: string, now: Date = new Date()): Promise<ClaimResult> {
  checkKey(subject, 'subject', 'INVALID_SUBJECT');
  checkKey(run, 'run id', 'INVALID_RUN_ID');
  const at = now.toISOString();
  for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt += 1) {
    const current = await docs.get<ClaimRecord>(CLAIMS_COLLECTION, subject);
    // This call's own release, which the store reported lost after it was made.
    if (attempt > 0 && current?.value.run === run && current.value.releasedAt === at) return { ok: true, claim: current.value };
    if (!current || current.value.releasedAt !== undefined) return { ok: false, reason: 'absent' };
    if (current.value.run !== run) return { ok: false, reason: 'not-holder', holder: current.value };
    const claim: ClaimRecord = { ...current.value, expiresAt: at, releasedAt: at };
    if ((await docs.replace(CLAIMS_COLLECTION, subject, claim, { etag: current.etag, ttlMs: CLAIM_RETENTION_MS })) === 'written') return { ok: true, claim };
  }
  throw contended(subject);
}

export async function showClaim(docs: DocStore, subject: string, now: Date = new Date()): Promise<{ claim: ClaimRecord; live: boolean } | undefined> {
  checkKey(subject, 'subject', 'INVALID_SUBJECT');
  const current = await docs.get<ClaimRecord>(CLAIMS_COLLECTION, subject);
  return current ? { claim: current.value, live: claimIsLive(current.value, now) } : undefined;
}

/** Every subject held right now. */
export async function liveClaims(docs: DocStore, now: Date = new Date()): Promise<ClaimRecord[]> {
  return (await docs.list<ClaimRecord>(CLAIMS_COLLECTION)).map((item) => item.value).filter((claim) => claimIsLive(claim, now));
}
