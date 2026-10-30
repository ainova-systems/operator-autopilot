import { randomUUID } from 'node:crypto';
import { mkdir, open, rm } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { claudeSessionExists } from './claude-session.ts';
import { collectRun, readExit } from './collect.ts';
import type { OperationResult } from './contract.ts';
import { OperatorError } from './errors.ts';
import { HerdrRefusal, type Herdr } from './herdr.ts';
import { addHistory, enqueue, JobStore, stableId, type JobRecord, type JobRun, type SlotHold } from './jobs.ts';
import { resultWritten, signalCommand } from './job-exec.ts';
import { jobTitle, openHerdrTab, prepareRun, runDirFor, startHeadless, startInHerdr } from './launch.ts';
import { errorText, type Logger } from './log.ts';
import type { Manifest, OperationSpec } from './manifest.ts';
import { clearPause, markQuiet, readPause, type PauseRecord } from './pause.ts';
import { Pools } from './pools.ts';
import { ageMs, processAlive, readJsonFile, runPath, writeJsonAtomic, type CommandInfo, type ExitInfo, type WrapperInfo } from './runfiles.ts';
import type { StateBackend } from './state/types.ts';
import { dueFirings } from './triggers.ts';
import { WaitStore } from './waits.ts';

export interface DaemonOptions {
  manifest: Manifest;
  backend: StateBackend;
  log: Logger;
  herdr: Herdr;
  dryRun?: boolean;
  host?: string;
}

interface LeaderFile { token: string; pid: number; host: string; acquiredAt: string }

const HEARTBEAT_STALE_MS = 30_000;
const START_GRACE_MS = 60_000;
const MAX_INTERRUPTIONS = 3;
const WAIT_SWEEP_MS = 60_000;
const TAB_RETRY_MS = 60_000;
const TAB_RECORD_TTL_MS = 7 * 86_400_000;
/** Nudges an idle interactive session gets before the owner is told. */
const IDLE_NUDGES = 2;

/** What an idle session is asked; it is typed into the session as the operator's next message. */
export function idleNudgeText(minutes: number): string {
  return `operator: this run has been idle for ${minutes} min without a result. If the work is finished, write your result now. If you are waiting on a subagent or a background task, reply in one line with what you wait for and keep waiting.`;
}
/** Herdr tabs a finished run could not close; a tab never expires by itself. */
export const TABS_COLLECTION = 'tabs';
/** Per-subject herdr tabs, one per workflow, subject, operation and workspace member. */
export const SUBJECT_TABS_COLLECTION = 'subject-tabs';
const SUBJECT_TAB_TTL_MS = 30 * 86_400_000;
/** How long a retained session gets to end before the next run in its tab; then it is killed. */
const END_SESSION_WAIT_MS = 15_000;
/** How long a pane whose session just ended gets to read as free before the next run is typed in. */
const PANE_SETTLE_MS = 5_000;
/** How long a tab may stay in use before the owner is told, when `runtime.idleNudge` is off. */
const IN_USE_WARN_MS = 30 * 60_000;
/** Kept tab records are renewed at most this often while their tab is still open. */
const RECORD_REFRESH_MS = 3_600_000;

/** Where a tab to close runs: its pane, the run directory of the session in it, and whether to wait while it is in use. */
interface TabPane { paneId?: string; runDir?: string; guard?: boolean }
/** A tab a later poll closes. */
interface TabRecord extends TabPane { tabId: string; jobId: string; since: string; closeAt?: string; refreshedAt?: string }

/** A herdr tab kept for its subject: later runs of the same operation there run in it. */
export interface SubjectTab {
  workflow: string;
  subject: string;
  operation: string;
  member?: string;
  workspaceId: string;
  tabId: string;
  paneId: string;
  /** The claude session the tab's runs continue; absent until a claude run left one to continue. */
  sessionId?: string;
  /** The last run in the tab, and its run directory. */
  jobId: string;
  runDir: string;
  since: string;
  updatedAt: string;
  /** When the record's lifetime was last renewed; it is renewed while the tab stays open. */
  refreshedAt?: string;
}

export function subjectTabKey(workflow: string, subject: string, operation: string, member: string | undefined): string {
  return stableId('st', workflow, subject, operation, member ?? '');
}

/**
 * The runtime's single active process per project. It holds the leader lease, fires timers, starts
 * queued jobs within their pools, observes running ones through their run directories, and turns
 * each finished run into its follow-on jobs or wait. It never decides anything a skill decides.
 */
export class Daemon {
  readonly manifest: Manifest;
  readonly backend: StateBackend;
  readonly log: Logger;
  readonly herdr: Herdr;
  readonly dryRun: boolean;
  readonly host: string;
  readonly jobs: JobStore;
  readonly waits: WaitStore;
  readonly pools: Pools;
  /** Number of runs this process started; tests use it to prove nothing launched twice. */
  launches = 0;
  private leader: { token: string; renewedAt: number } | undefined;
  private renewing: Promise<void> | undefined;
  private readonly timerMemo = new Map<string, string>();
  private readonly deferred = new Map<string, number>();
  private readonly renewedAt = new Map<string, number>();
  private readonly notified = new Set<string>();
  /** Interactive sessions seen idle without a result: since when, and how often they were nudged. */
  private readonly idle = new Map<string, { since?: number; nudges: number; warned: boolean }>();
  private tabsPending = true;
  private readonly tabsWarned = new Set<string>();
  /** Tabs whose close or reuse waits because someone works in them, since when, and whether the owner was told. */
  private readonly inUse = new Map<string, { since: number; warned: boolean; notified: boolean }>();
  /** Panes herdr last reported `unknown` for: a second `unknown` in a row reads as a shell. */
  private readonly unknownPanes = new Set<string>();
  private lastSubjectTabRefresh = 0;
  private lastTabRetry = 0;
  private lastPoll = 0;
  private lastWaitSweep = 0;
  private stopped = false;
  /** The pause in force at the last check; undefined while running normally. */
  private paused: PauseRecord | undefined;

  constructor(options: DaemonOptions) {
    this.manifest = options.manifest;
    this.backend = options.backend;
    this.log = options.log;
    this.herdr = options.herdr;
    this.dryRun = options.dryRun === true;
    this.host = options.host ?? hostname();
    this.jobs = new JobStore(this.backend.docs, this.manifest.runtime.retentionMs);
    this.waits = new WaitStore(this.backend.docs);
    this.pools = new Pools(this.manifest, this.backend, this.log);
  }

  private get leaseTtl(): number { return this.manifest.runtime.leaseTtlMs; }
  private get leaderFile(): string { return join(this.manifest.runtime.stateDir, 'leader.json'); }

