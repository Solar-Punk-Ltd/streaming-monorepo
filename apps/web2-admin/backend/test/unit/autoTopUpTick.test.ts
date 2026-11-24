/**
 * The tick of stamp auto top-up, against a store and a manager in memory and jobs the test writes: one reading of the
 * manager for the three jobs, run in order with each run recorded, a paused job skipped, the lock another backend
 * holds, a reading that fails, a job that throws, a tick that waits for the one under way, and the schedule. Unit
 * test, `pnpm test`.
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';

import {
  AUTO_TOPUP_DEFAULTS,
  AUTO_TOPUP_JOBS,
  type AutoTopUpJob,
  type AutoTopUpSettings,
} from '@streaming-monorepo/web2-admin-common';

import type {
  AutoTopUpJobResult,
  AutoTopUpJobRunner,
  AutoTopUpTickContext,
} from '../../src/domain/funding/autoTopUpJobs.js';
import { AutoTopUpTick, settingsOf, type AutoTopUpTickStore } from '../../src/domain/funding/AutoTopUpTick.js';
import type { SendLockOutcome } from '../../src/domain/funding/FundingTransferRepository.js';
import type {
  AutoTopUpJobRow,
  AutoTopUpMarkRow,
  AutoTopUpSettingsRow,
} from '../../src/domain/funding/StampAutoTopUpStore.js';

import {
  BATCH_STAGE,
  FakeFundingManager,
  InMemoryFundingPinStore,
  managerFailure,
  NODE_A,
  POSTAGE,
  stampInventory,
  WALLET_A,
} from './support/fundingFakes.js';

/** The brand wallet's address: a fixture of one repeated digit. */
const BRAND = '0x3333333333333333333333333333333333333333';
const NOW = Date.parse('2026-11-24T12:00:00.000Z');

/** What the tick uses of the store, in memory: the lock another backend may hold, the jobs, the marks and the runs. */
class TickStore implements AutoTopUpTickStore {
  /** True while another backend holds the tick lock. */
  heldElsewhere = false;
  saved: AutoTopUpSettingsRow | null = null;
  jobRows: AutoTopUpJobRow[] = AUTO_TOPUP_JOBS.map((job) => ({
    job,
    paused: false,
    pausedAt: null,
    pausedBy: null,
    lastRunAt: null,
    lastOk: null,
    lastOutcome: null,
  }));
  markRows: AutoTopUpMarkRow[] = [];
  readonly runs: { job: AutoTopUpJob; at: Date; ok: boolean; outcome: string }[] = [];
  lockTaken = 0;

  async withTickLock<T>(work: () => Promise<T>): Promise<SendLockOutcome<T>> {
    if (this.heldElsewhere) return { locked: false };
    this.lockTaken += 1;
    this.heldElsewhere = true;
    try {
      return { locked: true, result: await work() };
    } finally {
      this.heldElsewhere = false;
    }
  }

  async settings(): Promise<AutoTopUpSettingsRow | null> {
    return this.saved;
  }

  async jobs(): Promise<AutoTopUpJobRow[]> {
    return this.jobRows.map((row) => ({ ...row }));
  }

  async marks(): Promise<AutoTopUpMarkRow[]> {
    return this.markRows.map((row) => ({ ...row }));
  }

  async recordRun(job: AutoTopUpJob, at: Date, ok: boolean, outcome: string): Promise<void> {
    this.runs.push({ job, at, ok, outcome });
  }

  pause(job: AutoTopUpJob): void {
    this.jobRows = this.jobRows.map((row) =>
      row.job === job ? { ...row, paused: true, pausedAt: new Date(NOW), pausedBy: 'test-operator' } : row,
    );
  }
}

/** A job that records each context it is handed, and answers what the test says, after what it waits on. */
class RecordingJob implements AutoTopUpJobRunner {
  readonly contexts: AutoTopUpTickContext[] = [];
  answer: AutoTopUpJobResult | Error = { ok: true, outcome: 'Done.' };
  gate: Promise<void> | null = null;
  during: (() => void) | null = null;

  constructor(
    readonly job: AutoTopUpJob,
    private readonly order: AutoTopUpJob[],
  ) {}

  async run(context: AutoTopUpTickContext): Promise<AutoTopUpJobResult> {
    this.order.push(this.job);
    this.contexts.push(context);
    this.during?.();
    if (this.gate) await this.gate;
    if (this.answer instanceof Error) throw this.answer;
    return this.answer;
  }
}

function mark(batchId: string): AutoTopUpMarkRow {
  return {
    batchId,
    nodeId: NODE_A,
    nodeLabel: 'Main stage uploader',
    markedAt: new Date(NOW - 86_400_000),
    markedBy: 'test-operator',
    alert: null,
    unreadSince: null,
  };
}

