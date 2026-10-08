/**
 * Migrations 016, 017 and 018 against the real database: `funding_transfers`, `funding_node_pins` and
 * `funding_stamp_operations`, and the repositories the funding services keep their journals and their pins with.
 * Needs Postgres, like the rest of this suite; `DATABASE_URL` overrides the connection.
 *
 * What the in-memory stores of the unit tests cannot stand in for is the SQL: that the send lock is one across
 * connections, taken without waiting and released when the work is over, failed or not; that a send's items are
 * journalled together or not at all, and read back in nonce order with the signed bytes as they went in; that a
 * queued or submitted item holds up a send, and an unknown one for 30 minutes from when the manager answered its relay
 * (`relayed_at`, or the journal's moment without one), as read through migration 016's partial index; that an update writes only
 * while an item is open or watched, so a late receipt turns a watched failed item confirmed and nothing moves one
 * settled for good; that only an unknown item, or a failed one with no block, is watched; that the CHECKs and the
 * unique constraints refuse what the service never writes; and that a pin replaces the one before it. And the same of
 * the stamp journal: a request journalled together or not at all and read back in its order with its amounts as they
 * went in, what each kind carries and nothing of the other's, a batch once per request, the hold of an unknown item
 * for 30 minutes from its relay, an update only while an item is asked about that keeps a hash once known, and a
 * stamp lock of its own, which the send lock does not hold up.
 *
 * Every row it writes is in the suite's throwaway database; it empties the three tables before each test.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, beforeEach, describe, it } from 'node:test';

import { Database } from '../../src/domain/Database.js';
import { FundingPinRepository } from '../../src/domain/funding/FundingPinRepository.js';
import {
  FundingStampRepository,
  type NewFundingStampOperation,
} from '../../src/domain/funding/FundingStampRepository.js';
import {
  FundingTransferRepository,
  type NewFundingTransfer,
} from '../../src/domain/funding/FundingTransferRepository.js';

import { releaseStack, requireStack, stack } from './helpers.js';

let database: Database;
let transfers: FundingTransferRepository;
let pins: FundingPinRepository;
let stamps: FundingStampRepository;

const WALLET_A = '0x1111111111111111111111111111111111111111';
const WALLET_B = '0x2222222222222222222222222222222222222222';
/** An address with letters in it, so a test can write it in upper case. */
const WALLET_LETTERS = '0x4f0e1c2b3a49586772635441302f1e0d0c0b0a09';
const upper = (address: string) => `0x${address.slice(2).toUpperCase()}`;
/** A signed transaction's bytes as the journal keeps them: lower-case hex. Made up; nothing decodes it here. */
const RAW = `0x02${'ab'.repeat(110)}`;
const TX_HASH = `0x${'cd'.repeat(32)}`;

before(async () => {
  await requireStack();
  database = new Database(stack().databaseUrl);
  transfers = new FundingTransferRepository(database.pool);
  pins = new FundingPinRepository(database.pool);
  stamps = new FundingStampRepository(database.pool);
});

after(async () => {
  if (!database) {
    await releaseStack();
    return;
  }
  await database.close();
  await releaseStack();
});

beforeEach(async () => {
  await database.pool.query('DELETE FROM funding_transfers');
  await database.pool.query('DELETE FROM funding_node_pins');
  await database.pool.query('DELETE FROM funding_stamp_operations');
});

function item(bulkId: string, nonce: number, over: Partial<NewFundingTransfer> = {}): NewFundingTransfer {
  return {
    requestId: randomUUID(),
    bulkId,
    nodeId: `stage-1:node-${nonce}`,
    nodeLabel: `Node ${nonce}`,
    toAddress: WALLET_A,
    kind: 'xdai',
    amount: '1000000000000000000',
    nonce,
    rawTransaction: RAW,
    txHash: TX_HASH,
    requestedByUserId: null,
    requestedBy: 'alice',
    ...over,
  };
}

