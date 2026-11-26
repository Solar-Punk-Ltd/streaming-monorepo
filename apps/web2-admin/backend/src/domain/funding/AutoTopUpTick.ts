import {
  AUTO_TOPUP_DEFAULTS,
  AUTO_TOPUP_JOBS,
  AUTO_TOPUP_TICK_SECONDS,
  type AutoTopUpJob,
  type AutoTopUpSettings,
} from '@streaming-monorepo/web2-admin-common';

import { getErrorMessage } from '../../utils/errorUtils.js';
import { Logger } from '../Logger.js';

import {
  markedStampsOf,
  type AutoTopUpFunding,
  type AutoTopUpJobResult,
  type AutoTopUpJobRunner,
} from './autoTopUpJobs.js';
import type { BrandWallet } from './BrandWallet.js';
import type { FundingPinStore } from './FundingPinRepository.js';
import { ADMIN_FUNDING_CHAIN_ID, managerProblem } from './FundingService.js';
import type { ManagerFundingClient } from './ManagerFundingClient.js';
import type { StampAutoTopUpStore } from './StampAutoTopUpStore.js';

const logger = Logger.getInstance();

/** How long after the backend starts the first tick runs: three minutes, so the manager and the nodes are up first. */
export const AUTO_TOPUP_START_DELAY_MS = 3 * 60_000;

/** What the tick uses of the store: its lock, the numbers, the jobs, the marks, and each job's run. */
export type AutoTopUpTickStore = Pick<
  StampAutoTopUpStore,
  'withTickLock' | 'settings' | 'jobs' | 'marks' | 'recordRun'
>;

/** What the tick reads of the manager: the inventory, and the brand wallet's account. */
export type AutoTopUpTickManager = Pick<ManagerFundingClient, 'inventory' | 'account'>;

export interface AutoTopUpTickDeps {
  store: AutoTopUpTickStore;
  /** The client of the manager's funding API, or null while the admin has no manager funding settings. */
  manager: AutoTopUpTickManager | null;
  /** The brand wallet, whose `address()` is null while it has no key, or null where none is wired. */
  wallet: Pick<BrandWallet, 'address'> | null;
  pins: Pick<FundingPinStore, 'all'>;
  /** The jobs, each run in the order of `AUTO_TOPUP_JOBS` whatever the order here. A job with none is not run. */
  jobs: readonly AutoTopUpJobRunner[];
  /** The admin's clock, in ms: `Date.now` by default, a fake in the unit tests. */
  now?: () => number;
  /** Between two ticks: `AUTO_TOPUP_TICK_SECONDS` by default. */
  intervalMs?: number;
  /** Before the first tick: {@link AUTO_TOPUP_START_DELAY_MS} by default. */
  startDelayMs?: number;
}

/**
 * How one tick went: the jobs it ran with what each answered; skipped, since another backend holds the lock; ended
 * for want of a reading of the manager, which the jobs that would have run recorded; or nothing to run, every job
 * paused.
 */
export type AutoTopUpTickOutcome =
  | { state: 'ran'; jobs: { job: AutoTopUpJob; result: AutoTopUpJobResult }[] }
  | { state: 'locked' }
  | { state: 'unread'; problem: string; jobs: AutoTopUpJob[] }
  | { state: 'idle' };

const IDLE: AutoTopUpTickOutcome = { state: 'idle' };

/**
 * The tick of stamp auto top-up (docs/architecture/funding.md, "The three jobs"): every `AUTO_TOPUP_TICK_SECONDS`,
 * starting {@link AUTO_TOPUP_START_DELAY_MS} after `start`, it takes the store's tick lock, without waiting, so with
 * two backends up one runs it and the other skips it. Under the lock it reads the manager once, the inventory and the
 * brand wallet's account, and runs the jobs that are not paused in the order of `AUTO_TOPUP_JOBS`, recording each
 * one's run. A manager that does not answer, answers for another chain or has no price of postage ends the tick there,
 * and each job that would have run records why. A tick still running when the next is due makes the next one wait,
 * and runs it as soon as it ends.
 */
