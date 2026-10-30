import { setTimeout as sleep } from 'node:timers/promises';
import { OperatorError } from './errors.ts';
import type { DocStore, LockStore, StoredDoc } from './state/types.ts';

/**
 * Subject claims. Who holds a subject is decided by the state backend's lock, which is atomic: of
 * two simultaneous takers exactly one acquires it. The record in this collection only describes the
 * holder - run, times and the lock token it renews and ends with - and its expiry is advisory. It is
 * the runtime's own collection, so `operator state` cannot write it and never prints the token.
 */
export const CLAIMS_COLLECTION = 'subject-claims';
// A released or expired claim stays readable this long, so `show` can still say who held it.
const CLAIM_RETENTION_MS = 3_600_000;
/** A lock lives at most a day from its acquisition, so a lease is at most a day; renew it sooner. */
export const MAX_CLAIM_TTL_MS = 86_400_000;
// The shortest lease the lock takes. Ending a claim shortens its lock to this by token and lets it
// lapse: the backend has no token-checked delete, and a delete by key could remove the next holder's.
const END_MS = 1000;
// The lock's own day starts when the backend acquired it, a moment before this host stamped
// `lockedAt`; renewals stay this far inside the day so they never ask past its real end.
const DEADLINE_MARGIN_MS = 5000;
// A holder that just acquired writes its record right after; a reader waits this long for it.
const RECORD_WAIT_MS = [100, 250, 500];

/**
 * Who holds a subject, until when. `expiresAt` is advisory: the lock decides. It is judged by the
 * clock of whoever reads it, so the hosts sharing a namespace keep their clocks in sync.
 */
export interface ClaimRecord {
  subject: string;
  run: string;
  takenAt: string;
  renewedAt: string;
  expiresAt: string;
  releasedAt?: string;
}

/** The stored record also carries the lock token and when that lock was acquired. */
interface StoredClaim extends ClaimRecord {
  token: string;
  lockedAt: string;
}

export type ClaimResult =
  | { ok: true; claim: ClaimRecord }
  /** `holder` is absent when the lock is held but no live record says by whom. */
  | { ok: false; reason: 'held'; holder?: ClaimRecord }
  | { ok: false; reason: 'not-holder'; holder: ClaimRecord }
  | { ok: false; reason: 'absent' };

export interface ClaimView {
  claim?: ClaimRecord;
  /** What the record says. */
  live: boolean;
  /** What the lock says; the two disagree only briefly, or after a crash between them. */
  locked: boolean;
}

/** Subjects and run ids become state keys, so they keep to the characters every provider accepts. */
export function isStateKey(value: string): boolean {
  return /^[A-Za-z0-9._:-]{1,120}$/.test(value) && !/^\.+$/.test(value);
}

function checkKey(value: string, what: string, code: string): string {
  if (!isStateKey(value)) throw new OperatorError(code, `${what} ${JSON.stringify(value)} may only use letters, digits, '.', '_', ':' and '-' (at most 120)`);
  return value;
}

/** A lease in whole seconds, as the lock counts it, so the record and the lock agree. */
export function checkTtl(ttlMs: number): number {
  if (!(ttlMs > 0) || ttlMs > MAX_CLAIM_TTL_MS) throw new OperatorError('INVALID_TTL', `a claim lease lasts at most 24h, got ${ttlMs}ms; renew it to keep it longer`);
  return Math.ceil(ttlMs / 1000) * 1000;
}

export function claimIsLive(claim: ClaimRecord, now: Date = new Date()): boolean {
  return claim.releasedAt === undefined && Date.parse(claim.expiresAt) > now.getTime();
}

export interface ClaimStore {
  docs: DocStore;
  locks: LockStore;
}

/** The time source; tests move it, everything else reads the wall clock when the answer arrives. */
export type Clock = () => Date;
const wallClock: Clock = () => new Date();

const lockKey = (subject: string): string => `claim.${subject}`;
const publicView = ({ token: _token, lockedAt: _lockedAt, ...claim }: StoredClaim): ClaimRecord => claim;

/** Strips what only this module may see from a stored record, for any reader of the collection. */
export function redactClaim(value: unknown): unknown {
  if (typeof value !== 'object' || value === null) return value;
  const { token: _token, ...rest } = value as Record<string, unknown>;
  return rest;
}

function checked(subject: string, run?: string): void {
  checkKey(subject, 'subject', 'INVALID_SUBJECT');
  if (run !== undefined) checkKey(run, 'run id', 'INVALID_RUN_ID');
}

