/**
 * Migrations 034 and 035 against the real database, through the repository stamp auto top-up keeps its state with:
 * the settings, the three jobs, the marks with their alerts, the warnings, the notices row, the tick's lock, and the
 * two reads of the journals' system rows. Needs Postgres, like the rest of this suite; `DATABASE_URL`
 * overrides the connection.
 *
 * Every row it writes is in the suite's throwaway database; it empties the tables before each test.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, beforeEach, describe, it } from 'node:test';

import { AUTO_TOPUP_DEFAULTS } from '@streaming-monorepo/web2-admin-common';

import { Database } from '../../src/domain/Database.js';
import {
  FundingStampRepository,
  type NewFundingStampOperation,
} from '../../src/domain/funding/FundingStampRepository.js';
import {
  FundingTransferRepository,
  type NewFundingTransfer,
} from '../../src/domain/funding/FundingTransferRepository.js';
import { StampAutoTopUpRepository } from '../../src/domain/funding/StampAutoTopUpRepository.js';
import type { AutoTopUpAlert } from '../../src/domain/funding/StampAutoTopUpStore.js';

import { releaseStack, requireStack, stack } from './helpers.js';

let database: Database;
let store: StampAutoTopUpRepository;
let transfers: FundingTransferRepository;
let stamps: FundingStampRepository;

const batchOf = (byte: string) => `0x${byte.repeat(32)}`;
const BATCH_A = batchOf('a1');
const BATCH_B = batchOf('b2');
const AT = new Date('2026-11-24T10:00:00.000Z');
const LATER = new Date('2026-11-24T11:00:00.000Z');

function alert(over: Partial<AutoTopUpAlert> = {}): AutoTopUpAlert {
  return {
    days: 7,
    costPlur: '1000',
    costWithMarginPlur: '1100',
    sendPlur: '500',
    gasSend: true,
    recordedAt: AT,
    alertedAt: null,
    ...over,
  };
}

function transfer(over: Partial<NewFundingTransfer> = {}): NewFundingTransfer {
  return {
    requestId: randomUUID(),
    bulkId: randomUUID(),
    nodeId: 'stage-1:node-1',
    nodeLabel: 'Node 1',
    toAddress: '0x1111111111111111111111111111111111111111',
    kind: 'xbzz',
    amount: '1000',
    nonce: 1,
    rawTransaction: `0x02${'ab'.repeat(110)}`,
    txHash: `0x${'cd'.repeat(32)}`,
    requestedByUserId: null,
    requestedBy: 'stamp auto top-up',
    requestedByKind: 'system',
    ...over,
  };
}

function topUp(batchId: string, over: Partial<NewFundingStampOperation> = {}): NewFundingStampOperation {
  return {
    requestId: randomUUID(),
    bulkId: randomUUID(),
    position: 0,
    nodeId: 'stage-1:node-1',
    nodeLabel: 'Node 1',
    batchId,
    kind: 'topup',
    days: 7,
    steps: null,
    expectedDepth: 20,
    newDepth: null,
    amountPerChunkPlur: '12441600000',
    costPlur: '13045963161600000',
    requestedByUserId: null,
    requestedBy: 'stamp auto top-up',
    requestedByKind: 'system',
    ...over,
  };
}

/** Sets a journal row's moment, as an older row would carry it. */
async function journalledAt(table: 'funding_transfers' | 'funding_stamp_operations', requestId: string, at: Date) {
  await database.pool.query(`UPDATE ${table} SET created_at = $2 WHERE request_id = $1`, [requestId, at]);
}

before(async () => {
  await requireStack();
  database = new Database(stack().databaseUrl);
  store = new StampAutoTopUpRepository(database.pool);
  transfers = new FundingTransferRepository(database.pool);
  stamps = new FundingStampRepository(database.pool);
});

after(async () => {
  if (database) await database.close();
  await releaseStack();
});

beforeEach(async () => {
  await database.pool.query('DELETE FROM stamp_auto_topup_warnings');
  await database.pool.query('DELETE FROM stamp_auto_topup_marks');
  await database.pool.query('DELETE FROM stamp_auto_topup_settings');
  await database.pool.query(
    `UPDATE stamp_auto_topup_jobs SET paused = FALSE, paused_at = NULL, paused_by = NULL,
            last_run_at = NULL, last_ok = NULL, last_outcome = NULL`,
  );
  await database.pool.query('UPDATE stamp_auto_topup_notices SET last_coming_at = NULL, last_repeat_at = NULL');
  await database.pool.query('DELETE FROM funding_transfers');
  await database.pool.query('DELETE FROM funding_stamp_operations');
});