  /** Runs until stop(): waits for the leader lease, then ticks. */
  async run(): Promise<void> {
    let waitingLogged = false;
    while (!this.stopped && !(await this.acquireLeader())) {
      if (!waitingLogged) { this.log.info('another daemon holds the leader lease; waiting for it', { project: this.manifest.project }); waitingLogged = true; }
      await sleep(Math.max(1000, this.leaseTtl / 3));
    }
    if (this.stopped) return;
    this.log.info('daemon started', { project: this.manifest.project, host: this.host, state: this.backend.kind, dryRun: this.dryRun, workflows: [...this.manifest.workflows.keys()].join(',') });
    await this.resumeAfterRestart();
    // The lease is renewed on its own clock, so a slow pass cannot outlive it unnoticed.
    const renewal = setInterval(() => {
      this.ensureLeader().catch((error: unknown) => {
        if (error instanceof OperatorError && error.code === 'LEADER_LOST') { this.log.error('leader lease lost; stopping', { error: errorText(error) }); this.stop(); return; }
        this.log.warn('renewing the leader lease failed; retrying', { error: errorText(error) });
      });
    }, Math.max(1000, this.leaseTtl / 3));
    renewal.unref();
    try {
      while (!this.stopped) {
        try {
          await this.tick();
        } catch (error) {
          if (error instanceof OperatorError && error.code === 'LEADER_LOST') throw error;
          this.log.error('tick failed; retrying next tick', { error: errorText(error) });
        }
        await sleep(this.manifest.runtime.tickMs);
      }
    } finally {
      clearInterval(renewal);
      await this.releaseLeader();
      this.log.info('daemon stopped', { project: this.manifest.project });
    }
  }

  stop(): void {
    this.stopped = true;
  }

  /** One attempt at the leader lease, serialised against other daemons on this host. */
  async acquireLeader(): Promise<boolean> {
    await mkdir(this.manifest.runtime.stateDir, { recursive: true });
    const lockPath = join(this.manifest.runtime.stateDir, 'leader.lock');
    let lock;
    try {
      lock = await open(lockPath, 'wx');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const holder = Number((await readJsonFile<{ pid: number }>(lockPath).catch(() => undefined))?.pid);
      if (Number.isInteger(holder) && processAlive(holder)) return false;
      await rm(lockPath, { force: true });
      return false;
    }
    try {
      await lock.writeFile(JSON.stringify({ pid: process.pid }));
      return await this.acquireLeaderLocked();
    } finally {
      await lock.close();
      await rm(lockPath, { force: true });
    }
  }

  private async acquireLeaderLocked(): Promise<boolean> {
    const previous = await readJsonFile<LeaderFile>(this.leaderFile);
    if (previous && previous.host === this.host && previous.pid !== process.pid) {
      if (processAlive(previous.pid)) return false;
      // The previous daemon on this host died without releasing; its lease is ours to continue.
      if ((await this.backend.locks.renew('leader', previous.token, this.leaseTtl)) === 'renewed') {
        await this.writeLeader(previous.token);
        this.log.info('adopted the leader lease of a daemon that stopped without releasing it', { previousPid: previous.pid });
        return true;
      }
    }
    if (await this.backend.locks.exists('leader')) return false;
    const lease = await this.backend.locks.acquire('leader', this.leaseTtl, `${this.host}:${process.pid}`);
    if (!lease.acquired) return false;
    await this.writeLeader(lease.token);
    return true;
  }

  private async writeLeader(token: string): Promise<void> {
    this.leader = { token, renewedAt: Date.now() };
    await mkdir(this.manifest.runtime.stateDir, { recursive: true });
    await writeJsonAtomic(this.leaderFile, { token, pid: process.pid, host: this.host, acquiredAt: new Date().toISOString() } satisfies LeaderFile);
  }

  /** Renews the leader lease when a third of it has passed; throws LEADER_LOST when it is gone. */
  private async ensureLeader(): Promise<void> {
    if (!this.leader) throw new OperatorError('LEADER_LOST', 'this daemon does not hold the leader lease');
    if (Date.now() - this.leader.renewedAt < this.leaseTtl / 3) return;
    this.renewing ??= this.renewLeader().finally(() => { this.renewing = undefined; });
    await this.renewing;
  }

  private async renewLeader(): Promise<void> {
    if (!this.leader) throw new OperatorError('LEADER_LOST', 'this daemon does not hold the leader lease');
    const outcome = await this.backend.locks.renew('leader', this.leader.token, this.leaseTtl);
    if (outcome === 'renewed') { this.leader.renewedAt = Date.now(); return; }
    if (outcome === 'lifetime-exceeded') {
      await this.backend.locks.release('leader');
      const lease = await this.backend.locks.acquire('leader', this.leaseTtl, `${this.host}:${process.pid}`);
      if (lease.acquired) { await this.writeLeader(lease.token); this.log.info('leader lease re-acquired after its 24h lifetime'); return; }
    }
    this.leader = undefined;
    throw new OperatorError('LEADER_LOST', 'the leader lease was lost; another daemon may be running for this project');
  }

  private async releaseLeader(): Promise<void> {
    if (!this.leader) return;
    try {
      await this.backend.locks.release('leader');
      await rm(this.leaderFile, { force: true });
    } catch (error) {
      this.log.warn('could not release the leader lease; it expires by itself', { error: errorText(error) });
    }
    this.leader = undefined;
  }

  /**
   * A pause ends when the service starts again: it exists to let running jobs finish before the
   * service or its host goes down, and a restart is that moment passing.
   */
  async resumeAfterRestart(): Promise<void> {
    const pause = await readPause(this.backend.docs);
    if (pause && (await clearPause(this.backend.docs))) this.log.info('resumed: a pause ends when the service starts', { pausedSince: pause.since, by: pause.by });
    this.paused = undefined;
  }

  /** Reads the pause switch, logging each change of it. */
  private async refreshPause(): Promise<void> {
    const pause = await readPause(this.backend.docs);
    if (pause && pause.since !== this.paused?.since) {
      const running = (await this.jobs.list('running')).length;
      this.log.info('paused: no timer fires and no queued job starts; running jobs finish first', { by: pause.by, reason: pause.reason ?? '', running });
    } else if (!pause && this.paused) {
      this.log.info('resumed', { pausedSince: this.paused.since });
    }
    this.paused = pause;
  }

  async tick(now: Date = new Date()): Promise<void> {
    await this.ensureLeader();
    await this.refreshPause();
    if (!this.paused) await this.fireTimers(now);
    if (now.getTime() - this.lastPoll >= this.manifest.runtime.pollMs) {
      this.lastPoll = now.getTime();
      await this.poll(now);
    }
  }

