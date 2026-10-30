import { OperatorError } from './errors.ts';
import type { DocStore } from './state/types.ts';

/** Subject claims: the runtime's own collection, so `operator state` cannot write past the CAS. */
export const CLAIMS_COLLECTION = 'subject-claims';
// A released or expired claim stays readable this long, so `show` can still say who held it.
const CLAIM_RETENTION_MS = 3_600_000;
const CAS_ATTEMPTS = 5;

/**
 * Who holds a subject, until when. A claim is a lease: it counts only while `expiresAt` is in the
 * future, and a released one is an expired one. The subject is opaque to the runtime.
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

export function claimIsLive(claim: ClaimRecord, now: Date = new Date()): boolean {
  return claim.releasedAt === undefined && Date.parse(claim.expiresAt) > now.getTime();
}

function checkRun(run: string): string {
  if (!/^[A-Za-z0-9._:-]{1,120}$/.test(run)) throw new OperatorError('INVALID_RUN_ID', `run id ${JSON.stringify(run)} may only use letters, digits, '.', '_', ':' and '-'`);
  return run;
}

const storeTtl = (ttlMs: number): number => ttlMs + CLAIM_RETENTION_MS;

/**
 * Takes the subject for `run`: succeeds when nobody holds it, the holder's lease ran out, or `run`
 * already holds it (which renews it). Every write is compare-and-set, so two takers never both win.
 */
export async function takeClaim(docs: DocStore, subject: string, run: string, ttlMs: number, now: Date = new Date()): Promise<ClaimResult> {
  checkRun(run);
  const at = now.toISOString();
  const expiresAt = new Date(now.getTime() + ttlMs).toISOString();
  for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt += 1) {
    const current = await docs.get<ClaimRecord>(CLAIMS_COLLECTION, subject);
    if (current && claimIsLive(current.value, now) && current.value.run !== run) return { ok: false, reason: 'held', holder: current.value };
    const sameRun = current !== undefined && claimIsLive(current.value, now) && current.value.run === run;
    const claim: ClaimRecord = { subject, run, takenAt: sameRun ? current.value.takenAt : at, renewedAt: at, expiresAt };
    const outcome = current
      ? await docs.replace(CLAIMS_COLLECTION, subject, claim, { etag: current.etag, ttlMs: storeTtl(ttlMs) })
      : (await docs.create(CLAIMS_COLLECTION, subject, claim, storeTtl(ttlMs))) === 'created' ? 'written' : 'conflict';
    if (outcome === 'written') return { ok: true, claim };
  }
  throw new OperatorError('CLAIM_CONTENDED', `subject ${subject}: the claim kept changing under ${CAS_ATTEMPTS} attempts`);
}

/** Extends the lease `run` holds; refused when another run holds the subject or nobody does. */
export async function renewClaim(docs: DocStore, subject: string, run: string, ttlMs: number, now: Date = new Date()): Promise<ClaimResult> {
  checkRun(run);
  for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt += 1) {
    const current = await docs.get<ClaimRecord>(CLAIMS_COLLECTION, subject);
    if (!current || current.value.releasedAt !== undefined) return { ok: false, reason: 'absent' };
    if (current.value.run !== run) return { ok: false, reason: claimIsLive(current.value, now) ? 'held' : 'not-holder', holder: current.value };
    // The holder's own lease that ran out unclaimed is renewed: nobody took the subject meanwhile.
    const claim: ClaimRecord = { ...current.value, renewedAt: now.toISOString(), expiresAt: new Date(now.getTime() + ttlMs).toISOString() };
    if ((await docs.replace(CLAIMS_COLLECTION, subject, claim, { etag: current.etag, ttlMs: storeTtl(ttlMs) })) === 'written') return { ok: true, claim };
  }
  throw new OperatorError('CLAIM_CONTENDED', `subject ${subject}: the claim kept changing under ${CAS_ATTEMPTS} attempts`);
}

/**
 * Gives the subject up. Releasing is a compare-and-set write of an ended lease, not a delete, so a
 * run whose lease already passed to another run cannot remove the new holder's claim.
 */
export async function releaseClaim(docs: DocStore, subject: string, run: string, now: Date = new Date()): Promise<ClaimResult> {
  checkRun(run);
  for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt += 1) {
    const current = await docs.get<ClaimRecord>(CLAIMS_COLLECTION, subject);
    if (!current || current.value.releasedAt !== undefined) return { ok: false, reason: 'absent' };
    if (current.value.run !== run) return { ok: false, reason: 'not-holder', holder: current.value };
    const at = now.toISOString();
    const claim: ClaimRecord = { ...current.value, expiresAt: at, releasedAt: at };
    if ((await docs.replace(CLAIMS_COLLECTION, subject, claim, { etag: current.etag, ttlMs: CLAIM_RETENTION_MS })) === 'written') return { ok: true, claim };
  }
  throw new OperatorError('CLAIM_CONTENDED', `subject ${subject}: the claim kept changing under ${CAS_ATTEMPTS} attempts`);
}

export async function showClaim(docs: DocStore, subject: string, now: Date = new Date()): Promise<{ claim: ClaimRecord; live: boolean } | undefined> {
  const current = await docs.get<ClaimRecord>(CLAIMS_COLLECTION, subject);
  return current ? { claim: current.value, live: claimIsLive(current.value, now) } : undefined;
}

/** Every subject held right now. */
export async function liveClaims(docs: DocStore, now: Date = new Date()): Promise<ClaimRecord[]> {
  return (await docs.list<ClaimRecord>(CLAIMS_COLLECTION)).map((item) => item.value).filter((claim) => claimIsLive(claim, now));
}
