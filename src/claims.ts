import { setTimeout as sleep } from 'node:timers/promises';
import { OperatorError } from './errors.ts';
import type { DocStore, LockStore, StoredDoc } from './state/types.ts';

/**
 * Subject claims. Who holds a subject is decided by the state backend's lock, which is atomic: of
 * two simultaneous takers exactly one acquires it. The record in this collection only describes the
 * holder - run, times and the lock token it renews and releases with - so a store whose document
 * writes race cannot make two runs hold one subject. It is the runtime's own collection, so
 * `operator state` cannot write it.
 */
export const CLAIMS_COLLECTION = 'subject-claims';
// A released or expired claim stays readable this long, so `show` can still say who held it.
const CLAIM_RETENTION_MS = 3_600_000;
/** A lock lives at most a day from its acquisition, so a lease is at most a day; renew it sooner. */
export const MAX_CLAIM_TTL_MS = 86_400_000;
// How long a renewal that only proves ownership before a release keeps the lock.
const PROVE_MS = 1000;
// A holder that just acquired writes its record right after; a reader waits this long for it.
const RECORD_WAIT_MS = [100, 250, 500];

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

/** The stored record also carries the lock token, which never leaves this module. */
interface StoredClaim extends ClaimRecord {
  token: string;
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
  if (!(ttlMs > 0) || ttlMs > MAX_CLAIM_TTL_MS) throw new OperatorError('INVALID_TTL', `a claim lease lasts at most 24h, got ${ttlMs}ms; renew it to keep it longer`);
  return ttlMs;
}

export function claimIsLive(claim: ClaimRecord, now: Date = new Date()): boolean {
  return claim.releasedAt === undefined && Date.parse(claim.expiresAt) > now.getTime();
}

export interface ClaimStore {
  docs: DocStore;
  locks: LockStore;
}

const lockKey = (subject: string): string => `claim.${subject}`;
const publicView = ({ token: _token, ...claim }: StoredClaim): ClaimRecord => claim;
const unknownHolder = (subject: string, now: Date): ClaimRecord => ({ subject, run: 'unknown', takenAt: now.toISOString(), renewedAt: now.toISOString(), expiresAt: now.toISOString() });

function checked(subject: string, run?: string, ttlMs?: number): void {
  checkKey(subject, 'subject', 'INVALID_SUBJECT');
  if (run !== undefined) checkKey(run, 'run id', 'INVALID_RUN_ID');
  if (ttlMs !== undefined) checkTtl(ttlMs);
}

async function readRecord(docs: DocStore, subject: string): Promise<StoredDoc<StoredClaim> | undefined> {
  return docs.get<StoredClaim>(CLAIMS_COLLECTION, subject);
}

async function writeRecord(docs: DocStore, record: StoredClaim, ttlMs: number): Promise<ClaimRecord> {
  await docs.replace(CLAIMS_COLLECTION, record.subject, record, { ttlMs: ttlMs + CLAIM_RETENTION_MS });
  return publicView(record);
}

/** The lock is held but its holder's record may not be written yet: wait briefly for it. */
async function holderOf(docs: DocStore, subject: string, now: Date): Promise<StoredDoc<StoredClaim> | undefined> {
  for (const wait of [0, ...RECORD_WAIT_MS]) {
    if (wait) await sleep(wait);
    const record = await readRecord(docs, subject);
    if (record && claimIsLive(record.value, now)) return record;
  }
  return undefined;
}

/** Acquires the subject's lock for `run` and records it; undefined when another run holds the lock. */
async function acquire(store: ClaimStore, subject: string, run: string, ttlMs: number, now: Date, takenAt?: string): Promise<ClaimRecord | undefined> {
  const lease = await store.locks.acquire(lockKey(subject), ttlMs, run);
  if (!lease.acquired) return undefined;
  const at = now.toISOString();
  return writeRecord(store.docs, { subject, run, token: lease.token, takenAt: takenAt ?? at, renewedAt: at, expiresAt: new Date(now.getTime() + ttlMs).toISOString() }, ttlMs);
}

/**
 * Extends `record`'s lock by its token. A lock past its lifetime is let go and acquired again, so a
 * holder keeps a subject longer than a day by renewing; another run that takes it in that instant wins.
 */