export class AutoTopUpTick {
  private readonly store: AutoTopUpTickStore;
  private readonly manager: AutoTopUpTickManager | null;
  private readonly wallet: Pick<BrandWallet, 'address'> | null;
  private readonly pins: Pick<FundingPinStore, 'all'>;
  private readonly runners: ReadonlyMap<AutoTopUpJob, AutoTopUpJobRunner>;
  private readonly now: () => number;
  private readonly intervalMs: number;
  private readonly startDelayMs: number;
  private starter: NodeJS.Timeout | null = null;
  private timer: NodeJS.Timeout | null = null;
  /** The tick under way, and the one waiting behind it, which every caller in the meantime shares. */
  private running: Promise<AutoTopUpTickOutcome> | null = null;
  private next: Promise<AutoTopUpTickOutcome> | null = null;
  private stopped = false;

  constructor(deps: AutoTopUpTickDeps) {
    this.store = deps.store;
    this.manager = deps.manager;
    this.wallet = deps.wallet;
    this.pins = deps.pins;
    this.runners = new Map(deps.jobs.map((runner) => [runner.job, runner]));
    this.now = deps.now ?? Date.now;
    this.intervalMs = deps.intervalMs ?? AUTO_TOPUP_TICK_SECONDS * 1000;
    this.startDelayMs = deps.startDelayMs ?? AUTO_TOPUP_START_DELAY_MS;
  }

  /** Schedules the ticks: the first after the start delay, then one every interval. */
  start(): void {
    if (this.starter || this.timer || this.stopped) return;
    this.starter = setTimeout(() => {
      this.starter = null;
      if (this.stopped) return;
      void this.tick();
      this.timer = setInterval(() => void this.tick(), this.intervalMs);
      this.timer.unref();
    }, this.startDelayMs);
    this.starter.unref();
  }

  /** Stops the schedule and waits for the tick under way. A tick waiting behind it does not run. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.starter) clearTimeout(this.starter);
    if (this.timer) clearInterval(this.timer);
    this.starter = null;
    this.timer = null;
    await this.running;
    await this.next;
  }

  /**
   * Runs a tick now, or, while one runs, as soon as it ends: one tick waits at most, shared by every caller meanwhile.
   * Answers how the tick went, and never rejects.
   */
  tick(): Promise<AutoTopUpTickOutcome> {
    if (this.stopped) return Promise.resolve(IDLE);
    if (!this.running) return this.begin();
    this.next ??= this.running.then(() => {
      this.next = null;
      return this.stopped ? IDLE : (this.running ?? this.begin());
    });
    return this.next;
  }

  private begin(): Promise<AutoTopUpTickOutcome> {
    const run: Promise<AutoTopUpTickOutcome> = this.runLocked()
      .catch((error: unknown) => {
        logger.error(`[AutoTopUp] the tick failed: ${getErrorMessage(error)}`);
        return IDLE;
      })
      .finally(() => {
        if (this.running === run) this.running = null;
      });
    this.running = run;
    return run;
  }

  private async runLocked(): Promise<AutoTopUpTickOutcome> {
    const locked = await this.store.withTickLock(() => this.runJobs());
    if (!locked.locked) {
      logger.info('[AutoTopUp] another backend holds the tick lock, so this one skips the tick');
      return { state: 'locked' };
    }
    return locked.result;
  }