describe('funding_transfers', () => {
  it('journals a send queued, and reads it back in nonce order with its bytes as they went in', async () => {
    const bulkId = randomUUID();
    const big = (2n ** 256n - 1n).toString();
    await transfers.insertAll([item(bulkId, 9), item(bulkId, 7, { kind: 'xbzz', amount: big }), item(bulkId, 8)]);

    const rows = await transfers.listBulk(bulkId);

    assert.deepEqual(
      rows.map((row) => row.nonce),
      [7, 8, 9],
    );
    assert.equal(rows[0]?.amount, big);
    assert.equal(rows[0]?.kind, 'xbzz');
    for (const row of rows) {
      assert.equal(row.state, 'queued');
      assert.equal(row.rawTransaction, RAW);
      assert.equal(row.txHash, TX_HASH);
      assert.equal(row.error, null);
      assert.equal(row.blockNumber, null);
      assert.equal(row.bulkId, bulkId);
    }
    assert.deepEqual(await transfers.listBulk(randomUUID()), []);
  });

  it('journals all the items of a send or none', async () => {
    const bulkId = randomUUID();
    await assert.rejects(transfers.insertAll([item(bulkId, 1), item(bulkId, 2, { toAddress: '0xNOT-AN-ADDRESS' })]));

    assert.deepEqual(await transfers.listBulk(bulkId), []);
  });

  it('refuses what the service never writes', async () => {
    const bulkId = randomUUID();
    const refused: Partial<NewFundingTransfer>[] = [
      { amount: '0' },
      { amount: (2n ** 256n).toString() },
      { toAddress: upper(WALLET_LETTERS) },
      { rawTransaction: '0x' },
      { rawTransaction: upper(RAW) },
      { txHash: '0x1234' },
      { nodeId: 'a/b' },
      { nonce: -1 },
    ];
    for (const over of refused) {
      await assert.rejects(transfers.insertAll([item(bulkId, 1, over)]), JSON.stringify(over));
    }
    // One transfer of each kind to a node per send, and one nonce per item.
    await transfers.insertAll([item(bulkId, 1, { nodeId: 'stage-1:a' })]);
    await assert.rejects(transfers.insertAll([item(bulkId, 2, { nodeId: 'stage-1:a' })]));
    await assert.rejects(transfers.insertAll([item(bulkId, 1, { nodeId: 'stage-1:b' })]));
    await transfers.insertAll([item(bulkId, 2, { nodeId: 'stage-1:a', kind: 'xbzz' })]);
  });

  it('updates an item while it is open or watched, and never once it is settled for good', async () => {
    const bulkId = randomUUID();
    const first = item(bulkId, 1);
    await transfers.insertAll([first]);
    assert.equal((await transfers.listBulk(bulkId))[0]?.watched, false);

    const submitted = await transfers.update(first.requestId, { state: 'submitted', error: null, watched: false });
    assert.equal(submitted?.state, 'submitted');
    assert.equal(submitted?.blockNumber, null);

    const confirmed = await transfers.update(first.requestId, {
      state: 'confirmed',
      error: null,
      blockNumber: 42,
      watched: false,
    });
    assert.equal(confirmed?.state, 'confirmed');
    assert.equal(confirmed?.blockNumber, 42);
    assert.equal(confirmed?.txHash, TX_HASH);
    assert.equal(confirmed?.rawTransaction, RAW);

    assert.equal(await transfers.update(first.requestId, { state: 'failed', error: 'late', watched: false }), null);
    assert.equal((await transfers.listBulk(bulkId))[0]?.state, 'confirmed');
    assert.equal(await transfers.update(randomUUID(), { state: 'failed', error: 'none', watched: false }), null);
  });

  it('moves a watched failed item to confirmed on a late receipt, and leaves one failed for good as it is', async () => {
    const bulkId = randomUUID();
    const [refused, reverted] = [item(bulkId, 1), item(bulkId, 2)];
    await transfers.insertAll([refused, reverted]);
    await transfers.update(refused.requestId, { state: 'failed', error: 'refused by the node', watched: true });
    await transfers.update(reverted.requestId, {
      state: 'failed',
      error: 'reverted',
      blockNumber: 8,
      watched: false,
    });

    const late = await transfers.update(refused.requestId, {
      state: 'confirmed',
      error: null,
      blockNumber: 9,
      watched: false,
    });
    assert.equal(late?.state, 'confirmed');
    assert.equal(late?.blockNumber, 9);
    assert.equal(
      await transfers.update(reverted.requestId, { state: 'confirmed', error: null, blockNumber: 9, watched: false }),
      null,
    );
  });

  it('keeps watched to an unknown item, or a failed one with no block', async () => {
    const bulkId = randomUUID();
    const one = item(bulkId, 1);
    await transfers.insertAll([one]);

    await assert.rejects(transfers.update(one.requestId, { state: 'submitted', error: null, watched: true }));
    await assert.rejects(
      transfers.update(one.requestId, { state: 'failed', error: 'reverted', blockNumber: 3, watched: true }),
    );
    assert.equal(
      (await transfers.update(one.requestId, { state: 'unknown', error: null, watched: true }))?.watched,
      true,
    );
  });

  it('holds up a send for a queued or submitted item, and for an unknown one within 30 minutes of its relay', async () => {
    const journalled = new Date();
    assert.equal(await transfers.hasUnsettled(journalled), false);
    const older = randomUUID();
    const [a, b] = [item(older, 1), item(older, 2)];
    await transfers.insertAll([a, b]);
    assert.equal(await transfers.hasUnsettled(journalled), true);
    assert.deepEqual(await transfers.openBulkIds(3, journalled), [older]);
    assert.equal((await transfers.listBulk(older))[0]?.relayedAt, null, 'not relayed yet');

    // The relay lands 40 minutes after the journal, and the answer of the broadcast is lost.
    const relayed = new Date(journalled.getTime() + 40 * 60 * 1000);
    await transfers.update(a.requestId, { state: 'confirmed', error: null, watched: false, relayedAt: relayed });
    const unknown = await transfers.update(b.requestId, {
      state: 'unknown',
      error: null,
      watched: true,
      relayedAt: relayed,
    });
    assert.equal(unknown?.relayedAt?.getTime(), relayed.getTime());
    assert.equal(await transfers.hasUnsettled(relayed), true, 'a young unknown item holds up a send');
    assert.deepEqual(await transfers.openBulkIds(3, relayed), [older]);

    const thirty = 30 * 60 * 1000;
    assert.equal(await transfers.hasUnsettled(new Date(relayed.getTime() + thirty)), true, 'at 30 minutes, still');
    const later = new Date(relayed.getTime() + thirty + 1);
    assert.equal(await transfers.hasUnsettled(later), false, 'past 30 minutes, an unknown item holds up no send');
    assert.deepEqual(await transfers.openBulkIds(3, later), []);
    assert.deepEqual(await transfers.askedBulkIds(3), [older], 'and is still asked about');

    // A status read moves it without a relay: relayed_at stays.
    const read = await transfers.update(b.requestId, { state: 'unknown', error: 'still not known', watched: true });
    assert.equal(read?.relayedAt?.getTime(), relayed.getTime());

    // It reverts in a block: settled for good, asked about no more.
    await transfers.update(b.requestId, { state: 'failed', error: 'reverted', blockNumber: 4, watched: false });
    assert.deepEqual(await transfers.askedBulkIds(3), []);

    // An unknown item with no relay recorded counts from its journal, and never holds a send for good.
    const fallback = randomUUID();
    const c = item(fallback, 3);
    await transfers.insertAll([c]);
    await transfers.update(c.requestId, { state: 'unknown', error: null, watched: true });
    assert.deepEqual(await transfers.openBulkIds(3, new Date()), [fallback]);
    assert.deepEqual(await transfers.openBulkIds(3, new Date(Date.now() + thirty + 60_000)), []);
    assert.deepEqual(await transfers.askedBulkIds(3), [fallback]);
  });
});