  /** One observation pass without the timer and poll cadence; tests drive the daemon with it. */
  async poll(now: Date = new Date()): Promise<void> {
    await this.ensureLeader();
    await this.refreshPause();
    for (const job of await this.jobs.list('running')) {
      try { await this.observe(job, now); } catch (error) { this.log.error('observing a running job failed', { job: job.id, error: errorText(error) }); }
    }
    if (this.paused) await this.reportQuiet(this.paused, now);
    else {
      for (const job of await this.jobs.list('queued')) {
        try { await this.dispatch(job, now); } catch (error) { this.log.error('starting a queued job failed', { job: job.id, error: errorText(error) }); }
      }
    }
    if (now.getTime() - this.lastWaitSweep >= WAIT_SWEEP_MS) {
      this.lastWaitSweep = now.getTime();
      await this.sweepWaits(now);
    }
    if (now.getTime() - this.lastSubjectTabRefresh >= RECORD_REFRESH_MS) {
      this.lastSubjectTabRefresh = now.getTime();
      await this.refreshSubjectTabs(now).catch((error: unknown) => this.log.warn('renewing per-subject tab records failed; retrying later', { error: errorText(error) }));
    }
    if (this.tabsPending && now.getTime() - this.lastTabRetry >= TAB_RETRY_MS) {
      this.lastTabRetry = now.getTime();
      await this.retryTabs(now);
    }
  }

  /** Says once per pause that no job runs any more, in the log and to the owner. */
  private async reportQuiet(pause: PauseRecord, now: Date): Promise<void> {
    if (pause.quietAt || (await this.jobs.list('running')).length > 0) return;
    await markQuiet(this.backend.docs, pause, now);
    this.paused = { ...pause, quietAt: now.toISOString() };
    const queued = (await this.jobs.list('queued')).length;
    this.log.info('fully paused: no job running; the service or its host can stop now', { queued });
    await this.herdr.notify('operator: fully paused', `no job running, ${queued} queued; the service starts them again when it restarts or on operator resume`).catch(() => undefined);
  }

  private async fireTimers(now: Date): Promise<void> {
    for (const firing of dueFirings(this.manifest, now)) {
      const memoKey = `${firing.workflow}:${firing.trigger.index}`;
      if (this.timerMemo.get(memoKey) === firing.triggerId) continue;
      const { id, created } = await enqueue(this.jobs, {
        project: this.manifest.project,
        workflow: firing.workflow,
        operation: firing.trigger.run,
        subject: firing.trigger.subject,
        input: firing.trigger.input,
        trigger: { id: firing.triggerId, name: firing.trigger.kind === 'every' ? `every ${firing.trigger.intervalMs / 1000}s` : `cron ${firing.trigger.schedule.expression}`, kind: 'timer' },
      });
      this.timerMemo.set(memoKey, firing.triggerId);
      if (created) {
        this.log.info('timer fired', { workflow: firing.workflow, operation: firing.trigger.run, trigger: firing.triggerId, job: id });
        this.lastPoll = 0;
      } else {
        this.log.debug('timer slot already enqueued', { trigger: firing.triggerId, job: id });
      }
    }
  }

  private operation(job: JobRecord): OperationSpec | undefined {
    const workflow = this.manifest.workflows.get(job.workflow);
    return workflow?.enabled ? workflow.operations.get(job.operation) : undefined;
  }

  private async dispatch(job: JobRecord, now: Date): Promise<void> {
    if (job.notBefore && Date.parse(job.notBefore) > now.getTime()) return;
    if ((this.deferred.get(job.id) ?? 0) > now.getTime()) return;
    const op = this.operation(job);
    if (!op) {
      await this.finishWithoutRun(job, 'failed', `operation ${job.workflow}/${job.operation} is not configured or its workflow is disabled`);
      return;
    }
    if (this.dryRun && op.kind !== 'script') {
      const prepared = await prepareRun(this.manifest, job, op, { cwd: this.manifest.root, dryRun: true, attended: op.kind === 'interactive' });
      this.log.info('dry run: would start agent', { job: job.id, operation: job.operation, subject: job.subject, kind: op.kind, placement: op.placement, pool: op.pool, argv: JSON.stringify(prepared.command.argv) });
      await this.finishWithoutRun(job, 'noop', 'dry run: agent not started');
      return;
    }

    if (op.exclusive) {
      const busy = (await this.jobs.list('running')).some((other) => other.workflow === job.workflow && other.operation === job.operation);
      if (busy) {
        this.deferred.set(job.id, now.getTime() + this.manifest.runtime.pollMs);
        this.log.debug('exclusive operation already running; waiting', { job: job.id, operation: job.operation });
        return;
      }
    }

    let hold: SlotHold | undefined;
    let cwd = this.manifest.root;
    let herdrWorkspace = this.manifest.herdr.workspace;
    let limitHold: SlotHold | undefined;
    const queue = async (waitingFor: string, retryAfterMs: number): Promise<void> => {
      this.deferred.set(job.id, now.getTime() + retryAfterMs);
      if (job.waitingFor !== waitingFor) {
        this.log.info('job queued', { job: job.id, operation: job.operation, subject: job.subject, reason: waitingFor });
        await this.jobs.update(job.id, (current) => {
          if (current.status !== 'queued') return undefined;
          current.waitingFor = waitingFor;
          addHistory(current, 'waiting', waitingFor);
          return current;
        });
      }
    };
    if (op.pool) {
      const decision = await this.pools.acquire(op.pool, job.id, { ...(job.member ? { member: job.member } : {}), read: op.access === 'read' });
      if (!decision.granted) { await queue(decision.waitingFor, decision.retryAfterMs); return; }
      hold = decision.hold;
      const member = decision.member ?? this.pools.member(hold);
      if (member) { cwd = member.cwd; herdrWorkspace = member.herdr; }
    }
    if (op.limit) {
      const decision = await this.pools.acquire(op.limit, job.id);
      if (!decision.granted) {
        if (hold) await this.pools.release(job.id, hold);
        await queue(decision.waitingFor, decision.retryAfterMs);
        return;
      }
      limitHold = decision.hold;
    }

    const leaseKey = `run.${job.id}`;
    const lease = await this.backend.locks.acquire(leaseKey, this.leaseTtl, `${this.host}:${job.attempt}`);
    if (!lease.acquired) {
      if (hold) await this.pools.release(job.id, hold);
      if (limitHold) await this.pools.release(job.id, limitHold);
      this.deferred.set(job.id, now.getTime() + this.leaseTtl);
      this.log.warn('run lease is held elsewhere; not starting the job twice', { job: job.id });
      return;
    }
    const pending: JobRun = { attempt: job.attempt, host: this.host, runDir: '', startedAt: now.toISOString(), placement: { kind: 'headless' }, lease: { key: leaseKey, token: lease.token }, ...(hold ? { slot: hold } : {}), ...(limitHold ? { limitSlot: limitHold } : {}) };
    try {
      const busy = await this.startRun(job, op, pending, cwd, herdrWorkspace);
      if (busy) {
        await this.releaseRun(job.id, pending);
        await queue(busy, this.manifest.runtime.pollMs);
      }
    } catch (error) {
      // Nothing was recorded on the job yet, so nobody else would ever give these back.
      await this.releaseRun(job.id, pending);
      throw error;
    }
  }

