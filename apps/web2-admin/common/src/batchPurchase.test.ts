import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { FUNDING_PURCHASE_APPLY_STATES, type FundingBatch } from '@streaming-monorepo/contracts';

import {
  BATCH_BUY_MIN_DAYS,
  BATCH_PURCHASE_APPLY_TEXT,
  type BatchBuyChoice,
  batchBuyAmountPerChunkPlur,
  batchBuyCostPlur,
  batchBuyDepthRange,
  batchBuyProblem,
  batchBuyQuote,
  batchOffersPurchase,
  boughtBatchRanOut,
  batchPurchaseHoldsNode,
  batchPurchaseOffersCheck,
  batchPurchasePurpose,
  batchPurchaseStageRestartable,
  fundingBatchPurchaseAdminPath,
  fundingBatchPurchaseCheckAdminPath,
  fundingBatchPurchaseRestartAdminPath,
} from './batchPurchase.js';

const postage = { pricePerChunkPerBlockPlur: '24000', blockSeconds: 5, minimumValidityBlocks: 17280 };
const replacement = { depth: 22, immutable: false };
const batch = (over: Partial<FundingBatch> = {}): FundingBatch => ({
  batchId: `0x${'c3'.repeat(32)}`,
  depth: 22,
  immutable: false,
  usable: true,
  ttlSeconds: 86_400,
  fillRatio: 0.1,
  readError: null,
  ...over,
});

describe('where a purchase is asked for', () => {
  it('has the purchase, its restart and its check under the Funding page', () => {
    assert.equal(fundingBatchPurchaseAdminPath('a b'), '/api/funding/batch-purchases/a%20b');
    assert.equal(fundingBatchPurchaseRestartAdminPath('p1'), '/api/funding/batch-purchases/p1/restart');
    assert.equal(fundingBatchPurchaseCheckAdminPath('p1'), '/api/funding/batch-purchases/p1/check');
  });
});

describe('which row offers Buy new', () => {
  it('offers it for a node with no batch, an expired batch and one its node holds no more', () => {
    assert.equal(batchOffersPurchase({ batch: null, replacement }), true);
    assert.equal(batchOffersPurchase({ batch: batch({ state: 'expired', ttlSeconds: 0 }), replacement }), true);
    assert.equal(
      batchOffersPurchase({ batch: batch({ state: 'gone', depth: null, ttlSeconds: null }), replacement }),
      true,
    );
  });

  it('leaves a batch that works, is ending, is full or was not read to its top-up and dilution', () => {
    for (const state of ['active', 'pending', 'full', 'unknown'] as const) {
      assert.equal(batchOffersPurchase({ batch: batch({ state }), replacement }), false, state);
    }
    assert.equal(batchOffersPurchase({ batch: batch({ state: 'active', ttlSeconds: 3600 }), replacement }), false);
  });

  it('reads no time left as expired when the manager gives no verdict', () => {
    assert.equal(batchOffersPurchase({ batch: batch({ ttlSeconds: 0 }), replacement }), true);
    assert.equal(batchOffersPurchase({ batch: batch({ ttlSeconds: null }), replacement }), false);
  });

  it('offers nothing where the manager recommends no replacement: a gateway, an older manager', () => {
    assert.equal(batchOffersPurchase({ batch: null, replacement: null }), false);
    assert.equal(batchOffersPurchase({ batch: null }), false);
  });

  it('buys for the catalogue on the catalogue node and for a rung on any other', () => {
    assert.equal(batchPurchasePurpose(true), 'catalogue');
    assert.equal(batchPurchasePurpose(false), 'rung');
    assert.deepEqual([...batchBuyDepthRange('rung')], [17, 40]);
    assert.deepEqual([...batchBuyDepthRange('catalogue')], [18, 40]);
  });
});