describe('the send lock', () => {
  it('is held by one send at a time, across connections, and taken without waiting', async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const inside = new Promise<void>((resolve) => {
      entered = resolve;
    });

    const first = transfers.withSendLock(async () => {
      entered();
      await held;
      return 'first';
    });
    await inside;
    const second = await transfers.withSendLock(async () => 'second');
    release();

    assert.deepEqual(second, { locked: false });
    assert.deepEqual(await first, { locked: true, result: 'first' });
  });

  it('is released when the work is over, and when it throws', async () => {
    await assert.rejects(
      transfers.withSendLock(async () => {
        throw new Error('the work failed');
      }),
      /the work failed/,
    );
    assert.deepEqual(await transfers.withSendLock(async () => 1), { locked: true, result: 1 });
    assert.deepEqual(await transfers.withSendLock(async () => 2), { locked: true, result: 2 });
  });
});

describe('funding_node_pins', () => {
  it('pins addresses, and replaces a pin with the next', async () => {
    await pins.pin(
      [
        { nodeId: 'stage-1:uploader', walletAddress: WALLET_A },
        { nodeId: 'catalogue:uploader', walletAddress: WALLET_B },
      ],
      'alice',
    );
    await pins.pin([{ nodeId: 'stage-1:uploader', walletAddress: WALLET_B }], 'bob');

    const all = await pins.all();

    assert.equal(all.size, 2);
    assert.equal(all.get('stage-1:uploader')?.walletAddress, WALLET_B);
    assert.equal(all.get('stage-1:uploader')?.pinnedBy, 'bob');
    assert.equal(all.get('catalogue:uploader')?.walletAddress, WALLET_B);
    assert.equal(all.get('catalogue:uploader')?.pinnedBy, 'alice');
    assert.ok(all.get('stage-1:uploader')?.pinnedAt instanceof Date);
  });

  it('keeps an address in lower case, and refuses what is not one', async () => {
    await pins.pin([{ nodeId: 'stage-1:uploader', walletAddress: upper(WALLET_LETTERS) }], 'alice');
    assert.equal((await pins.all()).get('stage-1:uploader')?.walletAddress, WALLET_LETTERS);

    await assert.rejects(pins.pin([{ nodeId: 'stage-1:gateway', walletAddress: '0x1234' }], 'alice'));
    await assert.rejects(pins.pin([{ nodeId: 'a/b', walletAddress: WALLET_A }], 'alice'));
    assert.equal((await pins.all()).size, 1);
  });
});