  /** Under the tick lock: the jobs that are not paused, in order, after one reading of the manager. */
  private async runJobs(): Promise<AutoTopUpTickOutcome> {
    const due = await this.unpaused();
    if (due.length === 0) return IDLE;
    const now = new Date(this.now());
    const settings = settingsOf(await this.store.settings());
    const funding = await this.readFunding();
    if ('problem' in funding) {
      logger.warn(`[AutoTopUp] no job ran: ${funding.problem}`);
      for (const job of due) await this.store.recordRun(job, now, false, funding.problem);
      return { state: 'unread', problem: funding.problem, jobs: due };
    }

    const ran: { job: AutoTopUpJob; result: AutoTopUpJobResult }[] = [];
    for (const job of AUTO_TOPUP_JOBS) {
      const runner = this.runners.get(job);
      // Asked again before each job, so a pause made while an earlier job ran holds this one.
      if (!runner || !(await this.unpaused()).includes(job)) continue;
      const at = new Date(this.now());
      const stamps = markedStampsOf(funding.inventory, await this.store.marks());
      let result: AutoTopUpJobResult;
      try {
        result = await runner.run({ now, settings, funding, stamps });
      } catch (error) {
        result = { ok: false, outcome: `The ${job} job stopped: ${getErrorMessage(error)}` };
      }
      if (!result.ok) logger.warn(`[AutoTopUp] the ${job} job: ${result.outcome}`);
      await this.store.recordRun(job, at, result.ok, result.outcome);
      ran.push({ job, result });
    }
    return { state: 'ran', jobs: ran };
  }

  /** The jobs with a runner that are not paused, in the order of `AUTO_TOPUP_JOBS`. */
  private async unpaused(): Promise<AutoTopUpJob[]> {
    const paused = new Set((await this.store.jobs()).filter((row) => row.paused).map((row) => row.job));
    return AUTO_TOPUP_JOBS.filter((job) => this.runners.has(job) && !paused.has(job));
  }

  /**
   * The manager read once: its inventory, the brand wallet's account while the admin holds its key, and the pins. Or
   * why no job can run on what it answered, in a sentence.
   */
  private async readFunding(): Promise<AutoTopUpFunding | { problem: string }> {
    const manager = this.manager;
    if (!manager) {
      return { problem: 'Funding is not set up: the admin has no MANAGER_API_URL and MANAGER_API_TOKEN.' };
    }
    const address = this.wallet?.address() ?? null;
    let inventory: AutoTopUpFunding['inventory'];
    let brandWallet: AutoTopUpFunding['brandWallet'];
    try {
      [inventory, brandWallet] = await Promise.all([
        manager.inventory(),
        address ? manager.account(address) : Promise.resolve(null),
      ]);
    } catch (error) {
      logger.warn(`[AutoTopUp] could not read the manager: ${getErrorMessage(error)}`);
      return { problem: `${managerProblem(error)} No job ran; the next tick reads it again.` };
    }
    for (const chainId of [inventory.chain.chainId, brandWallet?.chainId ?? ADMIN_FUNDING_CHAIN_ID]) {
      if (chainId !== ADMIN_FUNDING_CHAIN_ID) {
        return {
          problem: `The manager's nodes are on chain ${chainId}, not Gnosis Chain (${ADMIN_FUNDING_CHAIN_ID}), which the admin works with. No job ran.`,
        };
      }
    }
    const postage = inventory.chain.postage ?? null;
    if (!postage) {
      return {
        problem:
          'The manager could not read the price of postage from any node, so no top-up can be priced. No job ran; the next tick reads it again.',
      };
    }
    const pins = new Map(
      [...(await this.pins.all()).values()].map((pin) => [pin.nodeId, pin.walletAddress.toLowerCase()]),
    );
    return { inventory, postage, brandWallet, pins };
  }
}

/** The numbers in force: the saved row's, or the defaults while none were saved. */
export function settingsOf(row: AutoTopUpSettings | null): AutoTopUpSettings {
  if (!row) return { ...AUTO_TOPUP_DEFAULTS };
  return {
    topUpUnderDays: row.topUpUnderDays,
    topUpToDays: row.topUpToDays,
    lookAheadDays: row.lookAheadDays,
    marginPercent: row.marginPercent,
    xdaiWarningWei: row.xdaiWarningWei,
    dailyCeilingPlur: row.dailyCeilingPlur,
  };
}
