import { mkdir, open, rm } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { collectRun, readExit } from './collect.ts';
import type { OperationResult } from './contract.ts';
import { OperatorError } from './errors.ts';
import type { Herdr } from './herdr.ts';
import { addHistory, enqueue, JobStore, stableId, type JobRecord, type JobRun, type SlotHold } from './jobs.ts';
import { signalCommand } from './job-exec.ts';
import { jobTitle, openHerdrTab, prepareRun, startHeadless, startInHerdr } from './launch.ts';
import { errorText, type Logger } from './log.ts';
import type { Manifest, OperationSpec } from './manifest.ts';
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
/** Herdr tabs a finished run could not close; a tab never expires by itself. */
export const TABS_COLLECTION = 'tabs';

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
  private tabsPending = true;
  private readonly tabsWarned = new Set<string>();
  private lastTabRetry = 0;
  private lastPoll = 0;
  private lastWaitSweep = 0;
  private stopped = false;

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

  async tick(now: Date = new Date()): Promise<void> {
    await this.ensureLeader();
    await this.fireTimers(now);
    if (now.getTime() - this.lastPoll >= this.manifest.runtime.pollMs) {
      this.lastPoll = now.getTime();
      await this.poll(now);
    }
  }

  /** One observation pass without the timer and poll cadence; tests drive the daemon with it. */
  async poll(now: Date = new Date()): Promise<void> {
    await this.ensureLeader();
    for (const job of await this.jobs.list('running')) {
      try { await this.observe(job, now); } catch (error) { this.log.error('observing a running job failed', { job: job.id, error: errorText(error) }); }
    }
    for (const job of await this.jobs.list('queued')) {
      try { await this.dispatch(job, now); } catch (error) { this.log.error('starting a queued job failed', { job: job.id, error: errorText(error) }); }
    }
    if (now.getTime() - this.lastWaitSweep >= WAIT_SWEEP_MS) {
      this.lastWaitSweep = now.getTime();
      await this.sweepWaits(now);
    }
    if (this.tabsPending && now.getTime() - this.lastTabRetry >= TAB_RETRY_MS) {
      this.lastTabRetry = now.getTime();
      await this.retryTabs(now);
    }
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
      await this.startRun(job, op, pending, cwd, herdrWorkspace);
    } catch (error) {
      // Nothing was recorded on the job yet, so nobody else would ever give these back.
      await this.releaseRun(job.id, pending);
      throw error;
    }
  }

  private async startRun(job: JobRecord, op: OperationSpec, pending: JobRun, cwd: string, herdrWorkspace: string | undefined): Promise<void> {
    const threadId = op.thread === 'per-subject' ? (await this.backend.docs.get<{ threadId: string }>('threads', this.threadKey(job)))?.value.threadId : undefined;
    const placement = pending.placement;
    if (op.placement === 'herdr') {
      if (!herdrWorkspace) placement.degraded = 'no herdr workspace configured';
      else {
        try {
          const tab = await openHerdrTab(this.herdr, herdrWorkspace, cwd, jobTitle(job));
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
    const prepared = await prepareRun(this.manifest, job, op, { cwd, dryRun: this.dryRun, attended, ...(threadId ? { threadId } : {}), ...(pending.slot?.member ? { member: pending.slot.member } : {}) });
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
      return;
    }
    try {
      if (placement.kind === 'herdr' && placement.paneId) await startInHerdr(this.herdr, placement.paneId, prepared.runDir);
      else await startHeadless(prepared.runDir);
    } catch (error) {
      await this.interrupt(started, `could not start the wrapper: ${errorText(error)}`);
      return;
    }
    this.launches += 1;
    this.deferred.delete(job.id);
    this.renewedAt.set(job.id, Date.now());
    this.log.info('job started', { job: job.id, workflow: job.workflow, operation: job.operation, subject: job.subject, attempt: job.attempt, placement: placement.kind, pane: placement.paneId, member: run.slot?.member, degraded: placement.degraded });
  }

  private threadKey(job: JobRecord): string {
    return stableId('t', job.workflow, job.operation, job.subject);
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
    if (run.placement.paneId && !this.notified.has(job.id)) {
      const status = await this.herdr.agentStatus(run.placement.paneId).catch(() => undefined);
      if (status === 'blocked') {
        this.notified.add(job.id);
        this.log.warn('agent pane is blocked; the runtime never answers it', { job: job.id, pane: run.placement.paneId });
        await this.herdr.notify(`operator: ${jobTitle(job)} is blocked`, `pane ${run.placement.paneId} needs the owner`).catch(() => undefined);
      }
    }
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
    if (!run.placement.tabId) return;
    if (keepTabMs > 0) await this.closeTabLater(jobId, run.placement.tabId, new Date(Date.now() + keepTabMs));
    else await this.closeTab(jobId, run.placement.tabId);
  }

  /** Closes a run's tab, or keeps it on record so a later poll closes it once herdr answers again. */
  private async closeTab(jobId: string, tabId: string): Promise<void> {
    try {
      await this.herdr.closeTab(tabId);
      return;
    } catch (error) {
      this.log.warn('closing the run\'s herdr tab failed; a later poll retries it', { job: jobId, tab: tabId, error: errorText(error) });
    }
    await this.closeTabLater(jobId, tabId);
  }

  /** Records a tab a later poll closes: one kept open on purpose until `closeAt`, or one herdr refused to close. */
  private async closeTabLater(jobId: string, tabId: string, closeAt?: Date): Promise<void> {
    try {
      await this.backend.docs.replace(TABS_COLLECTION, tabId, { tabId, jobId, since: new Date().toISOString(), ...(closeAt ? { closeAt: closeAt.toISOString() } : {}) }, { ttlMs: TAB_RECORD_TTL_MS });
      if (closeAt) this.log.info('the run\'s herdr tab stays open for a person', { job: jobId, tab: tabId, until: closeAt.toISOString() });
      this.tabsPending = true;
    } catch (error) {
      // Releasing never fails the run it belongs to; this tab then waits for a person.
      this.log.error('the open herdr tab could not be recorded for a retry; close it by hand', { job: jobId, tab: tabId, error: errorText(error) });
    }
  }

  private async retryTabs(now: Date): Promise<void> {
    const pending = await this.backend.docs.list<{ tabId: string; jobId: string; closeAt?: string }>(TABS_COLLECTION);
    let left = 0;
    for (const { key, value } of pending) {
      if (value.closeAt && Date.parse(value.closeAt) > now.getTime()) { left += 1; continue; }
      try {
        const outcome = await this.herdr.closeTab(value.tabId);
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