describe('the calculator', () => {
  it('gives each chunk the price of every block of the days, the blocks rounded up', () => {
    assert.equal(batchBuyAmountPerChunkPlur(2, postage), (34_560n * 24_000n).toString());
    assert.equal(batchBuyAmountPerChunkPlur(2, { ...postage, blockSeconds: 7 }), (24_686n * 24_000n).toString());
    for (const days of [0, 1, 2.5, Number.NaN])
      assert.throws(() => batchBuyAmountPerChunkPlur(days, postage), RangeError);
    assert.equal(BATCH_BUY_MIN_DAYS, 2);
  });

  it('costs the amount for every chunk of the batch', () => {
    assert.equal(batchBuyCostPlur(17, '10'), (10n * 131_072n).toString());
    assert.equal(batchBuyCostPlur(22, '829440000'), (829_440_000n * 4_194_304n).toString());
    assert.throws(() => batchBuyCostPlur(-1, '10'), RangeError);
  });

  it('shows the cost, the life, the size and what the wallet is short of', () => {
    const cost = 829_440_000n * 3n * 4_194_304n;
    const quote = batchBuyQuote({ depth: 22, days: 6, postage, walletXbzzPlur: (cost - 5n).toString() });
    assert.equal(quote.costPlur, cost.toString());
    assert.equal(quote.ttlSeconds, 6 * 86_400);
    assert.equal(quote.chunks, 4_194_304);
    assert.equal(quote.bytes, 4_194_304 * 4096);
    assert.equal(quote.shortfallPlur, '5');
    assert.equal(batchBuyQuote({ depth: 22, days: 6, postage, walletXbzzPlur: cost.toString() }).shortfallPlur, null);
    assert.equal(batchBuyQuote({ depth: 22, days: 6, postage, walletXbzzPlur: null }).shortfallPlur, null);
  });

  /**
   * A chunk's address picks one of 65536 buckets, and a batch is full once its fullest bucket is, long before all
   * `2^depth` of its stamps are used. What the dialog says a batch holds is that point, from the table that sizes an
   * archive stamp: Swarm's effective volume of an unencrypted batch without erasure coding.
   */
  it('says what the batch holds before its fullest bucket fills', () => {
    const at = (depth: number) => batchBuyQuote({ depth, days: 6, postage, walletXbzzPlur: null });
    assert.equal(at(17).effectiveBytes, 44_700);
    assert.equal(at(17).effectiveChunks, 10);
    assert.equal(at(20).effectiveBytes, 687_620_000);
    assert.equal(at(20).effectiveChunks, 167_875);
    assert.equal(at(22).effectiveBytes, 7_730_000_000);
    assert.equal(at(22).effectiveChunks, 1_887_207);
    assert.equal(at(40).effectiveBytes, 4_460_000_000_000_000);
  });
});

describe('why a choice cannot be bought', () => {
  const cost = batchBuyCostPlur(22, batchBuyAmountPerChunkPlur(30, postage));
  const choice = (over: Partial<BatchBuyChoice> = {}): BatchBuyChoice => ({
    depth: 22,
    immutable: false,
    days: 30,
    costPlur: cost,
    ...over,
  });
  const terms = { postage, walletXbzzPlur: cost, walletXdaiWei: '1' };

  it('is nothing for a choice the wallet covers at the price read now', () => {
    assert.equal(batchBuyProblem('rung', choice(), terms), null);
    assert.equal(batchBuyProblem('rung', choice(), { ...terms, walletXbzzPlur: null, walletXdaiWei: null }), null);
  });

  it('is the depth outside what the purpose takes, and a mutable catalogue batch', () => {
    assert.match(batchBuyProblem('rung', choice({ depth: 16 }), terms) ?? '', /17 to 40/);
    assert.match(batchBuyProblem('rung', choice({ depth: 41 }), terms) ?? '', /17 to 40/);
    assert.match(batchBuyProblem('catalogue', choice({ depth: 17, immutable: true }), terms) ?? '', /18 to 40/);
    assert.match(batchBuyProblem('catalogue', choice({ immutable: false }), terms) ?? '', /immutable/);
  });

  it('is too few days, a price that was not read, and a price that moved', () => {
    assert.match(batchBuyProblem('rung', choice({ days: 1 }), terms) ?? '', /2 days or more/);
    assert.match(batchBuyProblem('rung', choice(), { ...terms, postage: null }) ?? '', /could not be read/);
    const moved = { ...terms, postage: { ...postage, pricePerChunkPerBlockPlur: '25000' } };
    assert.match(batchBuyProblem('rung', choice(), moved) ?? '', /price of postage moved/);
  });

  it('is a wallet short of the cost, with the amount, and one with no xDAI for the gas', () => {
    const short = (BigInt(cost) - 7n).toString();
    assert.match(batchBuyProblem('rung', choice(), { ...terms, walletXbzzPlur: short }) ?? '', /is 7 PLUR short/);
    assert.match(batchBuyProblem('rung', choice(), { ...terms, walletXdaiWei: '0' }) ?? '', /no xDAI/);
  });
});