async function extend(store: ClaimStore, record: StoredClaim, ttlMs: number, now: Date): Promise<ClaimRecord | undefined> {
  const outcome = await store.locks.renew(lockKey(record.subject), record.token, ttlMs);
  if (outcome === 'renewed') {
    const at = now.toISOString();
    return writeRecord(store.docs, { ...record, renewedAt: at, expiresAt: new Date(now.getTime() + ttlMs).toISOString() }, ttlMs);
  }
  if (outcome === 'lifetime-exceeded') await store.locks.release(lockKey(record.subject));
  // Lost: the lock ran out. Nobody holding it now means this run may take it again.
  return acquire(store, record.subject, record.run, ttlMs, now, record.takenAt);
}

async function held(store: ClaimStore, subject: string, now: Date): Promise<ClaimResult> {
  const holder = await holderOf(store.docs, subject, now);
  return { ok: false, reason: 'held', holder: holder ? publicView(holder.value) : unknownHolder(subject, now) };
}

/**
 * Takes the subject for `run`: succeeds when nobody holds it, the holder's lease ran out, or `run`
 * already holds it (which renews it). The lock decides; of two simultaneous takers exactly one wins.
 */
export async function takeClaim(store: ClaimStore, subject: string, run: string, ttlMs: number, now: Date = new Date()): Promise<ClaimResult> {
  checked(subject, run, ttlMs);
  const taken = await acquire(store, subject, run, ttlMs, now);
  if (taken) return { ok: true, claim: taken };
  const record = await readRecord(store.docs, subject);
  if (record && record.value.run === run && record.value.releasedAt === undefined) {
    const renewed = await extend(store, record.value, ttlMs, now);
    if (renewed) return { ok: true, claim: renewed };
  }
  return held(store, subject, now);
}

/**
 * Extends the lease `run` holds; refused when another run holds the subject or nobody does. The
 * holder's own lease that ran out while nobody else took the subject is renewed too.
 */
export async function renewClaim(store: ClaimStore, subject: string, run: string, ttlMs: number, now: Date = new Date()): Promise<ClaimResult> {
  checked(subject, run, ttlMs);
  const record = await readRecord(store.docs, subject);
  if (!record || record.value.releasedAt !== undefined) return { ok: false, reason: 'absent' };
  if (record.value.run !== run) return { ok: false, reason: claimIsLive(record.value, now) ? 'held' : 'not-holder', holder: publicView(record.value) };
  const renewed = await extend(store, record.value, ttlMs, now);
  return renewed ? { ok: true, claim: renewed } : held(store, subject, now);
}

/**
 * Gives the subject up. The lock is deleted only after its token proved this run still holds it,
 * so a run whose lease already passed to another run never removes the new holder's lock; and the
 * record is marked released only if it is still this run's.
 */
export async function releaseClaim(store: ClaimStore, subject: string, run: string, now: Date = new Date()): Promise<ClaimResult> {
  checked(subject, run);
  const record = await readRecord(store.docs, subject);
  if (!record || record.value.releasedAt !== undefined) return { ok: false, reason: 'absent' };
  if (record.value.run !== run) return { ok: false, reason: 'not-holder', holder: publicView(record.value) };
  // Renewing by token proves the lock is still this run's (one past its lifetime is too); a lost
  // one has run out or passed on, and is left alone.
  if ((await store.locks.renew(lockKey(subject), record.value.token, PROVE_MS)) !== 'lost') await store.locks.release(lockKey(subject));
  const at = now.toISOString();
  const released: StoredClaim = { ...record.value, expiresAt: at, releasedAt: at };
  if ((await store.docs.replace(CLAIMS_COLLECTION, subject, released, { etag: record.etag, ttlMs: CLAIM_RETENTION_MS })) === 'conflict') {
    // The record changed meanwhile: a new holder wrote it, or this very release did and its answer
    // was lost. Only the second is this run's release.
    const current = await readRecord(store.docs, subject);
    if (!current || current.value.run !== run || current.value.releasedAt !== at) return { ok: false, reason: 'not-holder', holder: current ? publicView(current.value) : publicView(released) };
  }
  return { ok: true, claim: publicView(released) };
}

export async function showClaim(store: ClaimStore, subject: string, now: Date = new Date()): Promise<{ claim: ClaimRecord; live: boolean } | undefined> {
  checked(subject);
  const record = await readRecord(store.docs, subject);
  return record ? { claim: publicView(record.value), live: claimIsLive(record.value, now) } : undefined;
}

/** Every subject held right now. */
export async function liveClaims(store: ClaimStore, now: Date = new Date()): Promise<ClaimRecord[]> {
  return (await store.docs.list<StoredClaim>(CLAIMS_COLLECTION)).map((item) => publicView(item.value)).filter((claim) => claimIsLive(claim, now));
}