describe('stamp auto top-up settings', () => {
  it('reads null while none were saved, and the row once saved and saved again', async () => {
    assert.equal(await store.settings(), null);

    await store.saveSettings(AUTO_TOPUP_DEFAULTS, 'operator-a', AT);
    await store.saveSettings(
      { ...AUTO_TOPUP_DEFAULTS, marginPercent: 20, dailyCeilingPlur: '5000' },
      'operator-b',
      LATER,
    );

    assert.deepEqual(await store.settings(), {
      ...AUTO_TOPUP_DEFAULTS,
      marginPercent: 20,
      dailyCeilingPlur: '5000',
      updatedAt: LATER,
      updatedBy: 'operator-b',
    });
  });

  it('keeps an amount past a JavaScript number exactly', async () => {
    const big = (2n ** 200n).toString();
    await store.saveSettings({ ...AUTO_TOPUP_DEFAULTS, xdaiWarningWei: big, dailyCeilingPlur: big }, 'operator-a', AT);

    const read = await store.settings();
    assert.equal(read?.xdaiWarningWei, big);
    assert.equal(read?.dailyCeilingPlur, big);
  });

  it('is refused by the table when the level is not over the threshold', async () => {
    await assert.rejects(() =>
      store.saveSettings({ ...AUTO_TOPUP_DEFAULTS, topUpUnderDays: 14, topUpToDays: 14 }, 'operator-a', AT),
    );
  });
});

describe('stamp auto top-up jobs', () => {
  it('lists the three jobs in order, pauses one with who and when, and resumes it', async () => {
    assert.deepEqual(
      (await store.jobs()).map((job) => job.job),
      ['alert', 'wallet', 'stamp'],
    );

    await store.setPaused('wallet', true, 'operator-a', AT);
    const paused = (await store.jobs())[1]!;
    assert.deepEqual([paused.paused, paused.pausedBy, paused.pausedAt], [true, 'operator-a', AT]);

    await store.setPaused('wallet', false, 'operator-b', LATER);
    const resumed = (await store.jobs())[1]!;
    assert.deepEqual([resumed.paused, resumed.pausedBy, resumed.pausedAt], [false, null, null]);
  });

  it('records a run, which a pause keeps', async () => {
    await store.recordRun('stamp', AT, false, 'The manager could not be read.');
    await store.setPaused('stamp', true, 'operator-a', LATER);

    const job = (await store.jobs())[2]!;
    assert.deepEqual([job.lastRunAt, job.lastOk, job.lastOutcome], [AT, false, 'The manager could not be read.']);
  });
});