  /** Starts the run, or answers why it waits: its per-subject tab is in use. */
  private async startRun(job: JobRecord, op: OperationSpec, pending: JobRun, cwd: string, herdrWorkspace: string | undefined): Promise<string | undefined> {
    const threadId = op.thread === 'per-subject' ? (await this.backend.docs.get<{ threadId: string }>('threads', this.threadKey(job)))?.value.threadId : undefined;
    const placement = pending.placement;
    const member = pending.slot?.member;
    let kept: SubjectTab | undefined;
    let retain = false;
    if (op.placement === 'herdr') {
      if (!herdrWorkspace) placement.degraded = 'no herdr workspace configured';
      else {
        try {
          const reuse = op.tabs === 'per-subject' ? await this.reusableTab(job, member) : { retain: false };
          if (reuse.busy) return reuse.busy;
          kept = reuse.tab;
          retain = reuse.retain;
          const tab = kept ?? await openHerdrTab(this.herdr, herdrWorkspace, cwd, jobTitle(job));
          if ('degraded' in tab) placement.degraded = tab.degraded;
          else {
            Object.assign(placement, { kind: 'herdr', workspace: tab.workspaceId, tabId: tab.tabId, paneId: tab.paneId });
            // The title is display-only; a refusal must not cost the run its tab.
            await this.herdr.setTitle(tab.paneId, jobTitle(job)).catch((error: unknown) => {
              this.log.warn('herdr refused the pane title; the run keeps its tab', { job: job.id, pane: tab.paneId, error: errorText(error) });
            });
          }
        } catch (error) {
          placement.degraded = `herdr refused the tab: ${errorText(error)}`;
        }
      }
    }
    // The command depends on the placement: an interactive run without its terminal runs as an agent.
    const attended = op.kind === 'interactive' && placement.kind === 'herdr';
    if (op.kind === 'interactive' && !attended) placement.degraded = `${placement.degraded ?? 'no terminal'}; runs as an agent`;
    // A per-subject tab is recorded before anything else can fail, so a failed start cannot leak it.
    // A retained claude tab continues its session; the first run in it starts one under a known id.
    let session: { id: string; resume: boolean } | undefined;
    if (retain && placement.kind === 'herdr' && placement.tabId && placement.paneId && placement.workspace) {
      // A session whose transcript is missing - its first run never got to start it - is started new
      // under the same id; one with a transcript is resumed, however its last run ended.
      if (op.engine === 'claude') {
        const id = kept?.sessionId ?? randomUUID();
        const resume = kept?.sessionId !== undefined && claudeSessionExists(cwd, id, { ...process.env, ...op.env });
        if (kept?.sessionId && !resume) this.log.info('the session to continue has no transcript; starting it under the same id', { job: job.id, session: id });
        session = { id, resume };
      }
      const now = new Date().toISOString();
      const record: SubjectTab = { workflow: job.workflow, subject: job.subject, operation: job.operation, ...(member ? { member } : {}), workspaceId: placement.workspace, tabId: placement.tabId, paneId: placement.paneId, ...(session ? { sessionId: session.id } : {}), jobId: job.id, runDir: runDirFor(this.manifest, job), since: kept?.since ?? now, updatedAt: now, refreshedAt: now };
      try {
        await this.backend.docs.replace(SUBJECT_TABS_COLLECTION, subjectTabKey(job.workflow, job.subject, job.operation, member), record, { ttlMs: SUBJECT_TAB_TTL_MS });
        placement.retained = true;
      } catch (error) {
        session = undefined;
        this.log.error('the per-subject tab could not be recorded; this run closes it like a per-job tab', { job: job.id, tab: placement.tabId, error: errorText(error) });
      }
    }
    const retained = placement.retained === true;
    const prepared = await prepareRun(this.manifest, job, op, { cwd, dryRun: this.dryRun, attended, ...(threadId ? { threadId } : {}), ...(member ? { member } : {}), ...(session ? { session } : {}), ...(retained ? { retain: true } : {}) });
    pending.runDir = prepared.runDir;
    const run = pending;
    await this.ensureLeader();
    const started = await this.jobs.update(job.id, (current) => {
      if (current.status !== 'queued' || current.attempt !== job.attempt) return undefined;
      current.status = 'running';
      current.run = run;
      delete current.waitingFor;
      delete current.notBefore;
      addHistory(current, 'started', `${placement.kind}${placement.paneId ? ` ${placement.paneId}` : ''}${placement.degraded ? ` (degraded: ${placement.degraded})` : ''} attempt ${job.attempt}`);
      return current;
    });
    if (!started) {
      await this.releaseRun(job.id, run);
      this.log.info('job changed before it started; not started', { job: job.id });
      return undefined;
    }
    try {
      if (placement.kind === 'herdr' && placement.paneId) await startInHerdr(this.herdr, placement.paneId, prepared.runDir);
      else await startHeadless(prepared.runDir);
    } catch (error) {
      await this.interrupt(started, `could not start the wrapper: ${errorText(error)}`);
      return undefined;
    }
    this.launches += 1;
    this.deferred.delete(job.id);
    this.renewedAt.set(job.id, Date.now());
    this.log.info('job started', { job: job.id, workflow: job.workflow, operation: job.operation, subject: job.subject, attempt: job.attempt, placement: placement.kind, pane: placement.paneId, member: run.slot?.member, degraded: placement.degraded });
    return undefined;
  }

  private threadKey(job: JobRecord): string {
    return stableId('t', job.workflow, job.operation, job.subject);
  }

  /**
   * The kept tab a per-subject run reuses, or why the run waits for it. `retain` is false when the
   * run gets a tab of its own that closes after it, because herdr is not there.
   */
  private async reusableTab(job: JobRecord, member: string | undefined): Promise<{ tab?: SubjectTab; retain: boolean; busy?: string }> {
    if (!(await this.herdr.available())) return { retain: false };
    const key = subjectTabKey(job.workflow, job.subject, job.operation, member);
    const kept = (await this.backend.docs.get<SubjectTab>(SUBJECT_TABS_COLLECTION, key))?.value;
    if (!kept) return { retain: true };
    // One conversation per key: a run still working in the tab is waited for, never forked.
    if (kept.jobId !== job.id && (await this.jobs.get(kept.jobId))?.status === 'running') return { retain: true, busy: `per-subject tab ${kept.tabId} is busy with ${kept.jobId}` };
    // Someone still works in the kept session - the owner after its result, most likely - so the
    // next step waits rather than ending that work.
    const use = await this.tabUse(kept.tabId, kept.paneId, job.id);
    if (use === 'gone') {
      await this.backend.docs.delete(SUBJECT_TABS_COLLECTION, key);
      this.log.info('the per-subject tab is gone; opening a new one with a new session', { job: job.id, tab: kept.tabId });
      return { retain: true };
    }
    if (use === 'in-use') return { retain: true, busy: `per-subject tab ${kept.tabId} is in use` };
    if (!(await this.endSession(kept.runDir))) return { retain: true, busy: `per-subject tab ${kept.tabId} still runs a session this host cannot end` };
    // The next wrapper is typed into the pane, so the pane must be back at its shell first.
    if (!(await this.paneSettled(kept.paneId))) return { retain: true, busy: `per-subject tab ${kept.tabId} is not back at its shell` };
    this.log.info('reusing the per-subject tab', { job: job.id, tab: kept.tabId, pane: kept.paneId, session: kept.sessionId });
    return { tab: kept, retain: true };
  }

