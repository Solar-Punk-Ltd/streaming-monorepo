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