describe('stamp auto top-up marks', () => {
  it('marks stamps the earliest first, and keeps a stamp marked already as it is', async () => {
    await store.mark([{ batchId: BATCH_B, nodeId: 'stage-1:node-2', nodeLabel: 'Node 2' }], 'operator-a', AT);
    await store.mark(
      [
        { batchId: BATCH_A, nodeId: 'stage-1:node-1', nodeLabel: 'Node 1' },
        { batchId: BATCH_B, nodeId: 'other', nodeLabel: 'Other' },
      ],
      'operator-b',
      LATER,
    );

    const marks = await store.marks();
    assert.deepEqual(
      marks.map((mark) => [mark.batchId, mark.nodeId, mark.markedBy, mark.markedAt.toISOString()]),
      [
        [BATCH_B, 'stage-1:node-2', 'operator-a', AT.toISOString()],
        [BATCH_A, 'stage-1:node-1', 'operator-b', LATER.toISOString()],
      ],
    );
    assert.ok(marks.every((mark) => mark.alert === null && mark.unreadSince === null));
  });

  it('records an alert whole, gives it once, and clears it', async () => {
    await store.mark([{ batchId: BATCH_A, nodeId: 'stage-1:node-1', nodeLabel: 'Node 1' }], 'operator-a', AT);

    await store.setAlert(BATCH_A, alert());
    assert.deepEqual((await store.marks())[0]?.alert, alert());

    await store.setAlerted([BATCH_A], AT);
    await store.setAlerted([BATCH_A], LATER);
    assert.deepEqual((await store.marks())[0]?.alert?.alertedAt, AT, 'an alert given keeps its moment');

    await store.setAlert(BATCH_A, null);
    assert.equal((await store.marks())[0]?.alert, null);
    await store.setAlerted([BATCH_A], LATER);
    assert.equal((await store.marks())[0]?.alert, null, 'no alert is given where none is recorded');
  });

  it('refuses an alert whose cost with margin is under its cost', async () => {
    await store.mark([{ batchId: BATCH_A, nodeId: 'stage-1:node-1', nodeLabel: 'Node 1' }], 'operator-a', AT);

    await assert.rejects(() => store.setAlert(BATCH_A, alert({ costWithMarginPlur: '999' })));
  });

  it('records since when a stamp reads badly, and clears it', async () => {
    await store.mark([{ batchId: BATCH_A, nodeId: 'stage-1:node-1', nodeLabel: 'Node 1' }], 'operator-a', AT);

    await store.setUnreadSince(BATCH_A, AT);
    assert.deepEqual((await store.marks())[0]?.unreadSince, AT);
    await store.setUnreadSince(BATCH_A, null);
    assert.equal((await store.marks())[0]?.unreadSince, null);
  });

  it('takes the mark off with its alert and its warnings, and leaves the wallet warnings', async () => {
    await store.mark(
      [
        { batchId: BATCH_A, nodeId: 'stage-1:node-1', nodeLabel: 'Node 1' },
        { batchId: BATCH_B, nodeId: 'stage-1:node-2', nodeLabel: 'Node 2' },
      ],
      'operator-a',
      AT,
    );
    await store.setAlert(BATCH_A, alert());
    await store.raiseWarning({ kind: 'topup_failed', batchId: BATCH_A }, 'The top-up failed.', AT);
    await store.raiseWarning({ kind: 'stamp_expired', batchId: BATCH_B }, 'It expired.', AT);
    await store.raiseWarning({ kind: 'wallet_xbzz', batchId: null }, 'The wallet is low.', AT);

    await store.unmark([BATCH_A]);

    assert.deepEqual(
      (await store.marks()).map((mark) => mark.batchId),
      [BATCH_B],
    );
    assert.deepEqual(
      (await store.warnings()).map((warning) => [warning.kind, warning.batchId]),
      [
        ['stamp_expired', BATCH_B],
        ['wallet_xbzz', null],
      ],
    );
  });

  it('refuses a batch id that is not 0x and 64 lower-case hex digits', async () => {
    await assert.rejects(() =>
      store.mark([{ batchId: BATCH_A.toUpperCase(), nodeId: 'stage-1:node-1', nodeLabel: 'Node 1' }], 'operator-a', AT),
    );
  });
});

describe('stamp auto top-up warnings', () => {
  it('raises a warning once, words it anew keeping its since and its notifiedAt, and clears it', async () => {
    await store.raiseWarning({ kind: 'wallet_xdai', batchId: null }, 'Low on xDAI.', AT);
    await store.setWarningsNotified([{ kind: 'wallet_xdai', batchId: null }], AT);
    await store.raiseWarning({ kind: 'wallet_xdai', batchId: null }, 'Lower on xDAI.', LATER);

    assert.deepEqual(await store.warnings(), [
      { kind: 'wallet_xdai', batchId: null, since: AT, message: 'Lower on xDAI.', notifiedAt: AT },
    ]);

    await store.clearWarning({ kind: 'wallet_xdai', batchId: null });
    assert.deepEqual(await store.warnings(), []);
  });

  it('marks as notified only the warnings named, a stamp warning among them', async () => {
    await store.mark([{ batchId: BATCH_A, nodeId: 'stage-1:node-1', nodeLabel: 'Node 1' }], 'operator-a', AT);
    await store.raiseWarning({ kind: 'topup_failed', batchId: BATCH_A }, 'The top-up failed.', AT);
    await store.raiseWarning({ kind: 'wallet_xbzz', batchId: null }, 'The wallet is low.', AT);

    await store.setWarningsNotified([{ kind: 'topup_failed', batchId: BATCH_A }], LATER);

    const notified = Object.fromEntries((await store.warnings()).map((row) => [row.kind, row.notifiedAt]));
    assert.deepEqual(notified, { topup_failed: LATER, wallet_xbzz: null });
  });

  it('refuses a stamp warning for a stamp that is not marked', async () => {
    await assert.rejects(() => store.raiseWarning({ kind: 'stamp_expired', batchId: BATCH_A }, 'It expired.', AT));
  });
});