  /**
   * Ends what a finished run left running in its tab - a retained session - so the tab takes the next
   * run or closes. False when a session may still run that this daemon cannot end: one on another host.
   */
  private async endSession(runDir: string): Promise<boolean> {
    const wrapper = await readJsonFile<WrapperInfo>(runPath(runDir, 'wrapper'));
    if (!wrapper) return true;
    if (wrapper.host !== this.host) return false;
    if (!processAlive(wrapper.pid)) return true;
    // The wrapper forwards the signal to its session and exits when the session does.
    try { process.kill(wrapper.pid, 'SIGTERM'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
    const deadline = Date.now() + END_SESSION_WAIT_MS;
    while (processAlive(wrapper.pid) && Date.now() < deadline) await sleep(200);
    if (!processAlive(wrapper.pid)) return true;
    const command = await readJsonFile<CommandInfo>(runPath(runDir, 'command'));
    if (command && processAlive(command.pid)) signalCommand(command, 'SIGKILL');
    try { process.kill(wrapper.pid, 'SIGKILL'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
    this.log.warn('a retained session did not end when asked; killed it', { runDir, pid: wrapper.pid });
    return true;
  }

  /** Waits briefly for a pane whose session just ended to read as free again. */
  private async paneSettled(paneId: string): Promise<boolean> {
    const deadline = Date.now() + PANE_SETTLE_MS;
    for (;;) {
      if ((await this.paneUse(paneId)).use === 'free') return true;
      if (Date.now() >= deadline) return false;
      await sleep(200);
    }
  }

  /**
   * Closes the per-subject tabs of subjects a result named as ended and forgets their sessions and
   * Codex threads. A tab a run or a person still works in moves to the close retries, which close it
   * once that work is over.
   */
  private async endSubjects(job: JobRecord, subjects: string[]): Promise<void> {
    for (const { key, value } of await this.backend.docs.list<SubjectTab>(SUBJECT_TABS_COLLECTION)) {
      if (value.workflow !== job.workflow || !subjects.includes(value.subject)) continue;
      try {
        // The tab enters the close retries before it leaves the registry, so a failure between the two
        // leaves it in one of them; the retries close it once nobody works in it.
        const now = new Date().toISOString();
        await this.backend.docs.replace(TABS_COLLECTION, value.tabId, { tabId: value.tabId, jobId: value.jobId, since: now, refreshedAt: now, paneId: value.paneId, runDir: value.runDir, guard: true } satisfies TabRecord, { ttlMs: TAB_RECORD_TTL_MS });
        this.tabsPending = true;
        this.lastTabRetry = 0;
        await this.backend.docs.delete(SUBJECT_TABS_COLLECTION, key);
        this.log.info('the tab of an ended subject closes once nobody works in it', { subject: value.subject, operation: value.operation, tab: value.tabId });
      } catch (error) {
        this.log.warn('could not end a subject\'s tab; a later result naming the subject retries', { subject: value.subject, tab: value.tabId, error: errorText(error) });
      }
    }
    const workflow = this.manifest.workflows.get(job.workflow);
    for (const op of workflow?.operations.values() ?? []) {
      if (op.thread !== 'per-subject') continue;
      for (const subject of subjects) {
        await this.backend.docs.delete('threads', stableId('t', job.workflow, op.name, subject)).catch((error: unknown) => {
          this.log.warn('could not forget an ended subject\'s Codex thread', { subject, operation: op.name, error: errorText(error) });
        });
      }
    }
  }

  private async observe(job: JobRecord, now: Date): Promise<void> {
    const run = job.run;
    if (!run) { await this.interrupt(job, 'running without a run record'); return; }
    if (run.host !== this.host) {
      if (run.lease && (await this.backend.locks.exists(run.lease.key))) return;
      await this.interrupt(job, `run lease from host ${run.host} expired`);
      return;
    }
    const exit = await readExit(run.runDir);
    if (exit) { await this.finish(job, run, exit); return; }
    const wrapper = await readJsonFile<WrapperInfo>(runPath(run.runDir, 'wrapper'));
    const heartbeatAge = await ageMs(runPath(run.runDir, 'heartbeat'));
    const starting = now.getTime() - Date.parse(run.startedAt) < START_GRACE_MS;
    const beating = heartbeatAge === undefined ? starting : heartbeatAge < HEARTBEAT_STALE_MS;
    if (wrapper && processAlive(wrapper.pid) && beating) {
      await this.keepAlive(job, run);
      return;
    }
    if (!wrapper && starting) return;
    const lateExit = await readExit(run.runDir);
    if (lateExit) { await this.finish(job, run, lateExit); return; }
    await this.interrupt(job, wrapper ? `wrapper process ${wrapper.pid} is gone` : 'the wrapper never started');
  }

  private async keepAlive(job: JobRecord, run: JobRun): Promise<void> {
    if (run.limitSlot && !this.pools.held.get(run.limitSlot.pool)?.has(job.id)) this.pools.adopt(job.id, run.limitSlot);
    if (run.slot && !this.pools.held.get(run.slot.pool)?.has(job.id)) {
      this.pools.adopt(job.id, run.slot);
      this.log.info('resumed observing a running job', { job: job.id, operation: job.operation, subject: job.subject, pane: run.placement.paneId });
    }
    if (Date.now() - (this.renewedAt.get(job.id) ?? 0) < this.leaseTtl / 3) return;
    this.renewedAt.set(job.id, Date.now());
    const changes: Partial<JobRun> = {};
    if (run.lease) {
      const outcome = await this.backend.locks.renew(run.lease.key, run.lease.token, this.leaseTtl);
      if (outcome !== 'renewed') {
        const lease = await this.backend.locks.acquire(run.lease.key, this.leaseTtl, `${this.host}:${job.attempt}`);
        if (lease.acquired) changes.lease = { key: run.lease.key, token: lease.token };
      }
    }
    if (run.slot) {
      const renewed = await this.pools.renew(job.id, run.slot);
      if (renewed.token !== run.slot.token) changes.slot = renewed;
    }
    if (Object.keys(changes).length > 0) {
      await this.jobs.update(job.id, (current) => (current.status === 'running' && current.run ? { ...current, run: { ...current.run, ...changes } } : undefined));
    }
    if (run.placement.paneId) await this.watchPane(job, run.placement.paneId, run.runDir);
  }

  /**
   * A blocked pane is the owner's to answer. An interactive session that ended its turn without a
   * result reads the same from outside whether it waits on its own background work or stopped
   * short, so after `idleNudge` it is asked to write its result or say what it waits for; a second
   * silence nudges again, and a third tells the owner. Waiting is fine; stopping short is not.
   */
  private async watchPane(job: JobRecord, paneId: string, runDir: string): Promise<void> {
    const status = await this.herdr.agentStatus(paneId).catch(() => undefined);
    if (status === 'blocked' && !this.notified.has(job.id)) {
      this.notified.add(job.id);
      this.log.warn('agent pane is blocked; the runtime never answers it', { job: job.id, pane: paneId });
      await this.herdr.notify(`operator: ${jobTitle(job)} is blocked`, `pane ${paneId} needs the owner`).catch(() => undefined);
    }
    const limit = this.manifest.runtime.idleNudgeMs;
    if (limit <= 0 || this.operation(job)?.kind !== 'interactive') return;
    // A session whose result is written is handing it over, not stopping short.
    if (await resultWritten(runPath(runDir, 'result'))) { this.idle.delete(job.id); return; }
    const state = this.idle.get(job.id) ?? { nudges: 0, warned: false };
    this.idle.set(job.id, state);
    if (status !== 'done' && status !== 'idle') { delete state.since; return; }
    const now = Date.now();
    if (state.since === undefined) { state.since = now; return; }
    if (now - state.since < limit) return;
    const minutes = Math.round((now - state.since) / 60_000);
    if (state.nudges < IDLE_NUDGES) {
      state.nudges += 1;
      state.since = now;
      this.log.info('nudged an idle session that has no result yet', { job: job.id, pane: paneId, idleMinutes: minutes, nudge: state.nudges });
      await this.herdr.runInPane(paneId, idleNudgeText(minutes)).catch((error: unknown) => {
        this.log.warn('could not nudge an idle session', { job: job.id, pane: paneId, error: errorText(error) });
      });
      return;
    }
    if (state.warned) return;
    state.warned = true;
    this.log.warn('an idle session still has no result after being nudged', { job: job.id, pane: paneId, nudges: state.nudges });
    await this.herdr.notify(`operator: ${jobTitle(job)} is idle`, `pane ${paneId} has no result after ${state.nudges} nudges`).catch(() => undefined);
  }

  private async finish(job: JobRecord, run: JobRun, exit: ExitInfo): Promise<void> {
    // Effects below are published only for the attempt the job still records as running.
    await this.ensureLeader();
    const current = await this.jobs.get(job.id);
    if (current?.status !== 'running' || current.attempt !== job.attempt || current.run?.runDir !== run.runDir) {
      this.log.warn('a finished run is no longer the job\'s current attempt; its result is not applied', { job: job.id, attempt: job.attempt });
      return;
    }
    const op = this.operation(job);
    let result: OperationResult;
    if (!op) {
      result = { contract: 1, status: 'failed', evidence: [], next: [], failure: { reason: 'operation no longer configured', retryable: false } };
    } else {
      const collected = await collectRun(job, op, run.runDir, exit);
      result = collected.result;
      if (collected.threadId && op.thread === 'per-subject') {
        await this.backend.docs.replace('threads', this.threadKey(job), { threadId: collected.threadId, updatedAt: new Date().toISOString() }, { ttlMs: 30 * 86_400_000 });
      }
    }
    const workflow = this.manifest.workflows.get(job.workflow);
    const unknown = [...result.next.map((n) => n.operation), ...(result.wait ? [result.wait.resume] : [])].filter((name) => !workflow?.operations.has(name));
    if (unknown.length > 0) {
      result = { contract: 1, status: 'failed', evidence: result.evidence, next: [], failure: { reason: `result requests unknown operation(s): ${unknown.join(', ')}`, retryable: false } };
    }

    const nextIds: string[] = [];
    // Follow-on work of a subject stays where it ran: an operation in the same workspace pool keeps
    // this run's member unless the request names another.
    const stay = (operation: string): string | undefined => {
      if (!run.slot?.member || !workflow) return undefined;
      return workflow.operations.get(operation)?.pool === run.slot.pool ? run.slot.member : undefined;
    };
    for (const [index, request] of result.next.entries()) {
      const member = request.member ?? stay(request.operation);
      const queued = await enqueue(this.jobs, {
        project: this.manifest.project,
        workflow: job.workflow,
        operation: request.operation,
        subject: request.subject,
        input: request.input,
        // A keyed request is the same job whichever result asks for it, so a repeating discovery
        // asks once per key; an unkeyed one belongs to the result that sent it.
        trigger: { id: request.key ? `key:${request.key}` : `next:${job.id}:${job.attempt}:${index}`, name: job.operation, kind: 'next' },
        ...(request.notBefore ? { notBefore: request.notBefore } : {}),
        ...(member ? { member } : {}),
      });
      nextIds.push(queued.id);
    }
    if (result.wait) {
      const member = result.wait.member ?? stay(result.wait.resume);
      await this.waits.open(this.manifest.project, job.workflow, job.id, job.attempt, { ...result.wait, ...(member ? { member } : {}) });
    }

    const retry = result.status === 'failed' && result.failure?.retryable === true && op !== undefined && job.attempt <= op.retries;
    await this.releaseRun(job.id, run, result.status === 'noop' ? 0 : op?.keepTabMs ?? 0);
    if (result.endSubjects) {
      try { await this.endSubjects(job, result.endSubjects); } catch (error) { this.log.warn('closing the tabs of ended subjects failed; a later result naming them retries', { job: job.id, error: errorText(error) }); }
    }
    const finishedAt = new Date().toISOString();
    await this.jobs.update(job.id, (current) => {
      if (current.status !== 'running' || current.attempt !== job.attempt) return undefined;
      current.outcome = {
        finishedAt,
        status: result.status,
        evidence: result.evidence,
        next: nextIds,
        exitCode: exit.exitCode,
        ...(result.message ? { message: result.message } : {}),
        ...(result.failure ? { failure: result.failure } : {}),
      };
      if (retry && op) {
        current.status = 'queued';
        current.attempt += 1;
        current.notBefore = new Date(Date.now() + op.retryDelayMs).toISOString();
        delete current.run;
        addHistory(current, 'retry scheduled', result.failure?.reason);
      } else {
        current.status = result.status;
        addHistory(current, result.status, result.failure?.reason ?? result.message);
      }
      return current;
    });
    this.renewedAt.delete(job.id);
    this.notified.delete(job.id);
    this.idle.delete(job.id);
    const seconds = Math.round((Date.parse(finishedAt) - Date.parse(run.startedAt)) / 1000);
    const fields = { job: job.id, operation: job.operation, subject: job.subject, status: result.status, seconds, next: nextIds.length, message: result.message, reason: result.failure?.reason, wait: result.wait ? `${result.wait.on}${result.wait.key ? `:${result.wait.key}` : ''}` : undefined };
    if (result.status === 'failed') this.log.warn(retry ? 'job failed; retry scheduled' : 'job failed', fields);
    else this.log.info('job finished', fields);
    // A scheduled retry is not an end the owner has to act on; its last attempt is.
    if (op && !retry && op.notify.includes(result.status)) await this.notifyOwner(job, result);
  }

  /** Tells the owner a run ended in a status its operation names under `notify`; delivery is best effort. */
  private async notifyOwner(job: JobRecord, result: OperationResult): Promise<void> {
    const body = result.message ?? result.failure?.reason ?? result.status;
    try {
      await this.herdr.notify(`operator: ${jobTitle(job)} ${result.status}`, body);
      this.log.info('owner notified', { job: job.id, operation: job.operation, subject: job.subject, status: result.status });
    } catch (error) {
      this.log.warn('the owner notification was not delivered', { job: job.id, status: result.status, error: errorText(error) });
    }
  }

  private async interrupt(job: JobRecord, reason: string): Promise<void> {
    if (job.run?.host === this.host && job.run.runDir) {
      // The wrapper is gone; whatever its command left running must not overlap the next attempt.
      const command = await readJsonFile<CommandInfo>(runPath(job.run.runDir, 'command'));
      if (command && processAlive(command.pid)) {
        signalCommand(command, 'SIGKILL');
        this.log.warn('stopped the leftover command of an interrupted run', { job: job.id, pid: command.pid });
      }
    }
    if (job.run) await this.releaseRun(job.id, job.run);
    const interruptions = job.history.filter((entry) => entry.event === 'interrupted').length + 1;
    const giveUp = interruptions >= MAX_INTERRUPTIONS;
    await this.jobs.update(job.id, (current) => {
      if (current.status !== 'running' || current.attempt !== job.attempt) return undefined;
      addHistory(current, 'interrupted', reason);
      delete current.run;
      if (giveUp) {
        current.status = 'failed';
        current.outcome = { finishedAt: new Date().toISOString(), status: 'failed', evidence: [], next: [], failure: { reason: `interrupted ${interruptions} times; last: ${reason}`, retryable: false } };
      } else {
        current.status = 'queued';
        current.attempt += 1;
      }
      return current;
    });
    this.log.warn(giveUp ? 'job interrupted too often; failed' : 'job interrupted; it will run again', { job: job.id, operation: job.operation, subject: job.subject, reason, attempt: job.attempt });
  }

  private async finishWithoutRun(job: JobRecord, status: 'failed' | 'noop', message: string): Promise<void> {
    await this.jobs.update(job.id, (current) => {
      if (current.status !== 'queued') return undefined;
      current.status = status;
      current.outcome = { finishedAt: new Date().toISOString(), status, evidence: [], next: [], ...(status === 'failed' ? { failure: { reason: message, retryable: false } } : { message }) };
      addHistory(current, status, message);
      return current;
    });
    if (status === 'failed') this.log.warn('job failed before starting', { job: job.id, reason: message });
  }

  /** Gives back what a run held: its pool slot, its run lease and its herdr tab. */
  /** `keepTabMs` leaves a finished run's tab open that long for a person; everything else is released now. */
  private async releaseRun(jobId: string, run: JobRun, keepTabMs = 0): Promise<void> {
    const steps: Promise<unknown>[] = [];
    if (run.slot) steps.push(this.pools.release(jobId, run.slot));
    if (run.limitSlot) steps.push(this.pools.release(jobId, run.limitSlot));
    if (run.lease) steps.push(releaseOwnedLease(this.backend, run.lease.key, run.lease.token));
    // A freed slot may be what a deferred job was waiting for.
    this.deferred.clear();
    for (const outcome of await Promise.allSettled(steps)) {
      if (outcome.status === 'rejected') this.log.warn('releasing part of a run failed; it expires by itself', { job: jobId, error: errorText(outcome.reason) });
    }
    // A per-subject tab stays for the next run of its operation until its subject ends.
    if (!run.placement.tabId || run.placement.retained) return;
    const pane = { ...(run.placement.paneId ? { paneId: run.placement.paneId } : {}), ...(run.runDir ? { runDir: run.runDir } : {}) };
    // A kept tab holds a session a person may be working in, so its close waits for an idle pane; a
    // tab whose run is over holds nothing but a shell.
    if (keepTabMs > 0) await this.closeTabLater(jobId, run.placement.tabId, new Date(Date.now() + keepTabMs), { ...pane, guard: true });
    else await this.closeTab(jobId, run.placement.tabId, pane);
  }

  /** Closes a finished run's tab now, ending any session left in it, or records it for a later poll when herdr does not answer. */
  private async closeTab(jobId: string, tabId: string, pane: TabPane = {}): Promise<void> {
    try {
      if (pane.runDir) await this.endSession(pane.runDir);
      await this.herdr.closeTab(tabId);
      this.inUse.delete(tabId);
      return;
    } catch (error) {
      this.log.warn('closing the run\'s herdr tab failed; a later poll retries it', { job: jobId, tab: tabId, error: errorText(error) });
    }
    await this.closeTabLater(jobId, tabId, undefined, pane);
  }

  /**
   * What herdr says of a pane: free (idle, done, or a shell with no agent), gone, in use, or not yet
   * known. herdr answers a missing pane with `{"error":{"code":"pane_not_found"}}` on `pane get` (and
   * `tab_not_found` on `tab close`), checked against herdr itself. It reports `unknown` both for a
   * shell and for an agent it has not detected yet - one a person just started - so `unknown` counts
   * as free only on two consecutive answers.
   */
  private async paneUse(paneId: string): Promise<{ use: 'free' | 'in-use' | 'gone' | 'confirming'; status: string }> {
    let status: string | undefined;
    try {
      status = await this.herdr.agentStatus(paneId);
    } catch (error) {
      this.unknownPanes.delete(paneId);
      if (error instanceof HerdrRefusal && (error.reason === 'pane_not_found' || error.reason === 'tab_not_found')) return { use: 'gone', status: error.reason };
      // herdr did not answer: nobody can say the pane is free, so nothing in it is ended yet.
      return { use: 'in-use', status: `unanswered (${errorText(error)})` };
    }
    if (status === 'unknown') {
      if (this.unknownPanes.has(paneId)) return { use: 'free', status };
      this.unknownPanes.add(paneId);
      return { use: 'confirming', status };
    }
    this.unknownPanes.delete(paneId);
    if (status === 'idle' || status === 'done') return { use: 'free', status };
    return { use: 'in-use', status: status ?? 'unreported' };
  }

  /**
   * Whether a tab may be closed or reused now. Only a pane herdr reports free or gone permits ending
   * what runs in it; working, blocked or an unanswered herdr is in use. An episode of use is logged
   * once, and past `runtime.idleNudge` (30m when that is off) it is a warning and one owner
   * notification; it ends when the pane is free again.
   */
  private async tabUse(tabId: string, paneId: string | undefined, jobId: string): Promise<'free' | 'in-use' | 'gone'> {
    // A tab recorded without its pane, by an older daemon, is closed as it always was.
    if (!paneId) return 'free';
    const { use, status } = await this.paneUse(paneId);
    if (use === 'confirming') return 'in-use';
    if (use !== 'in-use') { this.inUse.delete(tabId); return use; }
    const now = Date.now();
    const episode = this.inUse.get(tabId);
    if (!episode) {
      this.inUse.set(tabId, { since: now, warned: false, notified: false });
      this.log.info('a herdr tab is in use; it is not closed or reused until its pane is idle', { job: jobId, tab: tabId, pane: paneId, status });
      return 'in-use';
    }
    const limit = this.manifest.runtime.idleNudgeMs > 0 ? this.manifest.runtime.idleNudgeMs : IN_USE_WARN_MS;
    if (now - episode.since < limit) return 'in-use';
    const minutes = Math.round((now - episode.since) / 60_000);
    if (!episode.warned) {
      episode.warned = true;
      this.log.warn('a herdr tab has been in use a long time; its close or next step still waits', { job: jobId, tab: tabId, pane: paneId, status, minutes });
    }
    // The owner hears of it once per episode; a notification herdr could not deliver is sent again later.
    if (!episode.notified) {
      try {
        await this.herdr.notify(`operator: tab ${tabId} is still in use`, `pane ${paneId} has been ${status} for ${minutes} min; the next step or its close waits for it`);
        episode.notified = true;
      } catch (error) {
        this.log.debug('the long-use notification was not delivered; retrying on a later poll', { tab: tabId, error: errorText(error) });
      }
    }
    return 'in-use';
  }

  /** Records a tab a later poll closes: one kept open on purpose until `closeAt`, or one that could not close yet. */
  private async closeTabLater(jobId: string, tabId: string, closeAt?: Date, pane: TabPane = {}): Promise<void> {
    try {
      const now = new Date().toISOString();
      await this.backend.docs.replace(TABS_COLLECTION, tabId, { tabId, jobId, since: now, refreshedAt: now, ...pane, ...(closeAt ? { closeAt: closeAt.toISOString() } : {}) } satisfies TabRecord, { ttlMs: TAB_RECORD_TTL_MS });
      if (closeAt) this.log.info('the run\'s herdr tab stays open for a person', { job: jobId, tab: tabId, until: closeAt.toISOString() });
      this.tabsPending = true;
    } catch (error) {
      // Releasing never fails the run it belongs to; this tab then waits for a person.
      this.log.error('the open herdr tab could not be recorded for a retry; close it by hand', { job: jobId, tab: tabId, error: errorText(error) });
    }
  }

  /**
   * Renews a kept record's lifetime, at most once per refresh period, while it still has a tab to
   * close. It re-reads the record and writes only if nothing changed it since, so a record another
   * step replaced or deleted meanwhile is neither overwritten nor brought back.
   */
  private async refreshRecord(collection: string, key: string, now: Date, ttlMs: number): Promise<void> {
    try {
      const current = await this.backend.docs.get<TabRecord | SubjectTab>(collection, key);
      if (!current) return;
      const value = current.value;
      const last = Date.parse(value.refreshedAt ?? ('updatedAt' in value ? value.updatedAt : value.since));
      if (now.getTime() - last < RECORD_REFRESH_MS) return;
      const outcome = await this.backend.docs.replace(collection, key, { ...value, refreshedAt: now.toISOString() }, { etag: current.etag, ttlMs });
      if (outcome === 'conflict') this.log.debug('a kept tab record changed while being renewed; left as it is', { collection, key });
    } catch (error) {
      this.log.warn('could not renew a kept tab record; it may expire', { collection, key, error: errorText(error) });
    }
  }

  /** Keeps per-subject tab records alive while their tabs stay open, however long a subject lasts. */
  private async refreshSubjectTabs(now: Date): Promise<void> {
    for (const { key } of await this.backend.docs.list<SubjectTab>(SUBJECT_TABS_COLLECTION)) {
      await this.refreshRecord(SUBJECT_TABS_COLLECTION, key, now, SUBJECT_TAB_TTL_MS);
    }
  }

  private async retryTabs(now: Date): Promise<void> {
    const pending = await this.backend.docs.list<TabRecord>(TABS_COLLECTION);
    let left = 0;
    for (const { key, value } of pending) {
      if (value.closeAt && Date.parse(value.closeAt) > now.getTime()) { left += 1; continue; }
      if (value.guard) {
        const held = (await this.jobs.get(value.jobId))?.status === 'running';
        const use = held ? 'in-use' : await this.tabUse(value.tabId, value.paneId, value.jobId);
        if (use === 'in-use') {
          left += 1;
          // A close that keeps waiting must not let its record expire into a tab nobody closes.
          await this.refreshRecord(TABS_COLLECTION, key, now, TAB_RECORD_TTL_MS);
          continue;
        }
        if (use === 'gone') {
          await this.backend.docs.delete(TABS_COLLECTION, key);
          this.log.info('a herdr tab waiting to close is already gone', { job: value.jobId, tab: value.tabId });
          continue;
        }
      }
      try {
        // A record without its run directory - written by an older daemon - closes the tab, which
        // ends whatever runs in it.
        if (value.runDir) await this.endSession(value.runDir);
        const outcome = await this.herdr.closeTab(value.tabId);
        this.inUse.delete(value.tabId);
        await this.backend.docs.delete(TABS_COLLECTION, key);
        this.tabsWarned.delete(value.tabId);
        if (value.closeAt) this.log.info('closed a run\'s herdr tab kept open for a person', { job: value.jobId, tab: value.tabId, outcome });
        else this.log.info('closed a herdr tab an earlier run left open', { job: value.jobId, tab: value.tabId, outcome });
      } catch (error) {
        left += 1;
        const fields = { job: value.jobId, tab: value.tabId, error: errorText(error) };
        if (this.tabsWarned.has(value.tabId)) this.log.debug('a herdr tab is still not closed', fields);
        else {
          this.tabsWarned.add(value.tabId);
          this.log.warn('a herdr tab is still not closed; retrying every minute', fields);
        }
      }
    }
    this.tabsPending = left > 0;
  }

  private async sweepWaits(now: Date): Promise<void> {
    for (const wait of await this.waits.listOpen()) {
      if (wait.expiresAt && Date.parse(wait.expiresAt) <= now.getTime() && (await this.waits.close(wait.id, 'expired'))) {
        this.log.info('wait expired unanswered', { wait: wait.id, job: wait.jobId, on: wait.on, subject: wait.subject });
      }
    }
  }
}

/** Releases a Shield lease only while this token still owns it, so a successor's lease survives. */
export async function releaseOwnedLease(backend: StateBackend, key: string, token: string): Promise<void> {
  if ((await backend.locks.renew(key, token, 1000)) === 'renewed') await backend.locks.release(key);
}