let store: TickStore;
let manager: FakeFundingManager;
let pins: InMemoryFundingPinStore;
let order: AutoTopUpJob[];
let jobs: Record<AutoTopUpJob, RecordingJob>;

function tick(over: Partial<ConstructorParameters<typeof AutoTopUpTick>[0]> = {}): AutoTopUpTick {
  return new AutoTopUpTick({
    store,
    manager,
    wallet: { address: () => BRAND },
    pins,
    // In another order than the tick's, which runs them in its own.
    jobs: [jobs.stamp, jobs.alert, jobs.wallet],
    now: () => NOW,
    ...over,
  });
}

beforeEach(() => {
  store = new TickStore();
  manager = new FakeFundingManager();
  manager.inventoryAnswer = stampInventory();
  pins = new InMemoryFundingPinStore();
  pins.set(NODE_A, WALLET_A.toUpperCase().replace('0X', '0x'));
  order = [];
  jobs = {
    alert: new RecordingJob('alert', order),
    wallet: new RecordingJob('wallet', order),
    stamp: new RecordingJob('stamp', order),
  };
});

describe('a tick of stamp auto top-up', () => {
  it('reads the manager once and runs alert, wallet and stamp in that order, recording each run', async () => {
    store.markRows = [mark(BATCH_STAGE)];
    jobs.wallet.answer = { ok: false, outcome: 'The brand wallet cannot cover the node.' };

    const outcome = await tick().tick();

    assert.equal(outcome.state, 'ran');
    assert.deepEqual(order, ['alert', 'wallet', 'stamp']);
    assert.deepEqual(manager.calls, { inventory: 1, account: 1, relay: 0, status: 0 });
    assert.deepEqual(
      store.runs.map((run) => [run.job, run.ok, run.outcome]),
      [
        ['alert', true, 'Done.'],
        ['wallet', false, 'The brand wallet cannot cover the node.'],
        ['stamp', true, 'Done.'],
      ],
    );
    assert.deepEqual(store.runs[0]!.at, new Date(NOW));
    const [context] = jobs.alert.contexts;
    assert.deepEqual(context!.now, new Date(NOW));
    assert.deepEqual(context!.settings, AUTO_TOPUP_DEFAULTS, 'the defaults while none were saved');
    assert.deepEqual(context!.funding.postage, POSTAGE);
    assert.equal(context!.funding.brandWallet?.address, BRAND);
    assert.deepEqual([...context!.funding.pins], [[NODE_A, WALLET_A]], 'the confirmed addresses, in lower case');
    assert.deepEqual(
      context!.stamps.map((stamp) => [stamp.mark.batchId, stamp.batch?.batchId]),
      [[BATCH_STAGE, BATCH_STAGE]],
    );
    assert.equal(jobs.wallet.contexts[0]!.funding, context!.funding, 'one reading for every job');
  });

  it('hands each job the saved numbers, and the marks as they stand when it starts', async () => {
    const saved: AutoTopUpSettings = { ...AUTO_TOPUP_DEFAULTS, topUpUnderDays: 9, topUpToDays: 20, marginPercent: 5 };
    store.saved = { ...saved, updatedAt: new Date(NOW), updatedBy: 'test-operator' };
    store.markRows = [mark(BATCH_STAGE)];
    const alert = {
      days: 7,
      costPlur: '100',
      costWithMarginPlur: '105',
      sendPlur: '0',
      gasSend: false,
      recordedAt: new Date(NOW),
      alertedAt: new Date(NOW),
    };
    jobs.alert.during = () => {
      store.markRows = [{ ...store.markRows[0]!, alert }];
    };

    await tick().tick();

    assert.deepEqual(jobs.alert.contexts[0]!.settings, saved);
    assert.equal(jobs.alert.contexts[0]!.stamps[0]!.mark.alert, null);
    assert.deepEqual(jobs.wallet.contexts[0]!.stamps[0]!.mark.alert, alert, 'the alert the alert job recorded');
  });

  it('skips a paused job, and one paused while an earlier job ran', async () => {
    store.pause('alert');
    jobs.wallet.during = () => store.pause('stamp');

    await tick().tick();

    assert.deepEqual(order, ['wallet']);
    assert.deepEqual(
      store.runs.map((run) => run.job),
      ['wallet'],
      'a paused job keeps the run before the pause',
    );
  });

  it('reads nothing and runs nothing while every job is paused', async () => {
    for (const job of AUTO_TOPUP_JOBS) store.pause(job);

    assert.deepEqual(await tick().tick(), { state: 'idle' });
    assert.equal(manager.calls.inventory, 0);
    assert.deepEqual(store.runs, []);
  });

  it('skips the tick while another backend holds the lock', async () => {
    store.heldElsewhere = true;

    assert.deepEqual(await tick().tick(), { state: 'locked' });
    assert.equal(manager.calls.inventory, 0);
    assert.deepEqual(order, []);
    assert.deepEqual(store.runs, []);
  });

  it('ends the tick when the manager does not answer, has no price or is on another chain, and says why', async () => {
    store.pause('alert');
    manager.inventoryError = managerFailure('unreachable', null);
    const unreachable = await tick().tick();
    assert.equal(unreachable.state, 'unread');
    assert.deepEqual(order, []);
    assert.deepEqual(
      store.runs.map((run) => [run.job, run.ok, run.outcome]),
      [
        ['wallet', false, 'The manager could not be reached. No job ran; the next tick reads it again.'],
        ['stamp', false, 'The manager could not be reached. No job ran; the next tick reads it again.'],
      ],
    );

    manager.inventoryError = null;
    manager.inventoryAnswer = { ...stampInventory(), chain: { ...stampInventory().chain, postage: null } };
    store.runs.length = 0;
    await tick().tick();
    assert.match(store.runs[0]!.outcome, /could not read the price of postage/);

    manager.inventoryAnswer = { ...stampInventory(), chain: { ...stampInventory().chain, chainId: 10200 } };
    store.runs.length = 0;
    await tick().tick();
    assert.match(store.runs[0]!.outcome, /on chain 10200, not Gnosis Chain/);
    assert.deepEqual(order, [], 'no job ran on any of them');
  });

  it('runs with no brand wallet key, and with no manager settings it says so', async () => {
    await tick({ wallet: { address: () => null } }).tick();
    assert.equal(jobs.stamp.contexts[0]!.funding.brandWallet, null);
    assert.equal(manager.calls.account, 0);

    store.runs.length = 0;
    await tick({ manager: null }).tick();
    assert.deepEqual(
      store.runs.map((run) => run.outcome),
      AUTO_TOPUP_JOBS.map(() => 'Funding is not set up: the admin has no MANAGER_API_URL and MANAGER_API_TOKEN.'),
    );
  });

  it('records a job that throws as not ok and runs the next', async () => {
    jobs.wallet.answer = new Error('the store went away');

    await tick().tick();

    assert.deepEqual(order, ['alert', 'wallet', 'stamp']);
    assert.deepEqual(store.runs[1], {
      job: 'wallet',
      at: new Date(NOW),
      ok: false,
      outcome: 'The wallet job stopped: the store went away',
    });
  });

  it('makes a tick due while one runs wait for it, and runs one tick for every caller meanwhile', async () => {
    let release!: () => void;
    jobs.stamp.gate = new Promise((resolve) => (release = resolve));
    const ticks = tick();

    const first = ticks.tick();
    await new Promise((resolve) => setImmediate(resolve));
    const second = ticks.tick();
    const third = ticks.tick();
    assert.equal(second, third, 'one tick waits, for every caller');
    assert.equal(store.lockTaken, 1, 'the second has not started');

    jobs.stamp.gate = null;
    release();
    await first;
    await second;
    assert.equal(store.lockTaken, 2);
    assert.deepEqual(order, ['alert', 'wallet', 'stamp', 'alert', 'wallet', 'stamp']);
  });
});