async function readRecord(docs: DocStore, subject: string): Promise<StoredDoc<StoredClaim> | undefined> {
  return docs.get<StoredClaim>(CLAIMS_COLLECTION, subject);
}

/** A lease never outlives its lock, which ends a day after it was acquired. */
function expiry(lockedAt: string, at: Date, ttlMs: number): string {
  return new Date(Math.min(at.getTime() + ttlMs, Date.parse(lockedAt) + MAX_CLAIM_TTL_MS)).toISOString();
}

/** Ends a lock this run holds, by its token: shortened to the minimum, it lapses on its own. */
async function endLock(locks: LockStore, subject: string, token: string): Promise<boolean> {
  return (await locks.renew(lockKey(subject), token, END_MS)) !== 'lost';
}

/** Acquires the subject's lock for `run` and records it; undefined when another run holds the lock. */
async function acquire(store: ClaimStore, subject: string, run: string, ttlMs: number, clock: Clock, takenAt?: string): Promise<ClaimRecord | undefined> {
  const lease = await store.locks.acquire(lockKey(subject), ttlMs, run);
  if (!lease.acquired) return undefined;
  const at = clock();
  const lockedAt = at.toISOString();
  const record: StoredClaim = { subject, run, token: lease.token, lockedAt, takenAt: takenAt ?? lockedAt, renewedAt: lockedAt, expiresAt: expiry(lockedAt, at, ttlMs) };
  try {
    await store.docs.replace(CLAIMS_COLLECTION, subject, record, { ttlMs: ttlMs + CLAIM_RETENTION_MS });
  } catch (error) {
    // A lock nobody can name a holder for would block the subject for the whole lease.
    await endLock(store.locks, subject, lease.token).catch(() => undefined);
    throw error;
  }
  return publicView(record);
}

/**
 * Extends the lock of the record read at `etag` by its token, up to the end of the lock's one-day
 * life. A lock that ran out is acquired again only while nobody else holds it, keeping when the
 * claim was first taken. `released` means this run's own release ended the claim meanwhile.
 */
async function extend(store: ClaimStore, record: StoredClaim, etag: string, ttlMs: number, clock: Clock): Promise<ClaimRecord | 'released' | undefined> {
  const started = clock();
  const room = Date.parse(record.lockedAt) + MAX_CLAIM_TTL_MS - DEADLINE_MARGIN_MS - started.getTime();
  if (room > END_MS) {
    const outcome = await store.locks.renew(lockKey(record.subject), record.token, Math.min(ttlMs, Math.floor(room / 1000) * 1000));
    if (outcome === 'renewed') {
      const at = clock();
      const renewed: StoredClaim = { ...record, renewedAt: at.toISOString(), expiresAt: new Date(Math.min(at.getTime() + ttlMs, Date.parse(record.lockedAt) + MAX_CLAIM_TTL_MS - DEADLINE_MARGIN_MS)).toISOString() };
      if ((await store.docs.replace(CLAIMS_COLLECTION, record.subject, renewed, { etag, ttlMs: ttlMs + CLAIM_RETENTION_MS, missingIsConflict: true })) === 'written') return publicView(renewed);
      // The record changed under this renewal. A release of this run ended the claim: the lock this
      // renewal just extended is ended again, so the release stands and nothing is resurrected.
      const current = await readRecord(store.docs, record.subject);
      if (current?.value.run === record.run && current.value.releasedAt !== undefined) {
        await endLock(store.locks, record.subject, record.token);
        return 'released';
      }
      if (!current) {
        // The record vanished: nobody could name this run as the holder, so the lock this renewal
        // extended must not keep the subject.
        await endLock(store.locks, record.subject, record.token);
        return undefined;
      }
      return current.value.run === record.run ? publicView(current.value) : undefined;
    }
    if (outcome === 'lifetime-exceeded') return undefined;
  } else if (await store.locks.exists(lockKey(record.subject))) {
    // The lock is at the end of its life and still stands: it lapses on its own, after which this
    // run takes the subject again like anyone else.
    return undefined;
  }
  return acquire(store, record.subject, record.run, ttlMs, clock, record.takenAt);
}

async function held(store: ClaimStore, subject: string, clock: Clock): Promise<ClaimResult> {
  for (const wait of [0, ...RECORD_WAIT_MS]) {
    if (wait) await sleep(wait);
    const record = await readRecord(store.docs, subject);
    if (record && claimIsLive(record.value, clock())) return { ok: false, reason: 'held', holder: publicView(record.value) };
  }
  return { ok: false, reason: 'held' };
}