describe('stamp auto top-up notices', () => {
  it('reads the row empty, and writes the columns named alone', async () => {
    assert.deepEqual(await store.notices(), { lastComingAt: null, lastRepeatAt: null });

    await store.recordNotices({ lastComingAt: AT });
    await store.recordNotices({ lastRepeatAt: LATER });
    await store.recordNotices({});
    assert.deepEqual(await store.notices(), { lastComingAt: AT, lastRepeatAt: LATER });

    await store.recordNotices({ lastComingAt: null });
    assert.deepEqual(await store.notices(), { lastComingAt: null, lastRepeatAt: LATER });
  });
});

describe("stamp auto top-up's tick lock", () => {
  it('is refused to a second taker while held, across connections, and taken again once the work is over', async () => {
    const otherDatabase = new Database(stack().databaseUrl);
    const other = new StampAutoTopUpRepository(otherDatabase.pool);
    try {
      let inner: unknown = null;
      const outer = await store.withTickLock(async () => {
        inner = await other.withTickLock(async () => 'ran');
        return 'held';
      });

      assert.deepEqual(outer, { locked: true, result: 'held' });
      assert.deepEqual(inner, { locked: false });
      assert.deepEqual(await other.withTickLock(async () => 'ran'), { locked: true, result: 'ran' });
    } finally {
      await otherDatabase.close();
    }
  });

  it('is released when the work fails', async () => {
    await assert.rejects(() =>
      store.withTickLock(async () => {
        throw new Error('the work failed');
      }),
    );

    assert.deepEqual(await store.withTickLock(async () => 'ran'), { locked: true, result: 'ran' });
  });
});

describe("the journals' system rows", () => {
  it("answers each stamp's latest system top-up that did not fail, and nothing of a person's", async () => {
    const older = topUp(BATCH_A, { days: 3 });
    const newer = topUp(BATCH_A, { days: 5 });
    const failed = topUp(BATCH_A, { days: 9 });
    const operators = topUp(BATCH_B, { requestedByKind: 'operator', requestedBy: 'operator-a' });
    await stamps.insertAll([older]);
    await stamps.insertAll([newer]);
    await stamps.insertAll([failed]);
    await stamps.insertAll([operators]);
    await journalledAt('funding_stamp_operations', older.requestId, AT);
    await journalledAt('funding_stamp_operations', newer.requestId, LATER);
    await journalledAt('funding_stamp_operations', failed.requestId, new Date(LATER.getTime() + 60_000));
    await stamps.update(failed.requestId, { state: 'failed', error: 'refused' });

    const topUps = await store.lastSystemTopUps([BATCH_A, BATCH_B]);

    assert.deepEqual(topUps, [
      { batchId: BATCH_A, at: LATER, days: 5, costPlur: '13045963161600000', state: 'queued' },
    ]);
  });

  it('sums the system xBZZ sent since a moment that did not fail, and names the nodes sent gas', async () => {
    const before = transfer({ amount: '7' });
    const xbzz = transfer({ amount: (2n ** 100n).toString() });
    const second = transfer({ amount: '3' });
    const failed = transfer({ amount: '1000' });
    const gas = transfer({ kind: 'xdai', nodeId: 'stage-1:node-9', amount: '10' });
    const operators = transfer({ requestedByKind: 'operator', requestedBy: 'operator-a', amount: '5' });
    await transfers.insertAll([before, xbzz, second, failed, gas, operators]);
    await journalledAt('funding_transfers', before.requestId, AT);
    for (const row of [xbzz, second, failed, gas, operators]) {
      await journalledAt('funding_transfers', row.requestId, LATER);
    }
    await transfers.update(failed.requestId, { state: 'failed', error: 'refused', watched: false });

    const sends = await store.systemSendsSince(new Date(AT.getTime() + 1));

    assert.deepEqual(sends, { xbzzPlur: (2n ** 100n + 3n).toString(), gasNodeIds: ['stage-1:node-9'] });
  });

  it('answers nothing sent when the system sent nothing', async () => {
    assert.deepEqual(await store.systemSendsSince(AT), { xbzzPlur: '0', gasNodeIds: [] });
    assert.deepEqual(await store.lastSystemTopUps([BATCH_A]), []);
  });
});
