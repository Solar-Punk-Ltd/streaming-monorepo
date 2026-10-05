/**
 * Migrations 016 and 017 against the real database: `funding_transfers` and `funding_node_pins`, and the repositories
 * the funding service keeps its journal and its pins with. Needs Postgres, like the rest of this suite;
 * `DATABASE_URL` overrides the connection.
 *
 * What the in-memory stores of the unit tests cannot stand in for is the SQL: that the send lock is one across
 * connections, taken without waiting and released when the work is over, failed or not; that a send's items are
 * journalled together or not at all, and read back in nonce order with the signed bytes as they went in; that a
 * queued or submitted item holds up a send, and an unknown one for 30 minutes from when the manager answered its relay
 * (`relayed_at`, or the journal's moment without one), as read through migration 016's partial index; that an update writes only
 * while an item is open or watched, so a late receipt turns a watched failed item confirmed and nothing moves one
 * settled for good; that only an unknown item, or a failed one with no block, is watched; that the CHECKs and the
 * unique constraints refuse what the service never writes; and that a pin replaces the one before it.
 *
 * Every row it writes is in the suite's throwaway database; it empties both tables before each test.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, beforeEach, describe, it } from 'node:test';

import { Database } from '../../src/domain/Database.js';
import { FundingPinRepository } from '../../src/domain/funding/FundingPinRepository.js';
import {
  FundingTransferRepository,
  type NewFundingTransfer,
} from '../../src/domain/funding/FundingTransferRepository.js';

import { releaseStack, requireStack, stack } from './helpers.js';

let database: Database;
let transfers: FundingTransferRepository;
let pins: FundingPinRepository;

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