/**
 * Takes the subject for `run`: succeeds when the lock is free, or when `run` already holds it
 * (which renews it). The lock decides; of two simultaneous takers exactly one wins. A lease just
 * released is waited for, since a released lock lapses a moment later.
 */
export async function takeClaim(store: ClaimStore, subject: string, run: string, ttlMs: number, clock: Clock = wallClock): Promise<ClaimResult> {
  checked(subject, run);
  const ttl = checkTtl(ttlMs);
  const taken = await acquire(store, subject, run, ttl, clock);
  if (taken) return { ok: true, claim: taken };
  const record = await readRecord(store.docs, subject);
  let justReleased = record?.value.releasedAt !== undefined && clock().getTime() - Date.parse(record.value.releasedAt) < 2 * END_MS;
  if (record && record.value.run === run && record.value.releasedAt === undefined) {
    const renewed = await extend(store, record.value, record.etag, ttl, clock);
    if (renewed === 'released') justReleased = true;
    else if (renewed) return { ok: true, claim: renewed };
  }
  if (justReleased) {
    await sleep(END_MS + 100);
    const retaken = await acquire(store, subject, run, ttl, clock);
    if (retaken) return { ok: true, claim: retaken };
  }
  return held(store, subject, clock);
}

/**
 * Extends the lease `run` holds; refused when another run holds the subject or nobody does. The
 * holder's own lease that ran out while nobody else took the subject is renewed too.
 */
export async function renewClaim(store: ClaimStore, subject: string, run: string, ttlMs: number, clock: Clock = wallClock): Promise<ClaimResult> {
  checked(subject, run);
  const ttl = checkTtl(ttlMs);
  const record = await readRecord(store.docs, subject);
  if (!record || record.value.releasedAt !== undefined) return { ok: false, reason: 'absent' };
  if (record.value.run !== run) return claimIsLive(record.value, clock()) ? { ok: false, reason: 'held', holder: publicView(record.value) } : { ok: false, reason: 'not-holder', holder: publicView(record.value) };
  const renewed = await extend(store, record.value, record.etag, ttl, clock);
  if (renewed === 'released') return { ok: false, reason: 'absent' };
  return renewed ? { ok: true, claim: renewed } : held(store, subject, clock);
}

/**
 * Gives the subject up. The lock is ended by its token, so a run whose lease already passed to
 * another run never touches the new holder's lock; once that end succeeded the release did, and
 * the record is marked released only if it is still this run's.
 */
export async function releaseClaim(store: ClaimStore, subject: string, run: string, clock: Clock = wallClock): Promise<ClaimResult> {
  checked(subject, run);
  const record = await readRecord(store.docs, subject);
  if (!record || record.value.releasedAt !== undefined) return { ok: false, reason: 'absent' };
  if (record.value.run !== run) return { ok: false, reason: 'not-holder', holder: publicView(record.value) };
  const ended = await endLock(store.locks, subject, record.value.token);
  const at = clock().toISOString();
  const released: StoredClaim = { ...record.value, expiresAt: at, releasedAt: at };
  const written = await store.docs.replace(CLAIMS_COLLECTION, subject, released, { etag: record.etag, ttlMs: CLAIM_RETENTION_MS, missingIsConflict: true });
  if (written === 'written' || ended) return { ok: true, claim: publicView(released) };
  // Neither the lock nor the record was this run's any more: another run holds the subject now.
  const current = await readRecord(store.docs, subject);
  return { ok: false, reason: 'not-holder', holder: current ? publicView(current.value) : publicView(released) };
}

/** The record and what the lock says; a disagreement means a holder mid-write or a crash between them. */
export async function showClaim(store: ClaimStore, subject: string, clock: Clock = wallClock): Promise<ClaimView> {
  checked(subject);
  const record = await readRecord(store.docs, subject);
  const locked = await store.locks.exists(lockKey(subject));
  return record ? { claim: publicView(record.value), live: claimIsLive(record.value, clock()), locked } : { live: false, locked };
}

/** Every subject whose record says it is held. */
export async function liveClaims(store: ClaimStore, clock: Clock = wallClock): Promise<ClaimRecord[]> {
  const now = clock();
  return (await store.docs.list<StoredClaim>(CLAIMS_COLLECTION)).map((item) => publicView(item.value)).filter((claim) => claimIsLive(claim, now));
}