/** A batch id as the journal keeps it: 0x and 64 hex digits in lower case. */
const batchOf = (byte: string) => `0x${byte.repeat(32)}`;
const MAX_UINT256 = (2n ** 256n - 1n).toString();

function topUpItem(
  bulkId: string,
  position: number,
  over: Partial<NewFundingStampOperation> = {},
): NewFundingStampOperation {
  return {
    requestId: randomUUID(),
    bulkId,
    position,
    nodeId: `stage-1:node-${position}`,
    nodeLabel: `Node ${position}`,
    batchId: batchOf(`a${position}`),
    kind: 'topup',
    days: 30,
    steps: null,
    expectedDepth: 20,
    newDepth: null,
    amountPerChunkPlur: '12441600000',
    costPlur: '13045963161600000',
    requestedByUserId: null,
    requestedBy: 'alice',
    ...over,
  };
}

function diluteItem(
  bulkId: string,
  position: number,
  over: Partial<NewFundingStampOperation> = {},
): NewFundingStampOperation {
  return {
    ...topUpItem(bulkId, position),
    kind: 'dilute',
    days: null,
    steps: 2,
    newDepth: 22,
    amountPerChunkPlur: null,
    costPlur: null,
    ...over,
  };
}

describe('funding_stamp_operations', () => {
  it('journals a request queued, and reads it back in its order with every field as it went in', async () => {
    const bulkId = randomUUID();
    const big = topUpItem(bulkId, 0, { amountPerChunkPlur: MAX_UINT256, costPlur: MAX_UINT256, days: 2 ** 31 - 1 });
    await stamps.insertAll([topUpItem(bulkId, 2), big, topUpItem(bulkId, 1)]);

    const rows = await stamps.listBulk(bulkId);

    assert.deepEqual(
      rows.map((row) => row.position),
      [0, 1, 2],
    );
    assert.deepEqual(
      [rows[0]?.amountPerChunkPlur, rows[0]?.costPlur, rows[0]?.days],
      [MAX_UINT256, MAX_UINT256, 2 ** 31 - 1],
    );
    const [, second] = rows;
    assert.deepEqual(
      [
        second?.kind,
        second?.nodeId,
        second?.nodeLabel,
        second?.batchId,
        second?.days,
        second?.steps,
        second?.expectedDepth,
        second?.newDepth,
        second?.amountPerChunkPlur,
        second?.costPlur,
        second?.requestedBy,
        second?.requestedByUserId,
      ],
      [
        'topup',
        'stage-1:node-1',
        'Node 1',
        batchOf('a1'),
        30,
        null,
        20,
        null,
        '12441600000',
        '13045963161600000',
        'alice',
        null,
      ],
    );
    for (const row of rows) {
      assert.equal(row.state, 'queued');
      assert.equal(row.txHash, null);
      assert.equal(row.error, null);
      assert.equal(row.relayedAt, null);
      assert.equal(row.bulkId, bulkId);
    }
    assert.deepEqual(await stamps.listBulk(randomUUID()), []);
  });

  it('journals a dilution with its steps and its new depth, and no amount', async () => {
    const bulkId = randomUUID();
    await stamps.insertAll([diluteItem(bulkId, 0), diluteItem(bulkId, 1, { steps: 1, newDepth: 21 })]);

    const rows = await stamps.listBulk(bulkId);

    assert.deepEqual(
      rows.map((row) => [
        row.kind,
        row.days,
        row.steps,
        row.expectedDepth,
        row.newDepth,
        row.amountPerChunkPlur,
        row.costPlur,
      ]),
      [
        ['dilute', null, 2, 20, 22, null, null],
        ['dilute', null, 1, 20, 21, null, null],
      ],
    );
  });

  it('journals all the items of a request or none', async () => {
    const bulkId = randomUUID();
    await assert.rejects(stamps.insertAll([topUpItem(bulkId, 0), topUpItem(bulkId, 1, { batchId: '0xNOT-A-BATCH' })]));

    assert.deepEqual(await stamps.listBulk(bulkId), []);
  });

  it('refuses what the service never writes', async () => {
    const bulkId = randomUUID();
    const refused: NewFundingStampOperation[] = [
      topUpItem(bulkId, 0, { amountPerChunkPlur: '0' }),
      topUpItem(bulkId, 0, { costPlur: (2n ** 256n).toString() }),
      topUpItem(bulkId, 0, { batchId: batchOf('A1') }),
      topUpItem(bulkId, 0, { batchId: '0x1234' }),
      topUpItem(bulkId, 0, { nodeId: 'a/b' }),
      topUpItem(bulkId, 0, { nodeLabel: '' }),
      topUpItem(bulkId, 0, { days: 0 }),
      topUpItem(bulkId, 0, { position: -1 }),
      topUpItem(bulkId, 0, { expectedDepth: 256 }),
      // What a top-up carries, and nothing of a dilution's.
      topUpItem(bulkId, 0, { amountPerChunkPlur: null }),
      topUpItem(bulkId, 0, { days: null }),
      topUpItem(bulkId, 0, { steps: 1 }),
      topUpItem(bulkId, 0, { newDepth: 21 }),
      // What a dilution carries, and nothing of a top-up's.
      // Three steps, which the service never takes: the type refuses it, the CHECK as well.
      diluteItem(bulkId, 0, { steps: 3 as unknown as 1, newDepth: 23 }),
      diluteItem(bulkId, 0, { newDepth: 21 }),
      diluteItem(bulkId, 0, { days: 30 }),
      diluteItem(bulkId, 0, { costPlur: '1' }),
      diluteItem(bulkId, 0, { expectedDepth: 255, steps: 1, newDepth: 256 }),
    ];
    for (const item of refused) {
      await assert.rejects(stamps.insertAll([item]), JSON.stringify(item));
    }
    // A batch at most once in a request, and one item at each place of it.
    await stamps.insertAll([topUpItem(bulkId, 0)]);
    await assert.rejects(stamps.insertAll([topUpItem(bulkId, 1, { batchId: batchOf('a0') })]));
    await assert.rejects(stamps.insertAll([topUpItem(bulkId, 0, { batchId: batchOf('b0') })]));
    await stamps.insertAll([topUpItem(randomUUID(), 0)]);
  });

  it('updates an item while it is asked about, keeps a hash once known, and never moves one settled for good', async () => {
    const bulkId = randomUUID();
    const item = topUpItem(bulkId, 0);
    await stamps.insertAll([item]);
    const hash = `0x${'cd'.repeat(32)}`;
    const answered = new Date('2026-10-08T12:00:00.000Z');

    const unknown = await stamps.update(item.requestId, {
      state: 'unknown',
      error: 'The node did not answer in time.',
      txHash: hash,
      relayedAt: answered,
    });
    assert.deepEqual(
      [unknown?.state, unknown?.error, unknown?.txHash, unknown?.relayedAt?.getTime()],
      ['unknown', 'The node did not answer in time.', hash, answered.getTime()],
    );

    const confirmed = await stamps.update(item.requestId, { state: 'confirmed', error: null, txHash: null });
    assert.deepEqual(
      [confirmed?.state, confirmed?.error, confirmed?.txHash, confirmed?.relayedAt?.getTime()],
      ['confirmed', null, hash, answered.getTime()],
    );

    assert.equal(await stamps.update(item.requestId, { state: 'failed', error: 'late' }), null);
    assert.equal((await stamps.listBulk(bulkId))[0]?.state, 'confirmed');
    assert.equal(await stamps.update(randomUUID(), { state: 'failed', error: 'none' }), null);

    const other = topUpItem(bulkId, 1);
    await stamps.insertAll([other]);
    await assert.rejects(
      stamps.update(other.requestId, { state: 'submitted', error: null, txHash: '0x12' }),
      'a hash is 0x and 64 hex digits',
    );
    await stamps.update(other.requestId, { state: 'failed', error: 'The manager refused it.' });
    assert.equal(await stamps.update(other.requestId, { state: 'confirmed', error: null }), null, 'failed is final');
  });

  it('holds up a bulk for a queued or submitted item, and an unknown one for 30 minutes from its relay', async () => {
    const journalled = new Date();
    assert.equal(await stamps.hasUnsettled(journalled), false);
    const older = randomUUID();
    const [a, b] = [topUpItem(older, 0), topUpItem(older, 1)];
    await stamps.insertAll([a, b]);
    assert.equal(await stamps.hasUnsettled(journalled), true);
    assert.deepEqual(await stamps.openBulkIds(3, journalled), [older]);
    assert.deepEqual(await stamps.askedBulkIds(3), [older]);

    // The relays land 40 minutes after the journal: one confirmed, the other's answer lost.
    const relayed = new Date(journalled.getTime() + 40 * 60 * 1000);
    await stamps.update(a.requestId, { state: 'confirmed', error: null, relayedAt: relayed });
    await stamps.update(b.requestId, { state: 'unknown', error: null, relayedAt: relayed });
    assert.equal(await stamps.hasUnsettled(relayed), true, 'a young unknown item holds up a bulk');

    const thirty = 30 * 60 * 1000;
    assert.equal(await stamps.hasUnsettled(new Date(relayed.getTime() + thirty)), true, 'at 30 minutes, still');
    const later = new Date(relayed.getTime() + thirty + 1);
    assert.equal(await stamps.hasUnsettled(later), false, 'past 30 minutes, an unknown item holds up no bulk');
    assert.deepEqual(await stamps.openBulkIds(3, later), []);
    assert.deepEqual(await stamps.askedBulkIds(3), [older], 'and is still asked about');

    // The manager settles it from the chain: asked about no more.
    await stamps.update(b.requestId, { state: 'failed', error: 'The manager found nothing on chain for it.' });
    assert.deepEqual(await stamps.askedBulkIds(3), []);

    // A submitted item holds up a bulk whatever its age.
    const submitted = topUpItem(randomUUID(), 0);
    await stamps.insertAll([submitted]);
    await stamps.update(submitted.requestId, { state: 'submitted', error: null, relayedAt: relayed });
    assert.equal(await stamps.hasUnsettled(new Date(relayed.getTime() + 24 * 60 * thirty)), true);
  });
});

describe('the stamp lock', () => {
  it('is held by one request at a time, across connections, and taken without waiting', async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const inside = new Promise<void>((resolve) => {
      entered = resolve;
    });

    const first = stamps.withStampLock(async () => {
      entered();
      await held;
      return 'first';
    });
    await inside;
    const second = await stamps.withStampLock(async () => 'second');
    // A send is not held up by a stamp request, nor the other way round.
    const send = await transfers.withSendLock(async () => 'send');
    release();

    assert.deepEqual(second, { locked: false });
    assert.deepEqual(send, { locked: true, result: 'send' });
    assert.deepEqual(await first, { locked: true, result: 'first' });
  });

  it('is released when the work is over, and when it throws', async () => {
    await assert.rejects(
      stamps.withStampLock(async () => {
        throw new Error('the work failed');
      }),
      /the work failed/,
    );
    assert.deepEqual(await stamps.withStampLock(async () => 1), { locked: true, result: 1 });
  });
});