describe('the schedule of the ticks', () => {
  beforeEach(() => {
    mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  });

  afterEach(() => {
    mock.timers.reset();
  });

  /** Lets the tick that a timer started run to its end. */
  async function settle(): Promise<void> {
    for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
  }

  it('runs the first tick after the start delay, then one every interval, and none once stopped', async () => {
    const ticks = tick({ startDelayMs: 180_000, intervalMs: 600_000 });
    ticks.start();

    mock.timers.tick(179_999);
    await settle();
    assert.equal(store.lockTaken, 0, 'not before the start delay');
    mock.timers.tick(1);
    await settle();
    assert.equal(store.lockTaken, 1);
    mock.timers.tick(600_000);
    await settle();
    assert.equal(store.lockTaken, 2);

    await ticks.stop();
    mock.timers.tick(1_200_000);
    await settle();
    assert.equal(store.lockTaken, 2);
    assert.deepEqual(await ticks.tick(), { state: 'idle' }, 'a stopped tick runs nothing');
  });

  it('keeps the settings a saved row holds and nothing else', () => {
    const row: AutoTopUpSettingsRow = {
      ...AUTO_TOPUP_DEFAULTS,
      dailyCeilingPlur: '5',
      updatedAt: new Date(NOW),
      updatedBy: 'test-operator',
    };
    assert.deepEqual(settingsOf(row), { ...AUTO_TOPUP_DEFAULTS, dailyCeilingPlur: '5' });
    assert.notEqual(settingsOf(null), AUTO_TOPUP_DEFAULTS, 'a copy, never the shared defaults');
  });
});