describe("a stage's line", () => {
  it('has a sentence for every state the manager names', () => {
    for (const apply of FUNDING_PURCHASE_APPLY_STATES) assert.ok(BATCH_PURCHASE_APPLY_TEXT[apply].length > 0, apply);
    assert.equal(Object.keys(BATCH_PURCHASE_APPLY_TEXT).length, FUNDING_PURCHASE_APPLY_STATES.length);
  });

  it('offers Restart now only while it waits for a broadcast', () => {
    const offered = FUNDING_PURCHASE_APPLY_STATES.filter((apply) => batchPurchaseStageRestartable({ apply }));
    assert.deepEqual(offered, ['waiting_live', 'waiting_unknown']);
  });
});

describe('a purchase that holds its node', () => {
  const failed = { state: 'failed', canCheckAgain: true } as const;

  it('holds it while it is under way, whatever is known of its batch', () => {
    for (const state of ['buying', 'waiting_usable', 'restarting', 'moving'] as const) {
      assert.equal(batchPurchaseHoldsNode({ state, canCheckAgain: false }), true, state);
      assert.equal(batchPurchaseHoldsNode({ state, canCheckAgain: false, batchState: 'expired' }), true, state);
    }
  });

  it('holds it after it failed with its batch bought, while that batch has not run out', () => {
    assert.equal(batchPurchaseHoldsNode(failed), true);
    for (const batchState of ['pending', 'active', 'unknown', 'full'] as const) {
      assert.equal(batchPurchaseHoldsNode({ ...failed, batchState }), true, batchState);
      assert.equal(batchPurchaseOffersCheck({ ...failed, batchState }), true, batchState);
    }
  });

  it('lets go once the bought batch has no time left or its node holds it no more, and offers no check of it', () => {
    for (const batchState of ['expired', 'gone'] as const) {
      assert.equal(boughtBatchRanOut({ batchState }), true);
      assert.equal(batchPurchaseHoldsNode({ ...failed, batchState }), false, batchState);
      assert.equal(batchPurchaseOffersCheck({ ...failed, batchState }), false, batchState);
    }
    assert.equal(boughtBatchRanOut({}), false);
  });

  it('never holds it once it is done, or failed with nothing bought', () => {
    assert.equal(batchPurchaseHoldsNode({ state: 'done', canCheckAgain: false }), false);
    assert.equal(batchPurchaseHoldsNode({ state: 'failed', canCheckAgain: false }), false);
  });

  it('keeps Check again for a stage whose restart failed, whose batch is set', () => {
    assert.equal(batchPurchaseOffersCheck({ state: 'restarting', canCheckAgain: true, batchState: 'active' }), true);
    assert.equal(batchPurchaseOffersCheck({ state: 'restarting', canCheckAgain: false }), false);
  });
});
